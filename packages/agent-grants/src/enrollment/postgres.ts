// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` Postgres store
 * Purpose: `EnrollmentStore` over an injected postgres.js-style client, against `agent_service_enrollments`, `agent_principals`, `agent_roles`
 *   and `agent_credentials`.
 * Scope: Raw SQL. The package never creates a client, switches a role or runs a schema (the node owns the migration; the template is
 *   `migrations/agent_service_enrollments.sql`).
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the four tables have FORCE RLS and no write policy; only a BYPASSRLS connection reads or writes them. Every call first
 *     verifies once per instance that the role bypasses RLS and otherwise throws, so a wrong role is 503, never a silent "no enrollment".
 *   - ONE_USE_TOKEN: `jti` is a unique column. A reused token inserts nothing.
 *   - ONE_WRITER_AT_A_TIME: enrollment creation takes one advisory lock, so the caps and the one-principal-per-service rule see one snapshot.
 *   - NO_SELF_APPROVAL: the only role row written here is a pending ask (`approved_by` null) made through the grants store.
 *   - DB_CLOCK: expiry, the poll interval and key lifetimes read `now()`; the app clock is never read.
 *   - UNREDEEMED_PRINCIPALS_GO: a principal made by enrollment that never got a key, holds no approved permission and has no open enrollment
 *     is deleted 24 hours after it was made (best effort, swept on enrollment requests and on a lapsed poll).
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { CredentialSql } from "../credentials/postgres";
import type { SqlTag } from "../postgres";
import { createPostgresAgentGrantsStore } from "../postgres";
import { MAX_PENDING_PER_AGENT, MAX_PENDING_TOTAL } from "../roles";
import { type ServiceEnrollmentCnfJwk, serviceEnrollmentCnfJwk } from "./claims";
import type { CreateEnrollmentRefusal, CreateEnrollmentResult, EnrollmentStore, PollOutcome } from "./types";

export interface PostgresEnrollmentStoreOptions {
  /** How long an unredeemed enrollment principal lives before the sweep removes it, in seconds. Default 24 hours. */
  readonly unredeemedPrincipalSec?: number;
}

const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A refusal found inside the transaction: thrown so the whole transaction rolls back, caught outside it. */
class Refusal extends Error {
  constructor(readonly reason: CreateEnrollmentRefusal) {
    super(reason);
  }
}

const SWEEP_BATCH = 20;

export function createPostgresEnrollmentStore(client: CredentialSql, options: PostgresEnrollmentStoreOptions = {}): EnrollmentStore {
  const unredeemedSec = options.unredeemedPrincipalSec ?? 24 * 3600;
  // Cached per store instance, success only (same rule as the credential store).
  let bypassVerified: Promise<void> | undefined;
  const assertBypassRls = (): Promise<void> => {
    bypassVerified ??= (async () => {
      const rows = await client`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
      if (rows[0]?.bypass !== true) throw new Error("enrollment store role lacks BYPASSRLS");
    })().catch((error) => {
      bypassVerified = undefined;
      throw error;
    });
    return bypassVerified;
  };

  /** Removes principals that never earned a key. Best effort: a failure here never blocks an enrollment or a poll. */
  const sweepUnredeemed = async (): Promise<void> => {
    try {
      await client.begin(async (tx) => {
        const stale = await tx`
          SELECT p.user_id FROM agent_principals p
          WHERE p.service_key IS NOT NULL
            AND p.created_at < now() - (${unredeemedSec}::int * interval '1 second')
            AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.user_id = p.user_id)
            AND NOT EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = p.user_id AND r.approved_by IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM agent_service_enrollments e WHERE e.principal_user_id = p.user_id AND e.status = 'open' AND e.expires_at > now())
          LIMIT ${SWEEP_BATCH}`;
        const ids = stale.flatMap((row) => (typeof row.user_id === "string" ? [row.user_id] : []));
        if (ids.length === 0) return;
        await tx`DELETE FROM agent_service_enrollments WHERE principal_user_id = ANY(${ids}::text[])`;
        await tx`DELETE FROM agent_roles WHERE principal_user_id = ANY(${ids}::text[]) OR requested_by = ANY(${ids}::text[])`;
        await tx`DELETE FROM agent_principals WHERE user_id = ANY(${ids}::text[])`;
        await tx`DELETE FROM users WHERE id = ANY(${ids}::text[])`;
      });
    } catch {
      // Swept again on the next call.
    }
  };

  const insertEnrollment = async (tx: SqlTag, input: Parameters<EnrollmentStore["createEnrollment"]>[0], principalUserId: string): Promise<string> => {
    const { claims } = input;
    const rows = await tx`
      INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
      VALUES (${claims.jti}, ${claims.iss}, ${claims.service}, ${principalUserId}, ${input.scope}, ${input.deviceCodeHash},
        ${JSON.stringify(claims.cnf.jwk)}, now() + (${input.limits.deviceCodeSec}::int * interval '1 second'))
      RETURNING id`;
    return text(rows[0]?.id);
  };

  const store: EnrollmentStore = {
    async createEnrollment(input): Promise<CreateEnrollmentResult> {
      await assertBypassRls();
      await sweepUnredeemed();
      try {
        return await client.begin(async (tx): Promise<CreateEnrollmentResult> => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('agent_service_enrollments'))`;
          const seen = await tx`SELECT 1 AS used FROM agent_service_enrollments WHERE jti = ${input.claims.jti}`;
          if (seen.length > 0) return { ok: false, reason: "replayed_token" };
          // Lapsed codes end; a code whose key was confirmed is redeemed (the holder stored the key and never polls again).
          await tx`UPDATE agent_service_enrollments SET status = 'expired' WHERE status = 'open' AND expires_at <= now()`;
          await tx`
            UPDATE agent_service_enrollments e SET status = 'redeemed'
            WHERE e.status = 'open' AND EXISTS (SELECT 1 FROM agent_credentials c WHERE c.id = e.credential_id AND c.confirmed_at IS NOT NULL)`;
          const existing = await tx`SELECT user_id FROM agent_principals WHERE service_key = ${input.serviceKey}`;
          const existingId = typeof existing[0]?.user_id === "string" ? existing[0].user_id : null;
          // Enrollments of this same principal do not count: this request replaces them.
          const open = await tx`
            SELECT count(*)::int AS n FROM agent_service_enrollments WHERE status = 'open' AND principal_user_id <> ${existingId ?? ""}`;
          if (Number(open[0]?.n ?? 0) >= input.limits.openEnrollments) return { ok: false, reason: "too_many_enrollments" };

          let principalUserId: string;
          if (existingId === null) {
            const agents = await tx`SELECT count(*)::int AS n FROM agent_principals WHERE service_key IS NOT NULL`;
            if (Number(agents[0]?.n ?? 0) >= input.limits.enrolledAgents) return { ok: false, reason: "too_many_agents" };
            const user = await tx`INSERT INTO users (id, name) VALUES (gen_random_uuid()::text, ${input.principalName}) RETURNING id`;
            principalUserId = text(user[0]?.id);
            await tx`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', ${input.serviceKey}, ${principalUserId})`;
          } else {
            principalUserId = existingId;
            // A second enrollment turns the permission off (a live row, or a still-pending ask) and expires the older codes. The new ask below is
            // what the admin sees; the older keys die only when the new key is confirmed (trigger `agent_credentials_enrollment_confirm_siblings`).
            await tx`
              UPDATE agent_roles SET revoked_at = now()
              WHERE principal_user_id = ${principalUserId} AND scope = ${input.scope} AND revoked_at IS NULL`;
            await tx`UPDATE agent_service_enrollments SET status = 'expired' WHERE principal_user_id = ${principalUserId} AND status = 'open'`;
          }

          const ask = await createPostgresAgentGrantsStore(tx).requestRole({
            principalUserId,
            scope: input.scope,
            maxPending: MAX_PENDING_PER_AGENT,
            maxPendingTotal: MAX_PENDING_TOTAL,
          });
          if (ask === "node_full" || ask === "too_many") throw new Refusal("node_full");
          const enrollmentId = await insertEnrollment(tx, input, principalUserId);
          return { ok: true, principalUserId, enrollmentId, principalCreated: existingId === null };
        });
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, reason: error.reason };
        // A concurrent duplicate `jti` that slipped past the lock still hits the unique index: that is a replay, not an outage.
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505" && String((error as { constraint_name?: unknown }).constraint_name ?? "").includes("jti"))
          return { ok: false, reason: "replayed_token" };
        throw error;
      }
    },

    async poll({ deviceCodeHash, tokenHash, policy, intervalSec }): Promise<PollOutcome> {
      await assertBypassRls();
      const outcome = await client.begin(async (tx): Promise<PollOutcome & { lapsed?: true }> => {
        const rows = await tx`
          SELECT e.id, e.status, e.principal_user_id, e.scope, e.cnf_jwk, e.credential_id,
                 (e.expires_at <= now()) AS lapsed,
                 (e.last_polled_at IS NOT NULL AND e.last_polled_at > now() - (${intervalSec}::int * interval '1 second')) AS too_fast
          FROM agent_service_enrollments e WHERE e.device_code_hash = ${deviceCodeHash} FOR UPDATE`;
        const e = rows[0];
        if (!e) return { state: "expired_token" };
        const id = text(e.id);
        const principalUserId = text(e.principal_user_id);
        const scope = text(e.scope);
        if (e.status === "denied") return { state: "access_denied" };
        if (e.status !== "open") return { state: "expired_token" };
        if (e.lapsed === true) {
          await tx`UPDATE agent_service_enrollments SET status = 'expired' WHERE id = ${id}`;
          // The ask leaves the admin's list with the code.
          await tx`
            UPDATE agent_roles SET revoked_at = now()
            WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL`;
          return { state: "expired_token", lapsed: true as const };
        }
        if (e.too_fast === true) return { state: "slow_down" };
        await tx`UPDATE agent_service_enrollments SET last_polled_at = now() WHERE id = ${id}`;

        const role = await tx`
          SELECT approved_by, revoked_at FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          ORDER BY created_at DESC LIMIT 1`;
        const row = role[0];
        if (!row) {
          await tx`UPDATE agent_service_enrollments SET status = 'denied' WHERE id = ${id}`;
          return { state: "access_denied" };
        }
        const approved = row.approved_by !== null && row.approved_by !== undefined;
        const revoked = row.revoked_at !== null && row.revoked_at !== undefined;
        if (!approved && !revoked) return { state: "authorization_pending" };
        if (revoked) {
          // Dismissed (never approved) or switched off before the key was handed over.
          await tx`UPDATE agent_service_enrollments SET status = 'denied' WHERE id = ${id}`;
          return { state: "access_denied" };
        }

        // The admin said yes. A key already confirmed ends the code; an unconfirmed key is replaced.
        const previousId = typeof e.credential_id === "string" ? e.credential_id : null;
        if (previousId) {
          const prev = await tx`SELECT agent_credential_state(c) AS state FROM agent_credentials c WHERE c.id = ${previousId} FOR UPDATE`;
          const state = prev[0]?.state;
          if (state === "active" || state === "renew_only") {
            await tx`UPDATE agent_service_enrollments SET status = 'redeemed' WHERE id = ${id}`;
            return { state: "expired_token" };
          }
          await tx`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'superseded' WHERE id = ${previousId} AND revoked_at IS NULL AND confirmed_at IS NULL`;
        }
        const key = await tx`
          INSERT INTO agent_credentials (user_id, token_hash, created_from, predecessor_id, expires_at, renew_until, pending_expires_at)
          VALUES (${principalUserId}, ${tokenHash}, 'service_enrollment', NULL,
            now() + (${policy.ttlSec}::int * interval '1 second'),
            now() + ((${policy.ttlSec}::int + ${policy.renewWindowSec}::int) * interval '1 second'),
            now() + (${policy.pendingSec}::int * interval '1 second'))
          RETURNING id, pending_expires_at`;
        const credentialId = text(key[0]?.id);
        await tx`UPDATE agent_service_enrollments SET credential_id = ${credentialId} WHERE id = ${id}`;
        let jwk: ServiceEnrollmentCnfJwk;
        try {
          jwk = serviceEnrollmentCnfJwk.parse(JSON.parse(text(e.cnf_jwk)));
        } catch {
          throw new Error("stored cnf key is unreadable");
        }
        return {
          state: "issued",
          enrollmentId: id,
          credentialId,
          userId: principalUserId,
          pendingExpiresAt: iso(key[0]?.pending_expires_at),
          cnfJwk: jwk,
        };
      });
      const { lapsed, ...result } = outcome;
      if (lapsed) await sweepUnredeemed();
      return result as PollOutcome;
    },
  };
  return store;
}
