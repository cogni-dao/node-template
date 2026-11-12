// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One database-leased, deadline-indexed, non-destructive tick. Purge is deliberately not implemented or enabled. */
import { lockServiceAuthority } from "../authority-lock";
import type { CredentialSql } from "../credentials/postgres";

export async function maintenanceTick(client: CredentialSql): Promise<{ processed: number; due: boolean }> {
  return client.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout', '2000', true), set_config('lock_timeout', '100', true)`;
    const lease = await tx`UPDATE agent_authority_maintenance SET next_run_at = clock_timestamp() + interval '60 seconds'
      WHERE id = 'service-enrollment' AND backfill_ready AND next_run_at <= clock_timestamp() RETURNING id`;
    if (lease.length === 0) return { processed: 0, due: false };
    const started = Date.now();
    const batch = await tx`SELECT id, principal_user_id FROM agent_service_enrollments
      WHERE status = 'open' AND expires_at <= clock_timestamp() ORDER BY expires_at, id LIMIT 20`;
    let processed = 0;
    for (const item of batch) {
      const remaining = 2000 - (Date.now() - started);
      if (remaining <= 0) break;
      await tx`SELECT set_config('statement_timeout', ${String(remaining)}, true)`;
      if (typeof item.principal_user_id !== "string" || typeof item.id !== "string") throw new Error("unreadable maintenance row");
      await lockServiceAuthority(tx, item.principal_user_id);
      await tx`SELECT id FROM agent_service_enrollments WHERE id = ${item.id} FOR UPDATE`;
      const ended = await tx`UPDATE agent_service_enrollments SET status = 'expired', terminal_at = clock_timestamp()
        WHERE id = ${item.id} AND status = 'open' AND expires_at <= clock_timestamp() RETURNING scope`;
      if (ended.length > 0) {
        // One current ask per principal+scope; approval is never revoked. Identity, history and linked credentials remain.
        await tx`UPDATE agent_roles SET revoked_at = clock_timestamp(), closed_reason = 'enrollment_expired'
          WHERE principal_user_id = ${item.principal_user_id} AND scope = ${ended[0]?.scope}
            AND approved_by IS NULL AND revoked_at IS NULL AND request_expires_at <= clock_timestamp()`;
        processed++;
      }
    }
    const due = await tx`SELECT expires_at FROM agent_service_enrollments WHERE status = 'open' AND expires_at <= clock_timestamp()
      ORDER BY expires_at, id LIMIT 1`;
    await tx`UPDATE agent_authority_maintenance SET oldest_due_at = ${due[0]?.expires_at ?? null} WHERE id = 'service-enrollment'`;
    return { processed, due: due.length > 0 };
  });
}
