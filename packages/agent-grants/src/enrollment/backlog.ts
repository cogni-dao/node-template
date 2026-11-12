// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One deadline/eligibility read for admission and the leased maintenance verdict. Never mutates retention or authority. */
import type { SqlTag } from "../postgres";
import { auditPurgeQualified } from "./audit-maintenance";

export async function enrollmentBacklog(
  tx: SqlTag
): Promise<{ oldestDueAt: string | null; overdue: boolean }> {
  const observed = (await tx`SELECT clock_timestamp()::text AS at`)[0]?.at;
  if (typeof observed !== "string")
    throw new Error("maintenance_clock_unavailable");
  // Each queue contributes only its first eligible deadline, using its existing deadline/foreign-key indexes.
  const deadlines = [
    ...(await tx`SELECT due_at::text FROM (
    (SELECT expires_at AS due_at FROM agent_service_enrollments
      WHERE status='open' AND expires_at<=${observed}::text::timestamptz ORDER BY expires_at,id LIMIT 1)
    UNION ALL
    (SELECT expires_at FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_acceptance IS NOT NULL
      AND expires_at<=${observed}::text::timestamptz ORDER BY expires_at,id LIMIT 1)
    UNION ALL
    (SELECT LEAST(pending_expires_at,historical_confirmed_at,CASE WHEN status<>'open' THEN terminal_at END)
      FROM agent_service_enrollments WHERE operation_id IS NOT NULL AND sealed_pending_key IS NOT NULL
      AND (pending_expires_at<=${observed}::text::timestamptz OR historical_confirmed_at IS NOT NULL OR status<>'open')
      ORDER BY 1,id LIMIT 1)
  ) queues`),
  ];
  const purge = await auditPurgeQualified(tx);
  if (purge)
    deadlines.push(
      ...(await tx`SELECT due_at::text FROM (
    (SELECT c.purge_after AS due_at FROM agent_credentials c JOIN agent_principals p ON p.user_id=c.user_id
      WHERE c.purge_after<=${observed}::text::timestamptz AND c.renew_until<=${observed}::text::timestamptz
      AND (c.confirmed_at IS NULL OR (p.ever_confirmed AND p.first_confirmed_at<=c.confirmed_at))
      AND NOT EXISTS (SELECT 1 FROM agent_service_enrollments e WHERE e.credential_id=c.id
        AND (e.purge_after IS NULL OR e.purge_after>${observed}::text::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM agent_service_enrollments e WHERE e.credential_id=c.id ORDER BY e.id OFFSET 20 LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM agent_credentials child WHERE child.predecessor_id=c.id AND child.confirmed_at IS NULL
        AND child.revoked_at IS NULL AND child.pending_expires_at>${observed}::text::timestamptz)
      AND (NOT EXISTS (SELECT 1 FROM agent_credentials child WHERE child.predecessor_id=c.id)
        OR EXISTS (SELECT 1 FROM agent_credentials child WHERE child.predecessor_id=c.id AND child.confirmed_at IS NOT NULL))
      ORDER BY c.purge_after,c.id LIMIT 1)
    UNION ALL
    (SELECT r.purge_after FROM agent_roles r WHERE r.revoked_at IS NOT NULL AND r.purge_after<=${observed}::text::timestamptz
      AND ((r.approved_by IS NULL AND r.closed_reason IN ('enrollment_expired','request_expired')) OR r.id<>(
        SELECT latest.id FROM agent_roles latest WHERE latest.principal_user_id=r.principal_user_id AND latest.scope=r.scope
        AND (latest.approved_by IS NOT NULL OR (latest.revoked_at IS NOT NULL
          AND (latest.closed_reason IS NULL OR latest.closed_reason NOT IN ('enrollment_expired','request_expired'))))
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))
      ORDER BY r.purge_after,r.id LIMIT 1)
    UNION ALL
    (SELECT e.purge_after FROM agent_service_enrollments e WHERE e.status<>'open' AND e.purge_after<=${observed}::text::timestamptz
      AND COALESCE(e.original_start_exp,e.expires_at)<${observed}::text::timestamptz
      AND e.credential_id IS NULL AND e.sealed_acceptance IS NULL AND e.sealed_pending_key IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_credentials c WHERE c.service_operation_id=e.operation_id)
      AND NOT EXISTS (SELECT 1 FROM agent_roles r WHERE r.enrollment_operation_id=e.operation_id ORDER BY r.id OFFSET 20 LIMIT 1)
      ORDER BY e.purge_after,e.id LIMIT 1)
  ) queues`)
    );
  // Provider-only adopters have no requester tables. A present but unreadable/incomplete schema fails closed.
  const requester = (
    await tx`SELECT to_regclass('agent_service_link_operations') AS relation`
  )[0]?.relation;
  if (requester != null) {
    deadlines.push(
      ...(await tx`SELECT due_at::text FROM (
      (SELECT secret_deadline AS due_at FROM agent_service_link_operations WHERE encrypted_secrets IS NOT NULL
        AND staged_connection_id IS NULL AND confirm_authorized_at IS NULL AND secret_deadline<=${observed}::text::timestamptz
        ORDER BY secret_deadline,operation_id LIMIT 1)
      UNION ALL
      (SELECT secret_deadline FROM agent_service_link_operations WHERE staged_connection_id IS NOT NULL
        AND COALESCE(state->>'quarantined','false')<>'true' AND phase<>'expired' AND secret_deadline<=${observed}::text::timestamptz
        ORDER BY secret_deadline,operation_id LIMIT 1)
    ) queues`)
    );
    if (purge)
      deadlines.push(
        ...(await tx`SELECT o.purge_after::text AS due_at FROM agent_service_link_operations o
      WHERE o.purge_after<=${observed}::text::timestamptz AND o.terminal_at IS NOT NULL AND o.encrypted_secrets IS NULL
      AND COALESCE(o.state->>'quarantined','false')<>'true' AND o.phase IN ('disconnected','denied','expired','expired_unknown','needs_reenroll')
      AND (o.staged_connection_id IS NULL OR EXISTS (SELECT 1 FROM connections c WHERE c.id=o.staged_connection_id
        AND c.provider='cogni-node' AND c.service_operation_id=o.operation_id AND c.billing_account_id=o.billing_account_id
        AND c.service_credential_id::text=o.state->>'credentialId' AND c.service_identity=o.state->'key'
        AND c.service_state='disabled' AND octet_length(c.encrypted_credentials)=0))
      ORDER BY o.purge_after,o.operation_id LIMIT 1`)
      );
  }
  const values = deadlines.map((row) => {
    if (typeof row.due_at !== "string")
      throw new Error("maintenance_deadline_unavailable");
    return row.due_at;
  });
  const result = (
    await tx`SELECT min(at)::text AS oldest_due_at,
    COALESCE(min(at)<${observed}::text::timestamptz-interval '5 minutes',false) AS overdue
    FROM (SELECT unnest(${values}::text[])::timestamptz AS at) deadlines`
  )[0];
  if (
    !result ||
    typeof result.overdue !== "boolean" ||
    (result.oldest_due_at != null && typeof result.oldest_due_at !== "string")
  )
    throw new Error("maintenance_backlog_unavailable");
  return {
    oldestDueAt: result.oldest_due_at as string | null,
    overdue: result.overdue,
  };
}

export async function assertEnrollmentMaintenance(tx: SqlTag): Promise<void> {
  const ready =
    await tx`SELECT 1 FROM agent_authority_maintenance WHERE id='service-enrollment' AND backfill_ready`;
  if (!ready.length || (await enrollmentBacklog(tx)).overdue)
    throw new Error("enrollment maintenance unavailable or overdue");
}
