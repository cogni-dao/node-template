// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One leased expiry/audit tick: twenty candidates, nonblocking authority locks, one cumulative two-second cancellation deadline. */
import { auditPurgeQualified, maintainAuthorityAudit, tryAuditIdentity, registerAuthorityBatch, type AuthorityBatch } from "./audit-maintenance";
import type { CredentialSql } from "../credentials/postgres";
import type { SqlTag } from "../postgres";

class BudgetExpired extends Error {}

/** postgres.js PendingQuery.cancel cancels the current server statement; throwing from begin rolls back all tick effects. */
function withinBudget(tx: SqlTag, deadline: number): SqlTag {
  const run = async (makeQuery: () => ReturnType<SqlTag>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BudgetExpired();
    const pending = makeQuery() as ReturnType<SqlTag> & { cancel?: () => unknown };
    if (typeof pending.cancel !== "function") throw new Error("maintenance requires cancelable postgres queries");
    let elapsed = false;
    const timer = setTimeout(() => {
      elapsed = true;
      try { void Promise.resolve(pending.cancel?.()).catch(() => undefined); }
      catch { /* The server's remaining statement timeout still enforces cancellation. */ }
    }, remaining);
    try {
      const result = await pending;
      if (elapsed || Date.now() >= deadline) throw new BudgetExpired();
      return result;
    } catch (error) {
      if (elapsed || Date.now() >= deadline) throw new BudgetExpired();
      throw error;
    } finally { clearTimeout(timer); }
  };
  return async (strings, ...values) => {
    // The absolute timer includes configuration round trips; each server statement also receives only the remaining allowance.
    await run(() => tx`SELECT set_config('statement_timeout', ${String(Math.max(1, deadline - Date.now()))}, true)`);
    return run(() => tx(strings, ...values));
  };
}

/** The same cancellation/commit budget serves provider and requester-only maintenance. */
export async function runBoundedMaintenance<T>(client: CredentialSql, work: (tx: SqlTag) => Promise<T>, exhausted: T): Promise<T> {
  const deadline = Date.now() + 2000;
  try {
    return await client.begin(async (raw) => {
      const tx = withinBudget(raw, deadline);
      await tx`SELECT set_config('lock_timeout', '100', true)`;
      const result = await work(tx);
      await tx`SELECT set_config('statement_timeout', ${String(Math.max(1, deadline - Date.now()))}, true)`;
      return result;
    });
  } catch (error) {
    if (error instanceof BudgetExpired || Date.now() >= deadline && typeof error === "object" && error !== null &&
        (error as { code?: unknown }).code === "57014") return exhausted;
    throw error;
  }
}
export async function maintenanceTick(client: CredentialSql, extra?: (tx: SqlTag) => Promise<void>): Promise<{ processed: number; due: boolean }> {
  return runBoundedMaintenance(client, async (tx) => {
        const lease = await tx`WITH candidate AS (
          SELECT id FROM agent_authority_maintenance WHERE id = 'service-enrollment' AND backfill_ready
            AND next_run_at <= clock_timestamp() FOR UPDATE SKIP LOCKED
        ) UPDATE agent_authority_maintenance s SET next_run_at = clock_timestamp() + interval '60 seconds'
          FROM candidate WHERE s.id = candidate.id
          RETURNING s.id, s.cursor_expires_at::text AS cursor_expires_at, s.cursor_enrollment_id`;
        if (lease.length === 0) return { processed: 0, due: false };
        const authorityBatch: AuthorityBatch = { identities: new Map(), operations: 0, roles: 0 };
        registerAuthorityBatch(tx, authorityBatch);
        const purge = await auditPurgeQualified(tx);
        const expiryLimit = purge ? 5 : 20;
        const cursorAt = lease[0]?.cursor_expires_at;
        const cursorId = lease[0]?.cursor_enrollment_id;
        if ((cursorAt == null) !== (cursorId == null)) throw new Error("incomplete maintenance cursor");
        const firstPage = () => tx`SELECT id, principal_user_id, expires_at::text AS cursor_expires_at FROM agent_service_enrollments
          WHERE status = 'open' AND expires_at <= (SELECT clock_timestamp()) ORDER BY expires_at, id LIMIT ${expiryLimit}`;
        let batch = cursorAt == null ? await firstPage() : await tx`SELECT id, principal_user_id, expires_at::text AS cursor_expires_at
          FROM agent_service_enrollments WHERE status = 'open' AND expires_at <= (SELECT clock_timestamp())
            AND (expires_at, id) > (${cursorAt}::timestamptz, ${cursorId}::uuid) ORDER BY expires_at, id LIMIT ${expiryLimit}`;
        // Wrap only after reaching the end. Both indexed reads are bounded; at most 20 identities are attempted.
        if (batch.length === 0 && cursorAt != null) batch = await firstPage();
        let processed = 0;
        for (const item of batch) {
          if (typeof item.principal_user_id !== "string" || typeof item.id !== "string") throw new Error("unreadable maintenance row");
          if (!(await tryAuditIdentity(tx, authorityBatch, item.principal_user_id))) continue;
          const receipt = await tx`SELECT id, scope FROM agent_service_enrollments WHERE id = ${item.id} FOR UPDATE SKIP LOCKED`;
          if (receipt.length === 0) continue;
          // Lock the sole current child ask after the receipt. A locked child skips the identity, before any mutation.
          const ask = await tx`SELECT id FROM agent_roles WHERE principal_user_id = ${item.principal_user_id}
            AND scope = ${receipt[0]?.scope} AND approved_by IS NULL AND revoked_at IS NULL LIMIT 1`;
          if (ask[0] && (await tx`SELECT id FROM agent_roles WHERE id = ${ask[0].id} FOR UPDATE SKIP LOCKED`).length === 0) continue;
          const ended = await tx`UPDATE agent_service_enrollments SET status = 'expired', terminal_at = clock_timestamp()
            WHERE id = ${item.id} AND status = 'open' AND expires_at <= clock_timestamp() RETURNING scope`;
          if (ended.length > 0) {
            if (ask[0]) await tx`UPDATE agent_roles SET revoked_at = clock_timestamp(), closed_reason = 'enrollment_expired'
              WHERE id = ${ask[0].id} AND approved_by IS NULL AND revoked_at IS NULL AND request_expires_at <= clock_timestamp()`;
            authorityBatch.operations++;
            if (ask[0]) authorityBatch.roles++;
            processed++;
          }
        }
        if (extra) await extra(tx);
        if (purge) await maintainAuthorityAudit(tx, authorityBatch);
        const due = await tx`SELECT expires_at FROM agent_service_enrollments WHERE status = 'open' AND expires_at <= (SELECT clock_timestamp())
          ORDER BY expires_at, id LIMIT 1`;
        const last = batch[batch.length - 1];
        if (last && (typeof last.id !== "string" || typeof last.cursor_expires_at !== "string")) throw new Error("unreadable maintenance cursor");
        await tx`UPDATE agent_authority_maintenance SET oldest_due_at = ${due[0]?.expires_at ?? null},
          cursor_expires_at = ${last?.cursor_expires_at ?? null}::timestamptz,
          cursor_enrollment_id = ${last?.id ?? null}::uuid WHERE id = 'service-enrollment'`;
        return { processed, due: due.length > 0 };
  }, { processed: 0, due: true });
}
