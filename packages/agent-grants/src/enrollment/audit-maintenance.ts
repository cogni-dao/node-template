// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Audit work runs only inside the existing leased, deadline-bound maintenance transaction. */
import { tryLockServiceAuthority } from "../authority-lock";
import type { SqlTag } from "../postgres";

export interface AuditCounts {
  edges: number;
  credentials: number;
  roles: number;
  enrollments: number;
}
export interface AuthorityBatch {
  identities: Map<string, boolean>;
  operations: number;
  roles: number;
}
// The tagged transaction is unique to one tick; callback helpers share its remaining row budget.
const batches = new WeakMap<SqlTag, AuthorityBatch>();
export function registerAuthorityBatch(tx: SqlTag, batch: AuthorityBatch): void { batches.set(tx, batch); }
export function authorityBatchFor(tx: SqlTag): Pick<AuthorityBatch, "operations"> { return batches.get(tx) ?? { operations: 0 }; }
type Cursor = { at: string; id: string };
type Cursors = Partial<Record<"credentials" | "roles" | "enrollments", Cursor>>;

export async function tryAuditIdentity(tx: SqlTag, batch: AuthorityBatch, userId: string): Promise<boolean> {
  const previous = batch.identities.get(userId);
  if (previous !== undefined) return previous;
  if (batch.identities.size >= 20) return false;
  const principal = await tx`SELECT service_key FROM agent_principals WHERE user_id=${userId}`;
  let locked = false;
  if (typeof principal[0]?.service_key === "string") locked = await tryLockServiceAuthority(tx, userId);
  else if ((await tx`SELECT pg_try_advisory_xact_lock(hashtext(${userId})) AS locked`)[0]?.locked === true) {
    locked = (await tx`SELECT user_id FROM agent_principals WHERE user_id=${userId} FOR UPDATE SKIP LOCKED`).length > 0;
  }
  batch.identities.set(userId, locked);
  return locked;
}

/** Absence of the optional rollout singleton in narrow adopters keeps audit purge off. */
export async function auditPurgeQualified(tx: SqlTag): Promise<boolean> {
  if ((await tx`SELECT to_regclass('agent_authority_maintenance') AS state`)[0]?.state == null) return false;
  const rows = await tx`SELECT backfill_ready,purge_enabled,minimum_reader_build FROM agent_authority_maintenance
    WHERE id IN ('service-enrollment','requester-audit') ORDER BY id LIMIT 2 FOR SHARE`;
  return rows.length > 0 && rows.every((r) => r.backfill_ready === true && r.purge_enabled === true &&
    typeof r.minimum_reader_build === "string" && /^[a-f0-9]{40}$/.test(r.minimum_reader_build));
}

export async function maintainAuthorityAudit(tx: SqlTag, batch: AuthorityBatch): Promise<AuditCounts> {
  const counts: AuditCounts = { edges: 0, credentials: 0, roles: 0, enrollments: 0 };
  if (!(await auditPurgeQualified(tx))) return counts;
  const state = await tx`SELECT audit_cursors FROM agent_authority_maintenance WHERE id='service-enrollment' FOR UPDATE`;
  if (!state[0]) throw new Error("authority_audit_state_required");
  const cursors: Cursors = typeof state[0].audit_cursors === "string" ? JSON.parse(state[0].audit_cursors) : state[0].audit_cursors;
  // Native clock/cursor strings bind through text: inferred timestamptz parameters use postgres.js millisecond Date serialization.
  const now = (await tx`SELECT clock_timestamp()::text AS at`)[0]?.at;
  if (typeof now !== "string") throw new Error("audit_clock_unavailable");
  const remember = (kind: keyof Cursors, rows: readonly Record<string, unknown>[]) => {
    const last = rows.at(-1);
    if (last) cursors[kind] = { at: String(last.cursor_at), id: String(last.id) };
    else delete cursors[kind];
  };
  const c = cursors.credentials;
  const credentials = c ? await tx`SELECT id,user_id,purge_after::text AS cursor_at FROM agent_credentials
    WHERE purge_after<=${now}::text::timestamptz AND (purge_after,id)>(${c.at}::text::timestamptz,${c.id}::uuid)
    ORDER BY purge_after,id LIMIT 5` : await tx`SELECT id,user_id,purge_after::text AS cursor_at FROM agent_credentials
    WHERE purge_after<=${now}::text::timestamptz ORDER BY purge_after,id LIMIT 5`;
  for (const candidate of credentials) {
    const id = String(candidate.id), user = String(candidate.user_id);
    if (!(await tryAuditIdentity(tx, batch, user))) continue;
    // Receipt precedes credentials. A live or over-budget receipt reference pins the credential safely.
    const refs = await tx`SELECT id,purge_after FROM agent_service_enrollments WHERE credential_id=${id} ORDER BY id LIMIT 21`;
    if (refs.length > 20 - batch.operations || refs.some((r) => r.purge_after == null || Date.parse(String(r.purge_after)) > Date.parse(now))) continue;
    let allLocked = true;
    for (const ref of refs) {
      if (!(await tx`SELECT id FROM agent_service_enrollments WHERE id=${ref.id} AND purge_after<=${now}::text::timestamptz FOR UPDATE SKIP LOCKED`).length) allLocked = false;
    }
    if (!allLocked) continue;
    const parent = await tx`SELECT c.id,(c.confirmed_at IS NULL OR (p.ever_confirmed AND p.first_confirmed_at<=c.confirmed_at)) AS summary_ready
      FROM agent_credentials c JOIN agent_principals p ON p.user_id=c.user_id WHERE c.id=${id} AND c.purge_after<=${now}::text::timestamptz
      AND c.renew_until<=${now}::text::timestamptz FOR UPDATE OF c SKIP LOCKED`;
    if (!parent.length) continue;
    if (parent[0]?.summary_ready !== true) throw new Error("confirmation_backfill_incomplete");
    const pending = await tx`SELECT id FROM agent_credentials WHERE predecessor_id=${id} AND confirmed_at IS NULL AND revoked_at IS NULL
      AND pending_expires_at>${now}::text::timestamptz LIMIT 1`;
    if (pending.length) continue;
    const children = await tx`SELECT id,user_id,predecessor_provenance_id FROM agent_credentials
      WHERE predecessor_id=${id} AND confirmed_at IS NOT NULL ORDER BY id LIMIT ${20 - counts.edges} FOR UPDATE SKIP LOCKED`;
    for (const child of children) {
      if (child.user_id !== user || child.predecessor_provenance_id != null && child.predecessor_provenance_id !== id)
        throw new Error("credential_predecessor_provenance_mismatch");
      const detached = await tx`UPDATE agent_credentials SET predecessor_provenance_id=${id},predecessor_id=NULL
        WHERE id=${child.id} AND predecessor_id=${id} AND confirmed_at IS NOT NULL RETURNING id`;
      counts.edges += detached.length;
    }
    // Every unconfirmed edge, including an expired child, is retained until that child itself can be deleted.
    if ((await tx`SELECT id FROM agent_credentials WHERE predecessor_id=${id} LIMIT 1`).length) continue;
    for (const ref of refs) {
      await tx`UPDATE agent_service_enrollments SET credential_id=NULL WHERE id=${ref.id} AND credential_id=${id}`;
      batch.operations++;
    }
    counts.credentials += (await tx`DELETE FROM agent_credentials WHERE id=${id} AND purge_after<=clock_timestamp()
      AND renew_until<=clock_timestamp() RETURNING id`).length;
  }
  remember("credentials", credentials);

  const r = cursors.roles;
  const roles = r ? await tx`SELECT id,principal_user_id,purge_after::text AS cursor_at FROM agent_roles
    WHERE purge_after<=${now}::text::timestamptz AND (purge_after,id)>(${r.at}::text::timestamptz,${r.id}::uuid)
    ORDER BY purge_after,id LIMIT ${Math.min(5, 20 - batch.roles)}` : await tx`SELECT id,principal_user_id,purge_after::text AS cursor_at FROM agent_roles
    WHERE purge_after<=${now}::text::timestamptz ORDER BY purge_after,id LIMIT ${Math.min(5, 20 - batch.roles)}`;
  for (const candidate of roles) {
    if (!(await tryAuditIdentity(tx, batch, String(candidate.principal_user_id)))) continue;
    const rows = await tx`SELECT * FROM agent_roles WHERE id=${candidate.id} AND revoked_at IS NOT NULL AND purge_after<=${now}::text::timestamptz FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row) continue;
    const explicit = row.approved_by != null || row.closed_reason == null || !["enrollment_expired", "request_expired"].includes(String(row.closed_reason));
    if (explicit) {
      // Select the exact current ID in PostgreSQL; a driver Date round trip loses sub-millisecond decision order.
      const latest = await tx`SELECT id FROM agent_roles WHERE principal_user_id=${row.principal_user_id} AND scope=${row.scope}
        AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
        ORDER BY created_at DESC,id DESC LIMIT 1`;
      if (!latest[0]) throw new Error("current_consent_control_unavailable");
      if (latest[0].id === row.id) continue;
    }
    counts.roles += (await tx`DELETE FROM agent_roles WHERE id=${row.id} AND revoked_at IS NOT NULL RETURNING id`).length;
    batch.roles++;
  }
  remember("roles", roles);

  const e = cursors.enrollments;
  const enrollments = e ? await tx`SELECT id,principal_user_id,purge_after::text AS cursor_at FROM agent_service_enrollments
    WHERE purge_after<=${now}::text::timestamptz AND (purge_after,id)>(${e.at}::text::timestamptz,${e.id}::uuid)
    ORDER BY purge_after,id LIMIT ${Math.min(5, 20 - batch.operations)}` : await tx`SELECT id,principal_user_id,purge_after::text AS cursor_at FROM agent_service_enrollments
    WHERE purge_after<=${now}::text::timestamptz ORDER BY purge_after,id LIMIT ${Math.min(5, 20 - batch.operations)}`;
  for (const candidate of enrollments) {
    if (!(await tryAuditIdentity(tx, batch, String(candidate.principal_user_id)))) continue;
    const rows = await tx`SELECT * FROM agent_service_enrollments WHERE id=${candidate.id} AND status<>'open'
      AND purge_after<=${now}::text::timestamptz AND COALESCE(original_start_exp,expires_at)<clock_timestamp() FOR UPDATE SKIP LOCKED`;
    const row = rows[0];
    if (!row || row.credential_id != null || row.sealed_acceptance != null || row.sealed_pending_key != null) continue;
    if (row.operation_id != null && (await tx`SELECT id FROM agent_credentials WHERE service_operation_id=${row.operation_id} LIMIT 1`).length) continue;
    const refs = row.operation_id == null ? [] : await tx`SELECT id FROM agent_roles WHERE enrollment_operation_id=${row.operation_id} ORDER BY id LIMIT 21`;
    if (refs.length > 20 - batch.roles) continue;
    let allLocked = true;
    for (const ref of refs) if (!(await tx`SELECT id FROM agent_roles WHERE id=${ref.id} FOR UPDATE SKIP LOCKED`).length) allLocked = false;
    if (!allLocked) continue;
    if (row.operation_id != null) {
      const pointer = await tx`SELECT current_operation_id,current_operation_digest FROM agent_principals WHERE user_id=${row.principal_user_id}`;
      if (pointer[0]?.current_operation_id === row.operation_id && pointer[0]?.current_operation_digest !== row.intent_digest)
        throw new Error("current_operation_digest_missing");
      for (const ref of refs) {
        await tx`UPDATE agent_roles SET enrollment_operation_id=NULL WHERE id=${ref.id} AND enrollment_operation_id=${row.operation_id}`;
        batch.roles++;
      }
    }
    counts.enrollments += (await tx`DELETE FROM agent_service_enrollments WHERE id=${row.id} AND purge_after<=clock_timestamp() RETURNING id`).length;
    batch.operations++;
  }
  remember("enrollments", enrollments);
  await tx`UPDATE agent_authority_maintenance SET audit_cursors=${JSON.stringify(cursors)}::text::jsonb WHERE id='service-enrollment'`;
  return counts;
}
