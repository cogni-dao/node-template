// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` spawn-grant Postgres store
 * Purpose: `SpawnStore` over an injected postgres.js-style client, against `agent_spawn_grants`, `agent_principals` and `agent_credentials`.
 * Scope: Raw SQL. The package never creates a client, switches a role or runs a schema (the node owns the migration).
 * Invariants:
 *   - SERVICE_ROLE_ONLY: `agent_spawn_grants` has FORCE RLS and no policy; `agent_principals` is writable only by a BYPASSRLS connection.
 *     Every call first verifies the role bypasses RLS (`createBypassRlsAssertion`), so a wrong role is 503, never a silent "no grants".
 *   - ATOMIC_REDEEM: the grant row is locked `FOR UPDATE`; the user, the owned principal, the pending key and the redeemed mark commit together
 *     or not at all. A second redeem waits on the lock and then sees the result.
 *   - DATABASE_CLOCK: expiry and the pending cap read `now()`, never the app clock.
 *   - ISSUE_SERIALIZES_PER_PERSON: an advisory lock on the issuer makes the cap check and the insert one decision.
 * Side-effects: IO
 * @public
 */

import type { SqlTag } from "../postgres";
import { createBypassRlsAssertion, type CredentialSql, insertPendingCredential } from "./postgres";
import type { ClaimView, CompleteClaimResult, GrantState, OwnedAgent, RedeemResult, SpawnStore, StartClaimResult } from "./spawn";
import { MAX_OWNED_AGENTS } from "./spawn";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Agents listed per person at most. */
const MAX_OWNED_ROWS = 100;

const KEY_STATES = new Set(["active", "pending", "expired", "revoked", "none"]);

export function createPostgresSpawnStore(client: CredentialSql): SpawnStore {
  const assertBypassRls = createBypassRlsAssertion(client);

  const pendingCount = async (tx: SqlTag, issuerUserId: string): Promise<number> => {
    const rows = await tx`
      SELECT count(*)::int AS n FROM agent_spawn_grants
      WHERE issuer_user_id = ${issuerUserId} AND redeemed_at IS NULL AND expires_at > now()`;
    return Number(rows[0]?.n ?? 0);
  };

  const store: SpawnStore = {
    issue: ({ issuerUserId, tokenHash, ttlSec, maxPending }) =>
      client.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`spawn:${issuerUserId}`}))`;
        const facts = await tx`
          SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = ${issuerUserId}) AS known,
                 EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = ${issuerUserId}) AS is_agent`;
        if (facts[0]?.known !== true) return { ok: false as const, reason: "unknown_user" as const };
        if (facts[0]?.is_agent === true) return { ok: false as const, reason: "agent_issuer" as const };
        const pending = await pendingCount(tx, issuerUserId);
        if (pending >= maxPending) return { ok: false as const, reason: "too_many_pending" as const };
        const rows = await tx`
          INSERT INTO agent_spawn_grants (issuer_user_id, token_hash, expires_at)
          VALUES (${issuerUserId}, ${tokenHash}, now() + (${ttlSec}::int * interval '1 second'))
          RETURNING expires_at`;
        return { ok: true as const, expiresAt: iso(rows[0]?.expires_at), pending: pending + 1 };
      }),

    async grantState(tokenHash): Promise<GrantState> {
      const rows = await client`
        SELECT g.expires_at > now() AS live, g.redeemed_user_id, u.name,
               (g.redeemed_user_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM agent_credentials c WHERE c.user_id = g.redeemed_user_id
                    AND (c.confirmed_at IS NOT NULL OR (c.revoked_at IS NOT NULL AND c.revoked_reason IS DISTINCT FROM 'superseded')))) AS unconfirmed
        FROM agent_spawn_grants g LEFT JOIN users u ON u.id = g.redeemed_user_id
        WHERE g.token_hash = ${tokenHash}`;
      const row = rows[0];
      if (!row) return { state: "unknown" };
      if (row.live !== true) return { state: "expired" };
      if (typeof row.redeemed_user_id !== "string") return { state: "open" };
      return {
        state: "redeemed",
        userId: row.redeemed_user_id,
        name: typeof row.name === "string" ? row.name : null,
        unconfirmed: row.unconfirmed === true,
      };
    },

    redeem: ({ tokenHash, name, newUserId, keyHash, policy }) =>
      client.begin(async (tx): Promise<RedeemResult> => {
        const grants = await tx`
          SELECT g.id, g.issuer_user_id, g.redeemed_user_id, g.expires_at > now() AS live
          FROM agent_spawn_grants g WHERE g.token_hash = ${tokenHash} FOR UPDATE`;
        const grant = grants[0];
        if (!grant) return { ok: false, reason: "unknown" };
        if (grant.live !== true) return { ok: false, reason: "expired" };
        const ownerUserId = text(grant.issuer_user_id);

        if (typeof grant.redeemed_user_id === "string") {
          // Idempotent retry: the same agent, never confirmed, no key ended by a revoke (REVOKE_IS_FINAL), same name. Everything else is a spent grant.
          const agentUserId = grant.redeemed_user_id;
          const agent = await tx`
            SELECT u.name,
                   EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id
                             AND (c.confirmed_at IS NOT NULL OR (c.revoked_at IS NOT NULL AND c.revoked_reason IS DISTINCT FROM 'superseded'))) AS confirmed
            FROM users u WHERE u.id = ${agentUserId}`;
          if (!agent[0] || agent[0].confirmed === true || agent[0].name !== name) return { ok: false, reason: "already_redeemed" };
          await tx`
            UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'superseded'
            WHERE user_id = ${agentUserId} AND created_from = 'spawn_grant' AND confirmed_at IS NULL AND revoked_at IS NULL`;
          const key = await insertPendingCredential(tx, { userId: agentUserId, tokenHash: keyHash, createdFrom: "spawn_grant", predecessorId: null, policy });
          return key.ok
            ? { ok: true, userId: agentUserId, ownerUserId, credentialId: key.credentialId, pendingExpiresAt: key.pendingExpiresAt, retry: true }
            : { ok: false, reason: "already_redeemed" };
        }

        // CAPPED: a person owns at most MAX_OWNED_AGENTS agents. The grant row lock above serializes one grant; the advisory lock serializes one person.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`owned:${ownerUserId}`}))`;
        const owned = await tx`SELECT count(*)::int AS n FROM agent_principals WHERE owner_user_id = ${ownerUserId} AND kind = 'external'`;
        if (Number(owned[0]?.n ?? 0) >= MAX_OWNED_AGENTS) return { ok: false, reason: "too_many_agents" };
        // The agent's `users` row carries only id and name (no wallet): AGENTS_HOLD_NO_WALLET.
        await tx`INSERT INTO users (id, name) VALUES (${newUserId}, ${name})`;
        await tx`INSERT INTO agent_principals (kind, user_id, owner_user_id) VALUES ('external', ${newUserId}, ${ownerUserId})`;
        const key = await insertPendingCredential(tx, { userId: newUserId, tokenHash: keyHash, createdFrom: "spawn_grant", predecessorId: null, policy });
        await tx`UPDATE agent_spawn_grants SET redeemed_at = now(), redeemed_user_id = ${newUserId} WHERE id = ${text(grant.id)}`;
        return key.ok
          ? { ok: true, userId: newUserId, ownerUserId, credentialId: key.credentialId, pendingExpiresAt: key.pendingExpiresAt, retry: false }
          : { ok: false, reason: "already_redeemed" };
      }),

    startClaim: ({ agentUserId, ttlSec }) =>
      client.begin(async (tx): Promise<StartClaimResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`claim:${agentUserId}`}))`;
        const facts = await tx`
          SELECT p.kind, p.owner_user_id,
                 (EXISTS (SELECT 1 FROM users u WHERE u.id = ${agentUserId} AND u.wallet_address IS NOT NULL)
                  OR EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = ${agentUserId} AND b.provider = 'wallet')) AS has_wallet
          FROM agent_principals p WHERE p.user_id = ${agentUserId}`;
        const fact = facts[0];
        if (!fact || fact.kind !== "external" || fact.has_wallet === true) return { ok: false, reason: "not_an_agent" };
        if (fact.owner_user_id !== null && fact.owner_user_id !== undefined) return { ok: false, reason: "already_owned" };
        // At most one live claim per agent: a new one ends the old.
        await tx`UPDATE agent_claims SET expires_at = now() WHERE agent_user_id = ${agentUserId} AND claimed_at IS NULL AND expires_at > now()`;
        const rows = await tx`
          INSERT INTO agent_claims (agent_user_id, expires_at)
          VALUES (${agentUserId}, now() + (${ttlSec}::int * interval '1 second'))
          RETURNING id, expires_at`;
        return { ok: true, claimId: text(rows[0]?.id), expiresAt: iso(rows[0]?.expires_at) };
      }),

    async getClaim(claimId): Promise<ClaimView | null> {
      if (!UUID.test(claimId)) return null;
      const rows = await client`
        SELECT c.id, c.claimed_at, c.expires_at, c.expires_at > now() AS live, u.name,
               (p.owner_user_id IS NOT NULL) AS owned
        FROM agent_claims c
        JOIN users u ON u.id = c.agent_user_id
        LEFT JOIN agent_principals p ON p.user_id = c.agent_user_id
        WHERE c.id = ${claimId}::uuid`;
      const row = rows[0];
      if (!row) return null;
      const claimed = row.claimed_at !== null && row.claimed_at !== undefined;
      return {
        claimId: text(row.id),
        agentName: typeof row.name === "string" ? row.name : null,
        state: claimed ? "claimed" : row.live !== true ? "expired" : row.owned === true ? "owned" : "open",
        expiresAt: iso(row.expires_at),
      };
    },

    completeClaim: ({ claimId, ownerUserId, maxOwned }) =>
      client.begin(async (tx): Promise<CompleteClaimResult> => {
        if (!UUID.test(claimId)) return { ok: false, reason: "unknown" };
        const claims = await tx`
          SELECT c.agent_user_id, c.claimed_at, c.expires_at > now() AS live
          FROM agent_claims c WHERE c.id = ${claimId}::uuid FOR UPDATE`;
        const claim = claims[0];
        if (!claim) return { ok: false, reason: "unknown" };
        if (claim.claimed_at !== null && claim.claimed_at !== undefined) return { ok: false, reason: "used" };
        if (claim.live !== true) return { ok: false, reason: "expired" };
        const agentUserId = text(claim.agent_user_id);
        // An agent is never an owner, and never its own.
        const asAgent = await tx`SELECT 1 AS ok FROM agent_principals WHERE user_id = ${ownerUserId}`;
        if (asAgent.length > 0 || ownerUserId === agentUserId) return { ok: false, reason: "owner_is_agent" };
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`owned:${ownerUserId}`}))`;
        const owned = await tx`SELECT count(*)::int AS n FROM agent_principals WHERE owner_user_id = ${ownerUserId} AND kind = 'external'`;
        if (Number(owned[0]?.n ?? 0) >= maxOwned) return { ok: false, reason: "too_many_agents" };
        // The ONE guarded write: the owner is set only where it is NULL, on this same principal.
        const set = await tx`
          UPDATE agent_principals SET owner_user_id = ${ownerUserId}
          WHERE user_id = ${agentUserId} AND owner_user_id IS NULL AND kind = 'external'
          RETURNING user_id`;
        if (set.length === 0) return { ok: false, reason: "already_owned" };
        await tx`UPDATE agent_claims SET claimed_at = now(), claimed_by = ${ownerUserId} WHERE id = ${claimId}::uuid`;
        return { ok: true, agentUserId };
      }),

    async listOwned(ownerUserId): Promise<OwnedAgent[]> {
      const rows = await client`
        SELECT p.user_id, u.name, p.created_at,
               COALESCE((
                 SELECT CASE
                   WHEN bool_or(s.st IN ('active', 'renew_only')) THEN 'active'
                   WHEN bool_or(s.st = 'pending') THEN 'pending'
                   WHEN bool_or(s.st IN ('expired', 'pending_expired')) THEN 'expired'
                   ELSE 'revoked' END
                 FROM (SELECT agent_credential_state(c) AS st FROM agent_credentials c WHERE c.user_id = p.user_id) s
               ), 'none') AS key_state
        FROM agent_principals p JOIN users u ON u.id = p.user_id
        WHERE p.owner_user_id = ${ownerUserId} AND p.kind = 'external'
        ORDER BY p.created_at DESC
        LIMIT ${MAX_OWNED_ROWS}`;
      return rows.map((row) => ({
        agentUserId: text(row.user_id),
        name: text(row.name),
        createdAt: iso(row.created_at),
        keyState: (KEY_STATES.has(text(row.key_state)) ? text(row.key_state) : "none") as OwnedAgent["keyState"],
      }));
    },

    async countPending(issuerUserId) {
      return pendingCount(client, issuerUserId);
    },

    async liveKeyIds({ ownerUserId, agentUserId }) {
      const owned = await client`
        SELECT 1 AS ok FROM agent_principals
        WHERE user_id = ${agentUserId} AND owner_user_id = ${ownerUserId} AND kind = 'external'`;
      if (owned.length === 0) return null;
      const rows = await client`SELECT id FROM agent_credentials WHERE user_id = ${agentUserId} AND revoked_at IS NULL`;
      return rows.map((row) => text(row.id));
    },
  };

  // Every call verifies the role first. A failure throws, so the service answers unavailable (503), never a refusal and never a silent pass.
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await assertBypassRls();
      return call(...args);
    };
  return {
    issue: guard(store.issue),
    grantState: guard(store.grantState),
    redeem: guard(store.redeem),
    startClaim: guard(store.startClaim),
    getClaim: guard(store.getClaim),
    completeClaim: guard(store.completeClaim),
    listOwned: guard(store.listOwned),
    countPending: guard(store.countPending),
    liveKeyIds: guard(store.liveKeyIds),
  };
}
