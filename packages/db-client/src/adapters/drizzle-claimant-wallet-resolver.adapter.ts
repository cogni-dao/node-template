// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/adapters/drizzle-claimant-wallet-resolver`
 * Purpose: Read-only Postgres implementation of the ClaimantWalletResolver port — resolves an attribution claimant key to its earner's PAYOUT address for epoch distribution.
 * Scope: SELECT-only. `user_bindings` is read for the GitHub identity of a claimant key only; the payee comes from the payout config (`resolvePayoutAddresses`). Does NOT write, mint, or move tokens.
 * Invariants:
 * - RESOLVER_READ_ONLY: only SELECT statements; never inserts/updates a binding (no binding-write flow).
 * - RESOLVER_NULL_IS_UNRESOLVED: a claimant with no wallet resolves to `wallet: null` — never a synthesized address.
 * - AUTH_IS_NOT_PAYMENT: the wallet is the earner's explicit payout address (or its accepted beneficiary's), read only from `payout_addresses` / `payout_beneficiaries`. A sign-in wallet binding or `users.wallet_address` never pays, and the principal's kind never decides: no payout address means `wallet: null` (held).
 * - RESOLVER_GITHUB_VIA_BINDING: `identity:github:<externalId>` → user_id via user_bindings(provider='github', external_id), mirroring AttributionStore.resolveIdentities.
 * Side-effects: IO (database reads)
 * Links: https://cognidao.org/knowledge/node-template-identity-model, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/decentralized-user-identity.md, packages/aragon-osx/src/wallet-resolver.ts
 * @public
 */

import type {
  ClaimantWalletResolution,
  ClaimantWalletResolver,
} from "@cogni/aragon-osx";
import { userBindings } from "@cogni/db-schema/identity";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../client";
import { resolvePayoutAddresses } from "./payout-address";

const IDENTITY_PROVIDERS: ReadonlySet<string> = new Set(["github", "discord", "google"]);

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
 *  2. user_id → payout address as of `asOf` (the claim's cutoff): the earner's own
 *     payout address, or its accepted beneficiary's (`resolvePayoutAddresses`).
 */
export class DrizzleClaimantWalletResolver implements ClaimantWalletResolver {
  constructor(private readonly db: Database) {}

  async resolveWallets(
    claimantKeys: readonly string[],
    asOf: Date = new Date()
  ): Promise<readonly ClaimantWalletResolution[]> {
    const parsed = [...new Set(claimantKeys)].map(parseClaimantKey);

    // Step 1: resolve identity claimants → user_id via user_bindings.
    const identityClaimants = parsed.filter(
      (p): p is ParsedClaimant & { provider: string; externalId: string } =>
        // Only the account providers say who a claimant is; a sign-in wallet never does (AUTH_IS_NOT_PAYMENT).
        p.provider !== null &&
        IDENTITY_PROVIDERS.has(p.provider) &&
        p.externalId !== null
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

    // Step 2: resolve user_id → payout address (AUTH_IS_NOT_PAYMENT).
    const walletByUserId = await resolvePayoutAddresses(this.db, userIds, asOf);

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
}
