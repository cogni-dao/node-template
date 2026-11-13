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
import type { GrantState, OwnedAgent, RedeemResult, SpawnStore } from "./spawn";

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
                  SELECT 1 FROM agent_credentials c WHERE c.user_id = g.redeemed_user_id AND c.confirmed_at IS NOT NULL)) AS unconfirmed
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
          // Idempotent retry: the same agent, never confirmed, same name. Everything else is a spent grant.
          const agentUserId = grant.redeemed_user_id;
          const agent = await tx`
            SELECT u.name,
                   EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id AND c.confirmed_at IS NOT NULL) AS confirmed
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

        // The agent's `users` row carries only id and name (no wallet): AGENTS_HOLD_NO_WALLET.
        await tx`INSERT INTO users (id, name) VALUES (${newUserId}, ${name})`;
        await tx`INSERT INTO agent_principals (kind, user_id, owner_user_id) VALUES ('external', ${newUserId}, ${ownerUserId})`;
        const key = await insertPendingCredential(tx, { userId: newUserId, tokenHash: keyHash, createdFrom: "spawn_grant", predecessorId: null, policy });
        await tx`UPDATE agent_spawn_grants SET redeemed_at = now(), redeemed_user_id = ${newUserId} WHERE id = ${text(grant.id)}`;
        return key.ok
          ? { ok: true, userId: newUserId, ownerUserId, credentialId: key.credentialId, pendingExpiresAt: key.pendingExpiresAt, retry: false }
          : { ok: false, reason: "already_redeemed" };
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
    listOwned: guard(store.listOwned),
    countPending: guard(store.countPending),
    liveKeyIds: guard(store.liveKeyIds),
  };
}
