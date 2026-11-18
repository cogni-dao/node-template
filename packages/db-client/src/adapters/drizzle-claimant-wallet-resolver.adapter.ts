// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/adapters/drizzle-claimant-wallet-resolver`
 * Purpose: Read-only Postgres implementation of the ClaimantWalletResolver port — resolves an attribution claimant key to the CONTRIBUTOR's own EVM wallet for epoch distribution.
 * Scope: SELECT-only over `user_bindings` and `users`; implements the @cogni/aragon-osx port. Does NOT write bindings, mint, or move tokens.
 * Invariants:
 * - RESOLVER_READ_ONLY: only SELECT statements; never inserts/updates a binding (no binding-write flow).
 * - RESOLVER_NULL_IS_UNRESOLVED: a claimant with no wallet resolves to `wallet: null` — never a synthesized address.
 * - AGENT_WALLET_IS_NOT_A_PAYEE: a wallet an `agent_principals` user owns (a `wallet` binding or `users.wallet_address`, matched by lowercase address) never resolves, for the agent or for any other user who presents the same address; the claimant stays `wallet: null`. An AI can prove a wallet (so it can be an admin) but is never paid to it.
 * - RESOLVER_CONTRIBUTOR_WALLET: resolves the person's OWN wallet (user_bindings provider='wallet' only; `users.wallet_address` is display and decides nothing); never an operator/treasury wallet.
 * - RESOLVER_GITHUB_VIA_BINDING: `identity:github:<externalId>` → user_id via user_bindings(provider='github', external_id), mirroring AttributionStore.resolveIdentities.
 * Side-effects: IO (database reads)
 * Links: https://cognidao.org/knowledge/node-template-identity-model, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/decentralized-user-identity.md, packages/aragon-osx/src/wallet-resolver.ts
 * @public
 */

import type {
  ClaimantWalletResolution,
  ClaimantWalletResolver,
  HexAddress,
} from "@cogni/aragon-osx";
import { agentPrincipals } from "@cogni/db-schema/agent-authority";
import { userBindings } from "@cogni/db-schema/identity";
import { users } from "@cogni/db-schema/refs";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client";

interface ParsedClaimant {
  readonly claimantKey: string;
  /** Direct user_id for `user:<id>`; null for identity claimants needing a binding lookup. */
  readonly userId: string | null;
  /** Provider for `identity:<provider>:<externalId>`; null for user claimants. */
  readonly provider: string | null;
  /** External id for `identity:<provider>:<externalId>`; null for user claimants. */
  readonly externalId: string | null;
}

/**
 * Parse a claimant key into its resolution shape.
 * - `user:<id>`                       → { userId }
 * - `identity:<provider>:<externalId>`→ { provider, externalId }
 * Unknown shapes resolve to all-null (treated as unresolved).
 */
function parseClaimantKey(claimantKey: string): ParsedClaimant {
  if (claimantKey.startsWith("user:")) {
    return {
      claimantKey,
      userId: claimantKey.slice("user:".length),
      provider: null,
      externalId: null,
    };
  }
  if (claimantKey.startsWith("identity:")) {
    const rest = claimantKey.slice("identity:".length);
    const colon = rest.indexOf(":");
    if (colon > 0) {
      return {
        claimantKey,
        userId: null,
        provider: rest.slice(0, colon),
        externalId: rest.slice(colon + 1),
      };
    }
  }
  return { claimantKey, userId: null, provider: null, externalId: null };
}

/**
 * Drizzle ClaimantWalletResolver. Uses a service-role (BYPASSRLS) Database since
 * the resolver runs in the finalize/distribution path with no per-user session.
 *
 * Resolution chain:
 *  1. claimant key → user_id (direct for `user:<id>`; via user_bindings for
 *     `identity:<provider>:<externalId>` — same join AttributionStore.resolveIdentities uses).
 *  2. user_id → EVM wallet: prefer the `wallet` binding in user_bindings
 *     (provider='wallet', external_id=address); never users.wallet_address
 *     (display only; legacy rows were backfilled into bindings and lowercased).
 */
export class DrizzleClaimantWalletResolver implements ClaimantWalletResolver {
  constructor(private readonly db: Database) {}

  async resolveWallets(
    claimantKeys: readonly string[]
  ): Promise<readonly ClaimantWalletResolution[]> {
    const parsed = [...new Set(claimantKeys)].map(parseClaimantKey);

    // Step 1: resolve identity claimants → user_id via user_bindings.
    const identityClaimants = parsed.filter(
      (p): p is ParsedClaimant & { provider: string; externalId: string } =>
        p.provider !== null && p.externalId !== null
    );
    const identityUserIdByKey =
      await this.resolveIdentityUserIds(identityClaimants);

    // Collect every user_id we need a wallet for.
    const userIdByClaimant = new Map<string, string | null>();
    for (const p of parsed) {
      if (p.userId !== null) {
        userIdByClaimant.set(p.claimantKey, p.userId);
      } else if (p.provider !== null) {
        userIdByClaimant.set(
          p.claimantKey,
          identityUserIdByKey.get(p.claimantKey) ?? null
        );
      } else {
        userIdByClaimant.set(p.claimantKey, null);
      }
    }

    const userIds = [
      ...new Set(
        [...userIdByClaimant.values()].filter((id): id is string => id !== null)
      ),
    ];

    // Step 2: resolve user_id → wallet.
    const walletByUserId = await this.resolveWalletsByUserId(userIds);

    return parsed.map((p) => {
      const userId = userIdByClaimant.get(p.claimantKey) ?? null;
      const wallet = userId ? (walletByUserId.get(userId) ?? null) : null;
      return {
        claimantKey: p.claimantKey,
        userId,
        wallet,
      } satisfies ClaimantWalletResolution;
    });
  }

  /** Resolve `identity:<provider>:<externalId>` claimants → user_id, grouped per provider. */
  private async resolveIdentityUserIds(
    identityClaimants: ReadonlyArray<{
      claimantKey: string;
      provider: string;
      externalId: string;
    }>
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (identityClaimants.length === 0) return result;

    // Group external ids per provider for batched queries.
    const idsByProvider = new Map<string, Set<string>>();
    for (const c of identityClaimants) {
      const set = idsByProvider.get(c.provider) ?? new Set<string>();
      set.add(c.externalId);
      idsByProvider.set(c.provider, set);
    }

    // provider → (external_id → user_id)
    const userIdByProviderExt = new Map<string, string>();
    for (const [provider, ids] of idsByProvider) {
      const rows = await this.db
        .select({
          externalId: userBindings.externalId,
          userId: userBindings.userId,
        })
        .from(userBindings)
        .where(
          and(
            eq(userBindings.provider, provider),
            inArray(userBindings.externalId, [...ids])
          )
        );
      for (const row of rows) {
        userIdByProviderExt.set(`${provider}:${row.externalId}`, row.userId);
      }
    }

    for (const c of identityClaimants) {
      const userId = userIdByProviderExt.get(`${c.provider}:${c.externalId}`);
      if (userId) result.set(c.claimantKey, userId);
    }
    return result;
  }

  /** Resolve user_id → EVM wallet (user_bindings 'wallet' binding). */
  private async resolveWalletsByUserId(
    userIds: readonly string[]
  ): Promise<Map<string, HexAddress>> {
    const result = new Map<string, HexAddress>();
    if (userIds.length === 0) return result;

    // Primary: explicit wallet bindings.
    const walletBindings = await this.db
      .select({
        userId: userBindings.userId,
        externalId: userBindings.externalId,
      })
      .from(userBindings)
      .where(
        and(
          eq(userBindings.provider, "wallet"),
          inArray(userBindings.userId, [...userIds])
        )
      );
    for (const row of walletBindings) {
      const addr = toHexAddress(row.externalId);
      if (addr && !result.has(row.userId)) {
        result.set(row.userId, addr);
      }
    }

    // `users.wallet_address` is display: it never resolves a payee. Legacy rows were backfilled into user_bindings (0011) and lowercased (0043).

    return this.withoutAgentWallets(result);
  }

  /**
   * AGENT_WALLET_IS_NOT_A_PAYEE: drop every resolved wallet an agent principal owns, matched by lowercase address. Matching the address (not just the
   * user) also covers a human whose login row carries the same address as an agent's binding.
   */
  private async withoutAgentWallets(
    resolved: Map<string, HexAddress>
  ): Promise<Map<string, HexAddress>> {
    const addresses = [
      ...new Set([...resolved.values()].map((a) => a.toLowerCase())),
    ];
    if (addresses.length === 0) return resolved;

    const bound = await this.db
      .select({ address: sql<string>`lower(${userBindings.externalId})` })
      .from(userBindings)
      .innerJoin(agentPrincipals, eq(agentPrincipals.userId, userBindings.userId))
      .where(
        and(
          eq(userBindings.provider, "wallet"),
          inArray(sql`lower(${userBindings.externalId})`, addresses)
        )
      );
    const primary = await this.db
      .select({ address: sql<string>`lower(${users.walletAddress})` })
      .from(users)
      .innerJoin(agentPrincipals, eq(agentPrincipals.userId, users.id))
      .where(inArray(sql`lower(${users.walletAddress})`, addresses));
    const agentOwned = new Set([...bound, ...primary].map((row) => row.address));

    for (const [userId, addr] of resolved) {
      if (agentOwned.has(addr.toLowerCase())) resolved.delete(userId);
    }
    return resolved;
  }
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Validate a stored address as a 20-byte hex EVM address and return it as a
 * HexAddress. Returns null when malformed. Casing is preserved as stored (the
 * SIWE flow writes EIP-55 checksummed addresses); downstream
 * `buildDaoTokenMerkleDistribution` re-validates and compares case-insensitively.
 */
function toHexAddress(value: string | null): HexAddress | null {
  if (!value) return null;
  if (!EVM_ADDRESS_RE.test(value)) return null;
  return value as HexAddress;
}
