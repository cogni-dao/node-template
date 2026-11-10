// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` Postgres store
 * Purpose: `CredentialStore` over an injected postgres.js-style client, against `agent_credentials`.
 * Scope: Raw SQL. The package never creates a client, switches a role or runs a schema (the node owns the migration;
 *   the template is `migrations/agent_credentials.sql`).
 * Invariants:
 *   - SERVICE_ROLE_ONLY: `agent_credentials` has FORCE RLS and no policy; only a BYPASSRLS connection reads or writes it.
 *   - STATE_IS_DERIVED: the SQL function `agent_credential_state(row)` is the one derivation, read against `now()`.
 *     The app clock is never read.
 *   - LOCK_ORDER: predecessor first, then successor, in rotate and confirm, so concurrent calls cannot deadlock.
 * Side-effects: IO
 * @public
 */

import type { SqlTag } from "../postgres";
import type { ConfirmResult, CredentialLookup, CredentialPolicy, CredentialState, CredentialStore, IssueResult } from "./types";

/** A postgres.js `Sql`: a tagged template that can also open a transaction. */
export interface CredentialSql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function createPostgresCredentialStore(client: CredentialSql): CredentialStore {
  const insertPending = async (
    tx: SqlTag,
    row: { userId: string; tokenHash: string; createdFrom: string; predecessorId: string | null; policy: CredentialPolicy }
  ): Promise<IssueResult> => {
    const { userId, tokenHash, createdFrom, predecessorId, policy: p } = row;
    const rows = await tx`
      INSERT INTO agent_credentials (user_id, token_hash, created_from, predecessor_id, expires_at, renew_until, pending_expires_at)
      VALUES (${userId}, ${tokenHash}, ${createdFrom}, ${predecessorId},
        now() + (${p.ttlSec}::int * interval '1 second'),
        now() + ((${p.ttlSec}::int + ${p.renewWindowSec}::int) * interval '1 second'),
        now() + (${p.pendingSec}::int * interval '1 second'))
      RETURNING id, pending_expires_at`;
    return { ok: true, credentialId: text(rows[0]?.id), userId, pendingExpiresAt: iso(rows[0]?.pending_expires_at) };
  };

  return {
    async lookup(tokenHash): Promise<CredentialLookup | null> {
      const rows = await client`
        SELECT c.id, c.user_id, u.name, c.expires_at, c.renew_until, agent_credential_state(c) AS state
        FROM agent_credentials c JOIN users u ON u.id = c.user_id
        WHERE c.token_hash = ${tokenHash}`;
      const row = rows[0];
      if (!row) return null;
      return {
        credentialId: text(row.id),
        userId: text(row.user_id),
        name: typeof row.name === "string" ? row.name : null,
        state: text(row.state) as CredentialState,
        expiresAt: iso(row.expires_at),
        renewUntil: iso(row.renew_until),
      };
    },

    issueUpgrade: ({ userId, tokenHash, policy }) =>
      client.begin(async (tx): Promise<IssueResult> => {
        // One upgrade at a time per user: the checks below and the insert must see one snapshot.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const facts = await tx`
          SELECT (u.wallet_address IS NOT NULL
                  OR EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wallet')) AS wallet,
                 (SELECT p.kind FROM agent_principals p WHERE p.user_id = u.id) AS kind,
                 EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = u.id
                           AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL) AS has_roles,
                 EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'github') AS bound,
                 EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id
                           AND agent_credential_state(c) IN ('active', 'renew_only')) AS upgraded
          FROM users u WHERE u.id = ${userId}`;
        const f = facts[0];
        if (!f) return { ok: false, reason: "unknown_user" };
        if (f.wallet) return { ok: false, reason: "wallet_user" };
        if (f.kind === "internal") return { ok: false, reason: "internal_principal" };
        if (f.upgraded) return { ok: false, reason: "already_upgraded" };
        // BINDING_BEFORE_UPGRADE: a principal with node roles and no proven GitHub binding could not recover its identity.
        if (f.has_roles && !f.bound) return { ok: false, reason: "binding_required" };
        await tx`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${userId}) ON CONFLICT (user_id) DO NOTHING`;
        await tx`
          UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'superseded'
          WHERE user_id = ${userId} AND created_from = 'legacy_upgrade' AND confirmed_at IS NULL AND revoked_at IS NULL`;
        return insertPending(tx, { userId, tokenHash, createdFrom: "legacy_upgrade", predecessorId: null, policy });
      }),

    issueSuccessor: ({ predecessorId, tokenHash, policy }) =>
      client.begin(async (tx): Promise<IssueResult> => {
        const pred = await tx`
          SELECT c.user_id, agent_credential_state(c) AS state FROM agent_credentials c WHERE c.id = ${predecessorId} FOR UPDATE`;
        const state = pred[0]?.state;
        if (state !== "active" && state !== "renew_only") return { ok: false, reason: "not_rotatable" };
        await tx`
          UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'superseded'
          WHERE predecessor_id = ${predecessorId} AND confirmed_at IS NULL AND revoked_at IS NULL`;
        return insertPending(tx, { userId: text(pred[0]?.user_id), tokenHash, createdFrom: "rotation", predecessorId, policy });
      }),

    confirm: ({ credentialId, policy: p }) =>
      client.begin(async (tx): Promise<ConfirmResult> => {
        // Predecessor first (same order as rotate), then the successor row.
        const link = await tx`SELECT predecessor_id FROM agent_credentials WHERE id = ${credentialId}`;
        const predecessorId = typeof link[0]?.predecessor_id === "string" ? link[0].predecessor_id : null;
        if (predecessorId) await tx`SELECT 1 FROM agent_credentials WHERE id = ${predecessorId} FOR UPDATE`;
        const rows = await tx`
          SELECT c.user_id, c.expires_at, c.renew_until, agent_credential_state(c) AS state
          FROM agent_credentials c WHERE c.id = ${credentialId} FOR UPDATE`;
        const row = rows[0];
        if (!row) return { ok: false, reason: "not_found" };
        const done = (status: "confirmed" | "already_active", r: Record<string, unknown>): ConfirmResult => ({
          ok: true,
          status,
          userId: text(row.user_id),
          expiresAt: iso(r.expires_at),
          renewUntil: iso(r.renew_until),
        });
        switch (row.state) {
          case "revoked":
            return { ok: false, reason: "revoked" };
          case "pending_expired":
          case "expired":
            return { ok: false, reason: "expired" };
          case "active":
          case "renew_only":
            return done("already_active", row);
          default: {
            if (predecessorId) {
              const pred = await tx`SELECT revoked_at FROM agent_credentials WHERE id = ${predecessorId}`;
              if (pred[0]?.revoked_at) return { ok: false, reason: "predecessor_revoked" };
            }
            const updated = await tx`
              UPDATE agent_credentials SET confirmed_at = now(),
                expires_at = now() + (${p.ttlSec}::int * interval '1 second'),
                renew_until = now() + ((${p.ttlSec}::int + ${p.renewWindowSec}::int) * interval '1 second')
              WHERE id = ${credentialId} RETURNING expires_at, renew_until`;
            if (predecessorId) {
              await tx`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'rotated'
                WHERE id = ${predecessorId} AND revoked_at IS NULL`;
            }
            return done("confirmed", updated[0] ?? {});
          }
        }
      }),

    revoke: ({ credentialId, userId, reason, revokedBy }) =>
      client.begin(async (tx) => {
        const revoked = await tx`
          UPDATE agent_credentials SET revoked_at = now(), revoked_reason = ${reason}, revoked_by = ${revokedBy}
          WHERE id = ${credentialId} AND user_id = ${userId} AND revoked_at IS NULL RETURNING id`;
        if (revoked.length === 0) return false;
        // A pending successor must not outlive the key that would have been replaced.
        await tx`
          UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'predecessor_revoked', revoked_by = ${revokedBy}
          WHERE predecessor_id = ${credentialId} AND confirmed_at IS NULL AND revoked_at IS NULL`;
        return true;
      }),
  };
}
