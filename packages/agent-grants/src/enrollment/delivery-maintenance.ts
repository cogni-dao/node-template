// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Provider-v2 delivery secrets; invoked under the existing provider maintenance budget. */
import type { SqlTag } from "../postgres";
import { authorityBatchFor } from "./audit-maintenance";
export async function maintainEnrollmentDelivery(tx: SqlTag): Promise<void> {
  const budget = authorityBatchFor(tx);
  const observed = (await tx`SELECT clock_timestamp()::text AS at`)[0]?.at;
  if (typeof observed !== "string") throw new Error("delivery_maintenance_clock_unavailable");
  // Delivery material has logical deadlines even with audit purge disabled. Identity/high-water/confirmation/consent remain untouched.
  const acceptance = await tx`WITH batch AS (SELECT id FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_acceptance IS NOT NULL
    AND expires_at<=${observed}::timestamptz ORDER BY expires_at,id LIMIT ${Math.min(5, 20 - budget.operations)} FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_enrollments e SET sealed_acceptance=NULL FROM batch WHERE e.id=batch.id RETURNING e.id`;
  budget.operations += acceptance.length;
  const pending = await tx`WITH batch AS (SELECT id FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_pending_key IS NOT NULL
    AND (pending_expires_at<=${observed}::timestamptz OR historical_confirmed_at IS NOT NULL OR status<>'open') ORDER BY pending_expires_at,id LIMIT ${Math.min(5, 20 - budget.operations)} FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_enrollments e SET sealed_pending_key=NULL FROM batch WHERE e.id=batch.id RETURNING e.id`;
  budget.operations += pending.length;
  await tx`WITH batch AS (SELECT subject,kind,hour FROM agent_service_quotas WHERE hour<floor(extract(epoch FROM clock_timestamp())/3600)::bigint-1
    ORDER BY hour,subject,kind LIMIT 20 FOR UPDATE SKIP LOCKED)
    DELETE FROM agent_service_quotas q USING batch WHERE q.subject=batch.subject AND q.kind=batch.kind AND q.hour=batch.hour`;
}
