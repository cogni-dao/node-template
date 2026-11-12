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
 *   - AUTHORITY_LOCK_ORDER: admission -> service -> user advisory -> principal -> enrollment -> credentials -> roles. All writers coordinate.
 *   - NO_SELF_APPROVAL: the only role row written here is a pending ask (`approved_by` null) made through the grants store.
 *   - DB_CLOCK: expiry, the poll interval and key lifetimes read `clock_timestamp()`; the app clock is never read.
 *   - CONFIRMED_CODE_STAYS_SPENT: the linked credential's confirmation consumes its code even after that credential is revoked or expires.
 *   - RETAINED_IDENTITY: identity, service marking, consent and replay evidence survive expiry; only active working sets consume slots.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import {
  assertCredentialPolicy,
  lockServiceAuthority,
  lockUserAuthority,
} from "../authority-lock";
import type { CredentialSql } from "../credentials/postgres";
import type { SqlTag } from "../postgres";
import { createPostgresAgentGrantsStore } from "../postgres";
import { MAX_PENDING_PER_AGENT, MAX_PENDING_TOTAL } from "../roles";
import {
  type ServiceEnrollmentCnfJwk,
  serviceEnrollmentCnfJwk,
} from "./claims";
import { createDurableProviderStore, type DurableProviderOptions } from "./durable-provider";
import { maintenanceTick } from "./maintenance";
import { assertEnrollmentMaintenance } from "./backlog";
import type {
  CreateEnrollmentRefusal,
  CreateEnrollmentResult,
  EnrollmentStore,
  PollOutcome,
} from "./types";

export interface PostgresEnrollmentStoreOptions extends DurableProviderOptions {
  /** @deprecated Ignored: identity and service marking are retained permanently. */
  readonly unredeemedPrincipalSec?: number;
}

const iso = (value: unknown): string => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** A refusal found inside the transaction: thrown so the whole transaction rolls back, caught outside it. */
class Refusal extends Error {
  constructor(readonly reason: CreateEnrollmentRefusal) {
    super(reason);
  }
}

const SWEEP_BATCH = 20;

export function createPostgresEnrollmentStore(
  client: CredentialSql,
  options: PostgresEnrollmentStoreOptions = {}
): EnrollmentStore {
  // Retained compatibility option; identity destruction is no longer permitted.
  void options;
  // Cached per store instance, success only (same rule as the credential store).
  let bypassVerified: Promise<void> | undefined;
  const assertBypassRls = (): Promise<void> => {
    bypassVerified ??= (async () => {
      const rows =
        await client`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
      if (rows[0]?.bypass !== true)
        throw new Error("enrollment store role lacks BYPASSRLS");
    })().catch((error) => {
      bypassVerified = undefined;
      throw error;
    });
    return bypassVerified;
  };

  const insertEnrollment = async (
    tx: SqlTag,
    input: Parameters<EnrollmentStore["createEnrollment"]>[0],
    principalUserId: string
  ): Promise<string> => {
    const { claims } = input;
    const rows = await tx`
      INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
      SELECT ${claims.jti}, ${claims.iss}, ${claims.service}, ${principalUserId}, ${input.scope}, ${input.deviceCodeHash},
        ${JSON.stringify(claims.cnf.jwk)}, clock_timestamp() + (${input.limits.deviceCodeSec}::int * interval '1 second')
      WHERE to_timestamp(${claims.exp}) > clock_timestamp()
      RETURNING id`;
    if (rows.length === 0) throw new Refusal("invalid_token");
    return text(rows[0]?.id);
  };

  const store: EnrollmentStore = {
    async createEnrollment(input): Promise<CreateEnrollmentResult> {
      await assertBypassRls();
      const limits = input.limits;
      if (
        !Number.isSafeInteger(limits.deviceCodeSec) ||
        limits.deviceCodeSec <= 0 ||
        limits.deviceCodeSec > 86400 ||
        !Number.isSafeInteger(limits.openEnrollments) ||
        limits.openEnrollments < 1 ||
        limits.openEnrollments > 5 ||
        !Number.isSafeInteger(limits.enrolledAgents) ||
        limits.enrolledAgents < 1 ||
        limits.enrolledAgents > 25
      )
        throw new Error("enrollment limits exceed accepted bounds");
      await maintenanceTick(client);
      try {
        return await client.begin(async (tx): Promise<CreateEnrollmentResult> => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('agent_service_enrollments'))`;
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`service:${input.serviceKey}`}))`;
          await assertEnrollmentMaintenance(tx);
          const valid = await tx`SELECT to_timestamp(${input.claims.exp}) > clock_timestamp() AS valid`;
          if (valid[0]?.valid !== true) throw new Refusal("invalid_token");
          const seen = await tx`SELECT 1 AS used FROM agent_service_enrollments WHERE jti = ${input.claims.jti}`;
          if (seen.length > 0) return { ok: false, reason: "replayed_token" };
          const candidate = await tx`SELECT user_id FROM agent_principals WHERE service_key = ${input.serviceKey}`;
          if (typeof candidate[0]?.user_id === "string") await lockUserAuthority(tx, candidate[0].user_id);
          const existing = await tx`SELECT user_id FROM agent_principals WHERE service_key = ${input.serviceKey}`;
          const existingId = typeof existing[0]?.user_id === "string" ? existing[0].user_id : null;
          // Enrollments of this same principal do not count: this request replaces them.
          const open = await tx`
            SELECT count(*)::int AS n FROM (
              SELECT 1 FROM agent_service_enrollments WHERE status = 'open' AND expires_at > clock_timestamp() AND principal_user_id <> ${existingId ?? ""}
              LIMIT ${input.limits.openEnrollments}
            ) active`;
            if (Number(open[0]?.n ?? 0) >= input.limits.openEnrollments)
              return { ok: false, reason: "too_many_enrollments" };

            // Active identities consume slots; expired operations/keys and retained consent do not.
            const active = await tx`SELECT count(*)::int AS n FROM (
            SELECT 1 FROM agent_principals WHERE service_key IS NOT NULL AND active_until > clock_timestamp()
              AND user_id <> ${existingId ?? ""} LIMIT ${input.limits.enrolledAgents}
          ) active`;
            if (Number(active[0]?.n ?? 0) >= input.limits.enrolledAgents)
              return { ok: false, reason: "too_many_agents" };
            let principalUserId: string;
            if (existingId === null) {
              const retained = await tx`SELECT count(*)::int AS n FROM (
              SELECT 1 FROM agent_principals WHERE service_key IS NOT NULL LIMIT 250
            ) retained`;
              if (Number(retained[0]?.n ?? 0) >= 250)
                return { ok: false, reason: "too_many_agents" };
              const user =
                await tx`INSERT INTO users (id, name) VALUES (gen_random_uuid()::text, ${input.principalName}) RETURNING id`;
              principalUserId = text(user[0]?.id);
              await lockUserAuthority(tx, principalUserId);
              await tx`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', ${input.serviceKey}, ${principalUserId})`;
            } else {
              principalUserId = existingId;
              const working = await tx`SELECT count(*)::int AS n FROM (
              SELECT 1 FROM agent_service_enrollments WHERE principal_user_id = ${principalUserId} AND status = 'open' LIMIT ${SWEEP_BATCH + 1}
            ) bounded`;
            if (Number(working[0]?.n ?? 0) > SWEEP_BATCH) throw new Error("enrollment working set exceeds bound");
            // A new receipt replaces only unconfirmed codes. Current consent and all identity/audit facts survive.
            const replaced = await tx`
              WITH batch AS (
                SELECT id FROM agent_service_enrollments WHERE principal_user_id = ${principalUserId} AND status = 'open'
                ORDER BY id LIMIT ${SWEEP_BATCH} FOR UPDATE
              ) UPDATE agent_service_enrollments e SET status = 'expired', terminal_at = clock_timestamp()
                FROM batch WHERE e.id = batch.id RETURNING e.credential_id`;
            const pendingIds = replaced.flatMap((e) => typeof e.credential_id === "string" ? [e.credential_id] : []).sort();
            if (pendingIds.length > 0) {
              await tx`SELECT id FROM agent_credentials WHERE id = ANY(${pendingIds}::uuid[]) ORDER BY id FOR UPDATE`;
              await tx`UPDATE agent_credentials SET revoked_at = clock_timestamp(), revoked_reason = 'superseded'
                WHERE id = ANY(${pendingIds}::uuid[]) AND confirmed_at IS NULL AND revoked_at IS NULL`;
            }
          }

          const ask = await createPostgresAgentGrantsStore(tx).requestRole({
            principalUserId,
            scope: input.scope,
            maxPending: MAX_PENDING_PER_AGENT,
            maxPendingTotal: MAX_PENDING_TOTAL,
          });
          if (ask === "node_full" || ask === "too_many") throw new Refusal("node_full");
          const enrollmentId = await insertEnrollment(tx, input, principalUserId);
          await tx`UPDATE agent_roles SET request_expires_at = e.expires_at FROM agent_service_enrollments e
            WHERE e.id = ${enrollmentId} AND agent_roles.principal_user_id = ${principalUserId}
              AND agent_roles.scope = ${input.scope} AND agent_roles.approved_by IS NULL AND agent_roles.revoked_at IS NULL`;
            return {
              ok: true,
              principalUserId,
              enrollmentId,
              principalCreated: existingId === null,
            };
          }
        );
      } catch (error) {
        if (error instanceof Refusal)
          return { ok: false, reason: error.reason };
        // A concurrent duplicate `jti` that slipped past the lock still hits the unique index: that is a replay, not an outage.
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505" &&
          String(
            (error as { constraint_name?: unknown }).constraint_name ?? ""
          ).includes("jti")
        )
          return { ok: false, reason: "replayed_token" };
        throw error;
      }
    },

    async poll({
      deviceCodeHash,
      tokenHash,
      policy,
      intervalSec,
    }): Promise<PollOutcome> {
      await assertBypassRls();
      assertCredentialPolicy(policy);
      const outcome = await client.begin(
        async (tx): Promise<PollOutcome & { lapsed?: true }> => {
          const owner =
            await tx`SELECT principal_user_id FROM agent_service_enrollments WHERE device_code_hash = ${deviceCodeHash}`;
          if (typeof owner[0]?.principal_user_id !== "string")
            return { state: "expired_token" };
          await lockServiceAuthority(tx, owner[0].principal_user_id);
          const rows = await tx`
          SELECT e.id, e.status, e.principal_user_id, e.scope, e.cnf_jwk, e.credential_id, e.historical_confirmed_at,
                 (e.expires_at <= clock_timestamp()) AS lapsed,
                 (e.last_polled_at IS NOT NULL AND e.last_polled_at > clock_timestamp() - (${intervalSec}::int * interval '1 second')) AS too_fast
          FROM agent_service_enrollments e WHERE e.device_code_hash = ${deviceCodeHash} FOR UPDATE`;
          const e = rows[0];
          if (!e) return { state: "expired_token" };
          const id = text(e.id);
          const principalUserId = text(e.principal_user_id);
          const scope = text(e.scope);
          if (e.historical_confirmed_at != null)
            return { state: "expired_token" };
          if (e.status === "denied") return { state: "access_denied" };
          if (e.status !== "open") return { state: "expired_token" };
          if (e.lapsed === true) {
            await tx`UPDATE agent_service_enrollments SET status = 'expired', terminal_at = clock_timestamp() WHERE id = ${id}`;
            // The ask leaves the admin's list with the code.
            await tx`
            UPDATE agent_roles SET revoked_at = clock_timestamp(), closed_reason = 'enrollment_expired'
            WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL`;
            return { state: "expired_token", lapsed: true as const };
          }
          if (e.too_fast === true) return { state: "slow_down" };
          await tx`UPDATE agent_service_enrollments SET last_polled_at = clock_timestamp() WHERE id = ${id}`;

          const role = await tx`
          SELECT approved_by, revoked_at FROM agent_roles
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope}
          ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`;
          const row = role[0];
          if (!row) {
            await tx`UPDATE agent_service_enrollments SET status = 'denied', terminal_at = clock_timestamp() WHERE id = ${id}`;
            return { state: "access_denied" };
          }
          const approved =
            row.approved_by !== null && row.approved_by !== undefined;
          const revoked =
            row.revoked_at !== null && row.revoked_at !== undefined;
          if (!approved && !revoked) return { state: "authorization_pending" };
          if (revoked) {
            // Off pauses an approved operation; On may resume within its original deadline.
            if (approved) return { state: "access_denied" };
            await tx`UPDATE agent_service_enrollments SET status = 'denied', terminal_at = clock_timestamp() WHERE id = ${id}`;
            return { state: "access_denied" };
          }

          // The admin said yes. Read the linked key's historical confirmation, not its current validity: revocation/expiry must never reopen
          // this code. The credential lock serializes with confirm/revoke; a poll winning before confirm still supersedes only a pending key.
          const previousId =
            typeof e.credential_id === "string" ? e.credential_id : null;
          if (previousId) {
            const prev =
              await tx`SELECT (c.confirmed_at IS NOT NULL) AS ever_confirmed FROM agent_credentials c WHERE c.id = ${previousId} FOR UPDATE`;
            if (prev[0]?.ever_confirmed === true) {
              await tx`UPDATE agent_service_enrollments SET status = 'redeemed', historical_confirmed_at = COALESCE(historical_confirmed_at, clock_timestamp()), terminal_at = clock_timestamp() WHERE id = ${id}`;
              return { state: "expired_token" };
            }
            await tx`UPDATE agent_credentials SET revoked_at = clock_timestamp(), revoked_reason = 'superseded' WHERE id = ${previousId} AND revoked_at IS NULL AND confirmed_at IS NULL`;
          }
          const key = await tx`
          WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
          INSERT INTO agent_credentials (user_id, token_hash, created_from, predecessor_id, issued_at, expires_at, renew_until, pending_expires_at)
          SELECT ${principalUserId}, ${tokenHash}, 'service_enrollment', NULL, instant.at,
            instant.at + (${policy.ttlSec}::int * interval '1 second'),
            instant.at + ((${policy.ttlSec}::int + ${policy.renewWindowSec}::int) * interval '1 second'),
            LEAST(instant.at + (${policy.pendingSec}::int * interval '1 second'), expires_at)
          FROM agent_service_enrollments CROSS JOIN instant WHERE id = ${id} AND status = 'open' AND expires_at > clock_timestamp()
          RETURNING id, pending_expires_at`;
          if (key.length === 0) return { state: "expired_token" };
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
        }
      );
      const { lapsed, ...result } = outcome;
      void lapsed;
      return result as PollOutcome;
    },
  };
  return { ...store, ...createDurableProviderStore(client, options) };
}
