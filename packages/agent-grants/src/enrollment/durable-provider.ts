// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** V2 target transactions. All network verification precedes admission/service/user locks. */
import {
  assertCredentialPolicy,
  lockServiceAuthority,
  lockUserAuthority,
} from "../authority-lock";
import type { CredentialSql } from "../credentials/postgres";
import { hashAgentKey, mintKey } from "../credentials/service";
import {
  type CredentialPolicy,
  DEFAULT_CREDENTIAL_POLICY,
} from "../credentials/types";
import { createPostgresAgentGrantsStore, type SqlTag } from "../postgres";
import { MAX_PENDING_PER_AGENT, MAX_PENDING_TOTAL } from "../roles";
import {
  canonicalJson,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  type EnrollmentReply,
  fullServiceKey,
  intentOf,
} from "./protocol";
import { sealToJwk } from "./seal";

export type ProviderRefusal =
  | "invalid_token"
  | "intent_conflict"
  | "unknown_operation"
  | "terminal_operation"
  | "node_full";
export type ProviderResult =
  | {
      ok: true;
      reply: EnrollmentReply;
      principalUserId: string;
      enrollmentId: string;
      principalCreated: boolean;
      proofOp: "start" | "continue";
      service: string;
      issuer: string;
      scope: string;
    }
  | { ok: false; reason: ProviderRefusal; observedAt?: string };
export type StablePoll =
  | {
      ok: true;
      sealedKey: string;
      credentialId: string;
      userId: string;
      enrollmentId: string;
      pendingExpiresAt: string;
    }
  | {
      ok: false;
      error:
        | "authorization_pending"
        | "slow_down"
        | "permission_off"
        | "access_denied"
        | "expired_token";
    };
export interface DurableProviderStore {
  acceptProof(
    proof: EnrollmentProof,
    exactTokenDigest: string
  ): Promise<ProviderResult>;
  pollStable(codeHash: string, policy?: CredentialPolicy): Promise<StablePoll>;
}
const iso = (v: unknown): string => new Date(v as string).toISOString();
const str = (v: unknown): string => String(v);
class Refusal extends Error {
  constructor(readonly reason: ProviderRefusal) {
    super(reason);
  }
}
/** Admission lock is held for both counter subjects. Replays never call this writer. */
export async function chargeServiceQuota(
  tx: SqlTag,
  identity: string,
  kind: "accepted" | "issued"
): Promise<void> {
  for (const [subject, ceiling] of [
    ["target", 25],
    [identity, 5],
  ] as const) {
    const charged =
      await tx`INSERT INTO agent_service_quotas(subject, kind, hour, count)
      VALUES (${subject}, ${kind}, floor(extract(epoch FROM clock_timestamp()) / 3600)::bigint, 1)
      ON CONFLICT (subject, kind, hour) DO UPDATE SET count = agent_service_quotas.count + 1
      WHERE agent_service_quotas.count < ${ceiling} RETURNING count`;
    if (charged.length === 0) throw new Refusal("node_full");
  }
}
export function createDurableProviderStore(
  client: CredentialSql
): DurableProviderStore {
  let ready: Promise<void> | undefined;
  const guard = async () => {
    ready ??= (async () => {
      const r =
        await client`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
      if (r[0]?.bypass !== true)
        throw new Error("enrollment store requires BYPASSRLS");
    })().catch((e) => {
      ready = undefined;
      throw e;
    });
    await ready;
  };
  async function reply(
    tx: SqlTag,
    row: Record<string, unknown>,
    proof: EnrollmentProof,
    at: string
  ): Promise<ProviderResult> {
    const p =
      await tx`SELECT current_operation_id, current_generation FROM agent_principals WHERE user_id = ${row.principal_user_id}`;
    if (
      p[0]?.current_operation_id !== proof.operationId ||
      Number(p[0]?.current_generation) !== proof.generation
    )
      return { ok: false, reason: "terminal_operation", observedAt: at };
    const c = row.credential_id
      ? await tx`SELECT agent_credential_state(c) AS state, confirmed_at FROM agent_credentials c WHERE id = ${row.credential_id}`
      : [];
    const confirmed =
      row.historical_confirmed_at != null || c[0]?.confirmed_at != null;
    if (
      !confirmed &&
      (row.status !== "open" ||
        Date.parse(at) >= new Date(row.expires_at as string).getTime())
    )
      return { ok: false, reason: "terminal_operation", observedAt: at };
    return {
      ok: true,
      proofOp: proof.op,
      service: proof.service,
      issuer: proof.iss,
      scope: proof.scopes[0] ?? "",
      principalUserId: str(row.principal_user_id),
      enrollmentId: str(row.id),
      principalCreated: false,
      reply: {
        operationId: proof.operationId,
        generation: proof.generation,
        status: confirmed ? "confirmed" : "open",
        sealedAcceptance: !confirmed ? str(row.sealed_acceptance) : null,
        credentialId: row.credential_id ? str(row.credential_id) : null,
        credentialState:
          c[0]?.state === "pending_expired"
            ? "expired"
            : ((c[0]?.state ?? null) as EnrollmentReply["credentialState"]),
        observedAt: at,
      },
    };
  }
  return {
    async acceptProof(proof, exactTokenDigest) {
      await guard();
      const serviceKey = await fullServiceKey(proof.home, proof.service);
      try {
        return await client.begin(async (tx): Promise<ProviderResult> => {
          await tx`SELECT pg_advisory_xact_lock(hashtext('agent_service_enrollments'))`;
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`service:${serviceKey}`}))`;
          const clock = await tx`SELECT clock_timestamp() AS at`;
          const at = iso(clock[0]?.at),
            sec = Date.parse(at) / 1000;
          if (sec < proof.iat || sec >= proof.exp)
            return { ok: false, reason: "invalid_token", observedAt: at };
          const seen =
            await tx`SELECT * FROM agent_service_enrollments WHERE operation_id = ${proof.operationId}`;
          if (seen[0]) {
            if (
              seen[0].original_token_digest !==
                (proof.op === "start"
                  ? exactTokenDigest
                  : proof.originalTokenDigest) ||
              seen[0].intent_digest !== proof.intentDigest ||
              seen[0].canonical_intent !== canonicalJson(intentOf(proof))
            )
              return { ok: false, reason: "intent_conflict", observedAt: at };
            return reply(tx, seen[0], proof, at);
          }
          if (proof.op === "continue")
            return { ok: false, reason: "unknown_operation", observedAt: at };
          const pressure =
            await tx`SELECT 1 FROM agent_authority_maintenance WHERE id = 'service-enrollment' AND backfill_ready
            AND NOT EXISTS (SELECT 1 FROM (SELECT expires_at FROM agent_service_enrollments WHERE status = 'open' AND expires_at <= (SELECT clock_timestamp()) ORDER BY expires_at, id LIMIT 1) due WHERE expires_at < clock_timestamp() - interval '5 minutes')`;
          if (!pressure.length)
            throw new Error("maintenance unavailable or overdue");
          const candidates =
            await tx`SELECT user_id FROM agent_principals WHERE service_key = ${serviceKey}`;
          let userId = candidates[0]?.user_id
            ? str(candidates[0].user_id)
            : null;
          if (userId) await lockUserAuthority(tx, userId);
          const current = userId
            ? await tx`SELECT current_operation_id, current_generation FROM agent_principals WHERE user_id = ${userId}`
            : [];
          if (
            Number(current[0]?.current_generation ?? 0) !==
              proof.expectedGeneration ||
            (current[0]?.current_operation_id ?? null) !==
              proof.expectedOperationId
          )
            return { ok: false, reason: "intent_conflict", observedAt: at };
          if (proof.expectedOperationId) {
            const prior =
              await tx`SELECT status, expires_at, historical_confirmed_at FROM agent_service_enrollments WHERE operation_id = ${proof.expectedOperationId} FOR UPDATE`;
            // Explicit replacement only after its operation AND credential lineage cease to be usable.
            const active =
              await tx`SELECT 1 FROM agent_credentials WHERE user_id = ${userId} AND revoked_at IS NULL
              AND ((confirmed_at IS NOT NULL AND renew_until > clock_timestamp()) OR (confirmed_at IS NULL AND pending_expires_at > clock_timestamp())) LIMIT 1`;
            if (
              active.length ||
              (prior[0]?.status === "open" &&
                new Date(prior[0].expires_at as string).getTime() >
                  Date.parse(at))
            )
              return { ok: false, reason: "intent_conflict", observedAt: at };
          }
          const open =
            await tx`SELECT id FROM agent_service_enrollments WHERE status = 'open' AND expires_at > clock_timestamp() LIMIT 5`;
          const active =
            await tx`SELECT user_id FROM agent_principals WHERE service_key IS NOT NULL AND active_until > clock_timestamp()
            AND user_id <> ${userId ?? ""} LIMIT 25`;
          const retained = !userId
            ? await tx`SELECT user_id FROM agent_principals WHERE service_key IS NOT NULL LIMIT 250`
            : [];
          if (open.length >= 5 || active.length >= 25 || retained.length >= 250)
            throw new Refusal("node_full");
          await chargeServiceQuota(tx, serviceKey, "accepted");
          const principalCreated = !userId;
          if (!userId) {
            const u =
              await tx`INSERT INTO users(id, name) VALUES(gen_random_uuid()::text, ${`${proof.service}@${new URL(proof.home.origin).host}`}) RETURNING id`;
            userId = str(u[0]?.id);
            await lockUserAuthority(tx, userId);
            await tx`INSERT INTO agent_principals(kind, user_id, service_key, home_node_id, home_environment, home_origin, home_service)
              VALUES('external', ${userId}, ${serviceKey}, ${proof.home.nodeId}, ${proof.home.environment}, ${proof.home.origin}, ${proof.service})`;
          }
          const ask = await createPostgresAgentGrantsStore(tx).requestRole({
            principalUserId: userId,
            scope: proof.scopes[0] ?? "",
            maxPending: MAX_PENDING_PER_AGENT,
            maxPendingTotal: MAX_PENDING_TOTAL,
          });
          if (ask === "node_full" || ask === "too_many")
            throw new Refusal("node_full");
          // Seal while the transaction owns the decision; neither hash nor receipt can commit alone.
          const clock2 =
            await tx`SELECT clock_timestamp() AS at, gen_random_uuid() AS id`;
          const acceptedAt = iso(clock2[0]?.at),
            enrollmentId = str(clock2[0]?.id);
          if (Date.parse(acceptedAt) >= proof.exp * 1000)
            throw new Refusal("invalid_token");
          const recoveryExpiresAt = new Date(
            Date.parse(acceptedAt) + 86400000
          ).toISOString();
          const code = btoa(
            String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
          )
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
          const sealed = await sealToJwk(
            JSON.stringify({
              protocol: ENROLLMENT_PROTOCOL,
              operationId: proof.operationId,
              generation: proof.generation,
              intentDigest: proof.intentDigest,
              home: proof.home,
              target: proof.target,
              service: proof.service,
              scope: proof.scopes[0],
              enrollmentId,
              principalUserId: userId,
              deviceCode: code,
              acceptedAt,
              recoveryExpiresAt,
              interval: 5,
            }),
            proof.cnf.jwk
          );
          await tx`INSERT INTO agent_service_enrollments(id,jti,issuer,service,principal_user_id,scope,device_code_hash,cnf_jwk,expires_at,
            operation_id,generation,original_start_iat,original_start_exp,original_token_digest,intent_digest,canonical_intent,sealed_acceptance,created_at)
            SELECT ${enrollmentId},${proof.originalStartJti},${proof.iss},${proof.service},${userId},${proof.scopes[0]},${await hashAgentKey(code)},${JSON.stringify(proof.cnf.jwk)},${recoveryExpiresAt},
              ${proof.operationId},${proof.generation},to_timestamp(${proof.originalStartIat}),to_timestamp(${proof.originalStartExp}),${exactTokenDigest},${proof.intentDigest},${canonicalJson(intentOf(proof))},${sealed},${acceptedAt}
            WHERE clock_timestamp() < to_timestamp(${proof.exp}) RETURNING id`;
          // Verify final conditional insertion; a deadline crossed during sealing must roll back the whole admission.
          const inserted =
            await tx`SELECT * FROM agent_service_enrollments WHERE operation_id = ${proof.operationId}`;
          if (!inserted[0]) throw new Refusal("invalid_token");
          await tx`UPDATE agent_principals SET current_generation=${proof.generation}, current_operation_id=${proof.operationId}, active_until=${recoveryExpiresAt}
            WHERE user_id=${userId}`;
          await tx`UPDATE agent_roles SET request_expires_at=${recoveryExpiresAt}, enrollment_operation_id=${proof.operationId}
            WHERE principal_user_id=${userId} AND scope=${proof.scopes[0]} AND approved_by IS NULL AND revoked_at IS NULL`;
          const answer = await reply(tx, inserted[0], proof, acceptedAt);
          return answer.ok ? { ...answer, principalCreated } : answer;
        });
      } catch (e) {
        if (e instanceof Refusal) return { ok: false, reason: e.reason };
        throw e;
      }
    },
    async pollStable(codeHash, policy = DEFAULT_CREDENTIAL_POLICY) {
      await guard();
      assertCredentialPolicy(policy);
      try {
        return await client.begin(async (tx): Promise<StablePoll> => {
          const owner =
            await tx`SELECT principal_user_id FROM agent_service_enrollments WHERE device_code_hash=${codeHash} AND operation_id IS NOT NULL`;
          if (!owner[0]) return { ok: false, error: "expired_token" };
          await lockServiceAuthority(tx, str(owner[0].principal_user_id));
          const rows =
            await tx`SELECT e.*, p.current_operation_id, p.current_generation FROM agent_service_enrollments e
            JOIN agent_principals p ON p.user_id=e.principal_user_id WHERE e.device_code_hash=${codeHash} FOR UPDATE OF e`;
          const e = rows[0];
          if (
            !e ||
            e.operation_id !== e.current_operation_id ||
            Number(e.generation) !== Number(e.current_generation) ||
            e.historical_confirmed_at != null ||
            e.status !== "open"
          )
            return { ok: false, error: "expired_token" };
          const clock = await tx`SELECT clock_timestamp() AS at`;
          if (
            new Date(e.expires_at as string).getTime() <=
            new Date(clock[0]?.at as string).getTime()
          )
            return { ok: false, error: "expired_token" };
          const roles =
            await tx`SELECT approved_by,revoked_at FROM agent_roles WHERE principal_user_id=${e.principal_user_id} AND scope=${e.scope}
            ORDER BY created_at DESC, id DESC LIMIT 1`;
          const role = roles[0];
          if (!role || (role.revoked_at && !role.approved_by))
            return { ok: false, error: "access_denied" };
          if (role.revoked_at) return { ok: false, error: "permission_off" };
          if (!role.approved_by)
            return { ok: false, error: "authorization_pending" };
          if (e.credential_id) {
            const c =
              await tx`SELECT agent_credential_state(c) AS state,pending_expires_at FROM agent_credentials c WHERE id=${e.credential_id} FOR UPDATE`;
            if (c[0]?.state !== "pending" || !e.sealed_pending_key)
              return { ok: false, error: "expired_token" };
            return {
              ok: true,
              sealedKey: str(e.sealed_pending_key),
              credentialId: str(e.credential_id),
              userId: str(e.principal_user_id),
              enrollmentId: str(e.id),
              pendingExpiresAt: iso(c[0]?.pending_expires_at),
            };
          }
          const due =
            await tx`SELECT 1 FROM agent_service_enrollments WHERE id=${e.id} AND (last_polled_at IS NULL OR last_polled_at <= clock_timestamp()-interval '5 seconds')`;
          if (!due.length) return { ok: false, error: "slow_down" };
          const { token, tokenHash } = await mintKey();
          const c =
            await tx`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at)
            INSERT INTO agent_credentials(user_id,token_hash,created_from,service_operation_id,service_generation,issued_at,expires_at,renew_until,pending_expires_at)
            SELECT ${e.principal_user_id},${tokenHash},'service_enrollment',${e.operation_id},${e.generation},at,at+(${policy.ttlSec}::int*interval '1 second'),
              at+((${policy.ttlSec}::int+${policy.renewWindowSec}::int)*interval '1 second'),LEAST(at+(${policy.pendingSec}::int*interval '1 second'),${e.expires_at}::timestamptz)
            FROM instant WHERE at < ${e.expires_at}::timestamptz RETURNING *`;
          if (!c[0]) throw new Refusal("terminal_operation");
          const intent = JSON.parse(str(e.canonical_intent));
          const sealed = await sealToJwk(
            JSON.stringify({
              protocol: ENROLLMENT_PROTOCOL,
              operationId: e.operation_id,
              generation: Number(e.generation),
              intentDigest: e.intent_digest,
              home: intent.home,
              target: intent.target,
              service: e.service,
              scope: e.scope,
              enrollmentId: e.id,
              principalUserId: e.principal_user_id,
              credentialId: c[0].id,
              token,
              pendingExpiresAt: iso(c[0].pending_expires_at),
              expiresAt: iso(c[0].expires_at),
              renewUntil: iso(c[0].renew_until),
            }),
            intent.cnf.jwk
          );
          const written =
            await tx`UPDATE agent_service_enrollments SET credential_id=${c[0].id},sealed_pending_key=${sealed},pending_expires_at=${c[0].pending_expires_at},last_polled_at=clock_timestamp()
            WHERE id=${e.id} AND status='open' AND expires_at>clock_timestamp() AND ${c[0].pending_expires_at}::timestamptz>clock_timestamp() RETURNING id`;
          if (!written.length) throw new Refusal("terminal_operation");
          return {
            ok: true,
            sealedKey: sealed,
            credentialId: str(c[0].id),
            userId: str(e.principal_user_id),
            enrollmentId: str(e.id),
            pendingExpiresAt: iso(c[0].pending_expires_at),
          };
        });
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { constraint_name?: string }).constraint_name === "agent_service_issuance_quota") return { ok: false, error: "slow_down" };
        if (e instanceof Refusal)
          return {
            ok: false,
            error: e.reason === "node_full" ? "slow_down" : "expired_token",
          };
        throw e;
      }
    },
  };
}
