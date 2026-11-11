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
 *   - FAIL_CLOSED_ON_WRONG_ROLE: every store call first verifies, once per store instance, that the connection role bypasses RLS
 *     (`rolbypassrls` or superuser). Under FORCE RLS with no policy a role that does not bypass sees ZERO rows, so `everConfirmed` would read
 *     false and the v1 supersession gate would silently turn off. Instead every call throws, so the service answers unavailable (503).
 *   - ROLES_ARE_THE_NODES_READ: `hasRoles` is injected. The store never decides what a role is.
 *   - LOCK_ORDER: predecessor first, then successor, in rotate and confirm, so concurrent calls cannot deadlock. Bind, stop, lift, upgrade and
 *     the upgrade confirm take the per-user advisory lock first; recover locks its challenge row, then the user (a bind challenge and a
 *     recover challenge are different rows, so the orders cannot cycle).
 *   - STOP_IS_ONE_QUERY: `everConfirmed` reads `confirmed credential OR agent_stops row` in ONE statement, so the signed-key gate gains no read.
 *   - USER_BINDINGS_WRITTEN_WITH_EVIDENCE: a bind writes `user_bindings` and the `identity_events` row `bind` in one transaction (the app's Drizzle
 *     helper cannot be imported here; its invariants BINDINGS_ARE_EVIDENCED and NO_AUTO_MERGE are copied, not its code).
 * Side-effects: IO
 * @public
 */

import type { SqlTag } from "../postgres";
import type {
  ChallengeIssueResult,
  ConfirmResult,
  CredentialLookup,
  CredentialPolicy,
  CredentialState,
  CredentialStore,
  FinishBindResult,
  FinishRecoverResult,
  HasRoles,
  IssueResult,
  KeyHolder,
  LiftResult,
  OpenProofCheckResult,
  StopResult,
} from "./types";

/** A postgres.js `Sql`: a tagged template that can also open a transaction. */
export interface CredentialSql extends SqlTag {
  begin<T>(fn: (tx: SqlTag) => Promise<T>): Promise<T>;
}

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The `agent_roles` read (node-template): an approved, unrevoked role row. The operator injects its OpenFGA read instead. */
export const agentRolesHasRoles =
  (client: SqlTag): HasRoles =>
  async (userId) => {
    const rows = await client`
      SELECT EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = ${userId}
                       AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL) AS has_roles`;
    return rows[0]?.has_roles === true;
  };

export interface PostgresCredentialStoreOptions {
  /** How this node tells that a principal holds roles (BINDING_BEFORE_UPGRADE). Required: there is no safe default across nodes. */
  readonly hasRoles: HasRoles;
}

export function createPostgresCredentialStore(client: CredentialSql, options: PostgresCredentialStoreOptions): CredentialStore {
  const { hasRoles } = options;
  // Cached per store instance, success only: a wrong role keeps failing every call and is re-checked, never cached as fine.
  let bypassVerified: Promise<void> | undefined;
  const assertBypassRls = (): Promise<void> => {
    bypassVerified ??= (async () => {
      const rows = await client`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
      if (rows[0]?.bypass !== true) throw new Error("credential store role lacks BYPASSRLS");
    })().catch((error) => {
      bypassVerified = undefined;
      throw error;
    });
    return bypassVerified;
  };
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

  const store: CredentialStore = {
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

    async everConfirmed(userId) {
      // One statement: a confirmed credential (revoked or not) OR a stop row (stopped or lifted) kills the user's signed keys for good.
      const rows = await client`
        SELECT 1 AS ok FROM agent_credentials WHERE user_id = ${userId} AND confirmed_at IS NOT NULL
        UNION ALL
        SELECT 1 AS ok FROM agent_stops WHERE user_id = ${userId}
        LIMIT 1`;
      return rows.length > 0;
    },

    issueUpgrade: async ({ userId, tokenHash, policy }) => {
      // The role read is the node's (possibly a network call), so it runs before the transaction. Roles approved after this read are
      // caught again at confirm.
      const roles = await hasRoles(userId);
      return client.begin(async (tx): Promise<IssueResult> => {
        // One upgrade at a time per user: the checks below and the insert must see one snapshot.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const facts = await tx`
          SELECT (u.wallet_address IS NOT NULL
                  OR EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wallet')) AS wallet,
                 (SELECT p.kind FROM agent_principals p WHERE p.user_id = u.id) AS kind,
                 EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'github') AS bound,
                 EXISTS (SELECT 1 FROM agent_stops s WHERE s.user_id = u.id AND s.lifted_at IS NULL) AS stopped,
                 EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id
                           AND agent_credential_state(c) IN ('active', 'renew_only')) AS upgraded
          FROM users u WHERE u.id = ${userId}`;
        const f = facts[0];
        if (!f) return { ok: false, reason: "unknown_user" };
        if (f.wallet) return { ok: false, reason: "wallet_user" };
        if (f.kind === "internal") return { ok: false, reason: "internal_principal" };
        if (f.stopped) return { ok: false, reason: "stopped" };
        if (f.upgraded) return { ok: false, reason: "already_upgraded" };
        // BINDING_BEFORE_UPGRADE: a principal with node roles and no proven GitHub binding could not recover its identity.
        if (roles && !f.bound) return { ok: false, reason: "binding_required" };
        await tx`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${userId}) ON CONFLICT (user_id) DO NOTHING`;
        await tx`
          UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'superseded'
          WHERE user_id = ${userId} AND created_from = 'key_upgrade' AND confirmed_at IS NULL AND revoked_at IS NULL`;
        return insertPending(tx, { userId, tokenHash, createdFrom: "key_upgrade", predecessorId: null, policy });
      });
    },

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

    confirm: async ({ credentialId, policy: p }) => {
      // BINDING_BEFORE_UPGRADE at confirm: read the node's roles for an UPGRADE key before the transaction (an upgrade key has no predecessor).
      const head = await client`SELECT user_id, created_from FROM agent_credentials WHERE id = ${credentialId}`;
      const rolesNow = head[0]?.created_from === "key_upgrade" && typeof head[0]?.user_id === "string" ? await hasRoles(head[0].user_id) : false;
      return client.begin(async (tx): Promise<ConfirmResult> => {
        // Predecessor first (same order as rotate), then the successor row. An upgrade key has no predecessor: it takes the same
        // per-user advisory lock as `issueUpgrade`, so a confirm cannot interleave with a new upgrade (two live revocable keys).
        const link = await tx`SELECT predecessor_id, user_id FROM agent_credentials WHERE id = ${credentialId}`;
        const predecessorId = typeof link[0]?.predecessor_id === "string" ? link[0].predecessor_id : null;
        if (predecessorId) await tx`SELECT 1 FROM agent_credentials WHERE id = ${predecessorId} FOR UPDATE`;
        else if (typeof link[0]?.user_id === "string") await tx`SELECT pg_advisory_xact_lock(hashtext(${link[0].user_id}))`;
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
            const stopped = await tx`SELECT 1 FROM agent_stops WHERE user_id = ${text(row.user_id)} AND lifted_at IS NULL`;
            if (stopped.length > 0) return { ok: false, reason: "stopped" };
            if (rolesNow) {
              const bound = await tx`SELECT 1 FROM user_bindings WHERE user_id = ${text(row.user_id)} AND provider = 'github' LIMIT 1`;
              if (bound.length === 0) return { ok: false, reason: "binding_required" };
            }
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
      });
    },

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

    createChallenge: ({ challengeId, purpose, principalUserId, nonceHash, secretHash, policy: p }) =>
      client.begin(async (tx): Promise<ChallengeIssueResult> => {
        // Expired rows are pruned at issue. A row fetched in the last hour expires after the cut, so the budget count below never loses one.
        await tx`DELETE FROM agent_proof_challenges WHERE expires_at < now() - interval '1 hour'`;
        if (purpose === "bind") {
          const userId = principalUserId as string;
          await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
          const u = await tx`
            SELECT EXISTS (SELECT 1 FROM agent_stops s WHERE s.user_id = u.id AND s.lifted_at IS NULL) AS stopped
            FROM users u WHERE u.id = ${userId}`;
          if (!u[0]) return { ok: false, reason: "unknown_user" };
          if (u[0].stopped) return { ok: false, reason: "stopped" };
          const n = await tx`
            SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now() AND attempts < ${p.maxFailedChecks}::int)::int AS open,
                   count(*) FILTER (WHERE issued_at > now() - interval '1 hour')::int AS hourly
            FROM agent_proof_challenges WHERE principal_user_id = ${userId} AND purpose = 'bind'`;
          if (Number(n[0]?.open ?? 0) >= p.bindOpenPerPrincipal || Number(n[0]?.hourly ?? 0) >= p.bindPerHourPerPrincipal) {
            return { ok: false, reason: "rate_limited" };
          }
        } else {
          // Anonymous: one node-wide lock, so the counts below and the insert see one snapshot on every instance.
          await tx`SELECT pg_advisory_xact_lock(hashtext('agent_proof_challenges:recover'))`;
          const n = await tx`
            SELECT count(*) FILTER (WHERE purpose = 'recover' AND issued_at > now() - interval '1 hour')::int AS hourly,
                   count(*) FILTER (WHERE consumed_at IS NULL AND expires_at > now() AND attempts < ${p.maxFailedChecks}::int)::int AS open
            FROM agent_proof_challenges`;
          if (Number(n[0]?.hourly ?? 0) >= p.recoverPerHourNode || Number(n[0]?.open ?? 0) >= p.maxOpenChallenges) {
            return { ok: false, reason: "rate_limited" };
          }
        }
        const rows = await tx`
          INSERT INTO agent_proof_challenges (id, purpose, nonce_hash, secret_hash, principal_user_id, expires_at)
          VALUES (${challengeId}::uuid, ${purpose}, ${nonceHash}, ${secretHash}, ${principalUserId}::text,
                  now() + (${p.challengeTtlSec}::int * interval '1 second'))
          RETURNING issued_at, expires_at`;
        return { ok: true, challengeId, issuedAt: iso(rows[0]?.issued_at), expiresAt: iso(rows[0]?.expires_at) };
      }),

    openProofCheck: ({ challengeId, secretHash, purpose, principalUserId, policy: p }) =>
      client.begin(async (tx): Promise<OpenProofCheckResult> => {
        // One node-wide lock for the budget: the count and the stamp below must not interleave across instances.
        await tx`SELECT pg_advisory_xact_lock(hashtext('agent_proof_challenges:fetch'))`;
        const ch = await tx`
          SELECT issued_at, expires_at, nonce_hash FROM agent_proof_challenges
          WHERE id = ${challengeId}::uuid AND purpose = ${purpose} AND secret_hash = ${secretHash}
            AND consumed_at IS NULL AND expires_at > now() AND attempts < ${p.maxFailedChecks}::int
            AND principal_user_id IS NOT DISTINCT FROM ${principalUserId}::text
          FOR UPDATE`;
        if (!ch[0]) return { ok: false, reason: "invalid_challenge" }; // a wrong secret changes nothing: no attempt, no budget
        const used = await tx`SELECT count(*)::int AS n FROM agent_proof_challenges WHERE fetched_at > now() - interval '1 hour'`;
        if (Number(used[0]?.n ?? 0) >= p.fetchBudgetPerHour) return { ok: false, reason: "fetch_budget" };
        await tx`UPDATE agent_proof_challenges SET fetched_at = now() WHERE id = ${challengeId}::uuid`;
        return { ok: true, issuedAt: iso(ch[0].issued_at), expiresAt: iso(ch[0].expires_at), nonceHash: text(ch[0].nonce_hash) };
      }),

    async recordProofFailure({ challengeId }) {
      const rows = await client`
        UPDATE agent_proof_challenges SET attempts = attempts + 1
        WHERE id = ${challengeId}::uuid AND consumed_at IS NULL RETURNING attempts`;
      return { attempts: Number(rows[0]?.attempts ?? 0) };
    },

    finishBind: ({ challengeId, secretHash, principalUserId: userId, evidence, policy: p }) =>
      client.begin(async (tx): Promise<FinishBindResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const ch = await tx`
          SELECT 1 FROM agent_proof_challenges
          WHERE id = ${challengeId}::uuid AND purpose = 'bind' AND principal_user_id = ${userId} AND secret_hash = ${secretHash}
            AND consumed_at IS NULL AND expires_at > now() AND attempts < ${p.maxFailedChecks}::int
          FOR UPDATE`;
        if (ch.length === 0) return { ok: false, reason: "invalid_challenge" };
        const facts = await tx`
          SELECT (u.wallet_address IS NOT NULL
                  OR EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wallet')) AS wallet,
                 (SELECT ap.kind FROM agent_principals ap WHERE ap.user_id = u.id) AS kind,
                 EXISTS (SELECT 1 FROM agent_stops s WHERE s.user_id = u.id AND s.lifted_at IS NULL) AS stopped
          FROM users u WHERE u.id = ${userId}`;
        const f = facts[0];
        if (!f || f.wallet || f.kind === "internal") return { ok: false, reason: "not_agent" };
        if (f.stopped) return { ok: false, reason: "stopped" };
        const consume = () => tx`UPDATE agent_proof_challenges SET consumed_at = now() WHERE id = ${challengeId}::uuid`;
        const ensurePrincipal = () =>
          tx`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${userId}) ON CONFLICT (user_id) DO NOTHING`;
        // One GitHub binding per agent principal: a key holder cannot add a second account to a bound agent.
        const mine = await tx`SELECT external_id FROM user_bindings WHERE user_id = ${userId} AND provider = 'github'`;
        if (mine.length > 0) {
          if (mine.some((r) => r.external_id === evidence.githubId)) {
            await ensurePrincipal();
            await consume();
            return { ok: true, result: "already_bound" };
          }
          return { ok: false, reason: "binding_exists" };
        }
        // NO_AUTO_MERGE: the id belongs to another user -> no insert, 409. Never re-pointed.
        const inserted = await tx`
          INSERT INTO user_bindings (id, user_id, provider, external_id, provider_login)
          VALUES (gen_random_uuid()::text, ${userId}, 'github', ${evidence.githubId}, ${evidence.login})
          ON CONFLICT (provider, external_id) DO NOTHING RETURNING id`;
        if (inserted.length === 0) return { ok: false, reason: "already_linked" };
        await ensurePrincipal();
        // BINDINGS_ARE_EVIDENCED: the proof lives in the event, in the same transaction.
        const payload = JSON.stringify({
          provider: "github",
          external_id: evidence.githubId,
          method: "github_comment_proof",
          comment_id: evidence.commentId,
          issue: evidence.issue,
          user_type: evidence.userType,
        });
        await tx`
          INSERT INTO identity_events (id, user_id, event_type, payload)
          VALUES (gen_random_uuid()::text, ${userId}, 'bind', ${payload}::text::jsonb)`;
        await consume();
        return { ok: true, result: "created" };
      }),

    finishRecover: ({ challengeId, secretHash, githubId, tokenHash, policy: p }) =>
      client.begin(async (tx): Promise<FinishRecoverResult> => {
        const ch = await tx`
          SELECT 1 FROM agent_proof_challenges
          WHERE id = ${challengeId}::uuid AND purpose = 'recover' AND secret_hash = ${secretHash}
            AND consumed_at IS NULL AND expires_at > now() AND attempts < ${p.maxFailedChecks}::int
          FOR UPDATE`;
        if (ch.length === 0) return { ok: false, reason: "invalid_challenge" };
        // Only an EXTERNAL agent principal recovers: a GitHub-only human (no agent row) and a wallet user get the same uniform answer.
        const found = await tx`
          SELECT b.user_id FROM user_bindings b
          JOIN agent_principals ap ON ap.user_id = b.user_id AND ap.kind = 'external'
          JOIN users u ON u.id = b.user_id
          WHERE b.provider = 'github' AND b.external_id = ${githubId} AND u.wallet_address IS NULL`;
        const userId = typeof found[0]?.user_id === "string" ? found[0].user_id : null;
        if (!userId) return { ok: false, reason: "no_binding" };
        await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
        const stopped = await tx`SELECT 1 FROM agent_stops WHERE user_id = ${userId} AND lifted_at IS NULL`;
        if (stopped.length > 0) return { ok: false, reason: "stopped" }; // nothing changes, the challenge is not consumed
        const recent = await tx`
          SELECT count(*)::int AS n FROM agent_credentials
          WHERE user_id = ${userId} AND created_from = 'binding_recovery' AND issued_at > now() - interval '24 hours'`;
        if (Number(recent[0]?.n ?? 0) >= p.recoveriesPerDay) return { ok: false, reason: "recovery_limited" };
        const revoked = await tx`
          UPDATE agent_credentials c SET revoked_at = now(), revoked_reason = 'recovered', revoked_by = ${userId}
          WHERE c.user_id = ${userId} AND c.revoked_at IS NULL AND agent_credential_state(c) IN ('pending', 'active', 'renew_only')
          RETURNING c.id`;
        const c = p.credential;
        const minted = await tx`
          INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until, confirmed_at)
          VALUES (${userId}, ${tokenHash}, 'binding_recovery',
            now() + (${c.ttlSec}::int * interval '1 second'),
            now() + ((${c.ttlSec}::int + ${c.renewWindowSec}::int) * interval '1 second'),
            now())
          RETURNING id, expires_at, renew_until`;
        await tx`UPDATE agent_proof_challenges SET consumed_at = now() WHERE id = ${challengeId}::uuid`;
        return {
          ok: true,
          userId,
          credentialId: text(minted[0]?.id),
          expiresAt: iso(minted[0]?.expires_at),
          renewUntil: iso(minted[0]?.renew_until),
          revokedCount: revoked.length,
        };
      }),

    revokeAllForPrincipal: ({ actorUserId, targetUserId }) =>
      client.begin(async (tx): Promise<StopResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${targetUserId}))`;
        const facts = await tx`
          SELECT (u.wallet_address IS NOT NULL
                  OR EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wallet')) AS wallet,
                 (SELECT ap.kind FROM agent_principals ap WHERE ap.user_id = u.id) AS kind
          FROM users u WHERE u.id = ${targetUserId}`;
        const f = facts[0];
        if (!f) return { ok: false, reason: "principal_not_found" };
        if (f.wallet || f.kind === "internal") return { ok: false, reason: "not_agent" };
        // The stop row, not a credential row: a signed-key agent has no principal row and the trigger refuses a credential for it.
        await tx`
          INSERT INTO agent_stops (user_id, stopped_by) VALUES (${targetUserId}, ${actorUserId})
          ON CONFLICT (user_id) DO UPDATE SET stopped_at = now(), stopped_by = excluded.stopped_by, lifted_at = NULL, lifted_by = NULL
          WHERE agent_stops.lifted_at IS NOT NULL`;
        const revoked = await tx`
          UPDATE agent_credentials c SET revoked_at = now(), revoked_reason = 'admin_revoked', revoked_by = ${actorUserId}
          WHERE c.user_id = ${targetUserId} AND c.revoked_at IS NULL AND agent_credential_state(c) IN ('pending', 'active', 'renew_only')
          RETURNING c.id`;
        return { ok: true, revokedCount: revoked.length };
      }),

    liftStop: ({ actorUserId, targetUserId }) =>
      client.begin(async (tx): Promise<LiftResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${targetUserId}))`;
        // Sets `lifted_at` only: no key is minted or revived, no role is touched.
        const lifted = await tx`
          UPDATE agent_stops SET lifted_at = now(), lifted_by = ${actorUserId}
          WHERE user_id = ${targetUserId} AND lifted_at IS NULL RETURNING user_id`;
        if (lifted.length > 0) return { ok: true };
        const known = await tx`SELECT 1 FROM users WHERE id = ${targetUserId}`;
        return { ok: false, reason: known.length > 0 ? "not_stopped" : "principal_not_found" };
      }),

    async listKeyHolders(limit) {
      const rows = await client`
        SELECT * FROM (
          SELECT u.id AS user_id, u.name,
                 (SELECT b.external_id FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'github' LIMIT 1) AS github_id,
                 EXISTS (SELECT 1 FROM agent_stops s WHERE s.user_id = u.id AND s.lifted_at IS NULL) AS stopped,
                 EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id
                           AND agent_credential_state(c) IN ('active', 'renew_only')) AS live_key,
                 (EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = u.id AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = u.id AND c.confirmed_at IS NOT NULL)
                  AND NOT EXISTS (SELECT 1 FROM agent_stops s WHERE s.user_id = u.id)) AS signed_holder
          FROM users u
          WHERE u.wallet_address IS NULL
            AND NOT EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = u.id AND b.provider = 'wallet')
            AND NOT EXISTS (SELECT 1 FROM agent_principals p WHERE p.user_id = u.id AND p.kind = 'internal')
        ) h
        WHERE h.stopped OR h.live_key OR h.signed_holder
        ORDER BY h.stopped DESC, h.name NULLS LAST, h.user_id
        LIMIT ${limit + 1}`;
      const holders: KeyHolder[] = rows.slice(0, limit).map((r) => ({
        userId: text(r.user_id),
        name: typeof r.name === "string" ? r.name : null,
        githubId: typeof r.github_id === "string" ? r.github_id : null,
        on: r.stopped !== true,
      }));
      return { holders, more: Math.max(0, rows.length - limit) };
    },
  };

  // Every call verifies the role first. A failure throws, so `verifyBearer` answers unavailable and the service functions throw
  // `CredentialStoreUnavailableError`: 503, never 401, never a silent pass.
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await assertBypassRls();
      return call(...args);
    };
  return {
    lookup: guard(store.lookup),
    issueUpgrade: guard(store.issueUpgrade),
    issueSuccessor: guard(store.issueSuccessor),
    confirm: guard(store.confirm),
    everConfirmed: guard(store.everConfirmed),
    revoke: guard(store.revoke),
    createChallenge: guard(store.createChallenge),
    openProofCheck: guard(store.openProofCheck),
    recordProofFailure: guard(store.recordProofFailure),
    finishBind: guard(store.finishBind),
    finishRecover: guard(store.finishRecover),
    revokeAllForPrincipal: guard(store.revokeAllForPrincipal),
    liftStop: guard(store.liftStop),
    listKeyHolders: guard(store.listKeyHolders),
  };
}
