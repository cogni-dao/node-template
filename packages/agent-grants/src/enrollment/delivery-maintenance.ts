// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Provider-v2 delivery secrets; invoked under the existing provider maintenance budget. */
import type { SqlTag } from "../postgres";
export async function maintainEnrollmentDelivery(tx: SqlTag): Promise<void> {
  // Delivery material has logical deadlines even with audit purge disabled. Identity/high-water/confirmation/consent remain untouched.
  await tx`WITH batch AS (SELECT id FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_acceptance IS NOT NULL
    AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_enrollments e SET sealed_acceptance=NULL FROM batch WHERE e.id=batch.id`;
  await tx`WITH batch AS (SELECT id FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_pending_key IS NOT NULL
    AND (pending_expires_at<=clock_timestamp() OR historical_confirmed_at IS NOT NULL OR status<>'open') ORDER BY pending_expires_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_enrollments e SET sealed_pending_key=NULL FROM batch WHERE e.id=batch.id`;
  await tx`WITH batch AS (SELECT subject,kind,hour FROM agent_service_quotas WHERE hour<floor(extract(epoch FROM clock_timestamp())/3600)::bigint-1
    ORDER BY hour,subject,kind LIMIT 20 FOR UPDATE SKIP LOCKED)
    DELETE FROM agent_service_quotas q USING batch WHERE q.subject=batch.subject AND q.kind=batch.kind AND q.hour=batch.hour`;
}
