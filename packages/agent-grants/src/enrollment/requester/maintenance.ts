// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Called only inside the existing authority maintenance lease/transaction; no separate scheduler or audit purge. */
import type { SqlTag } from "../../postgres";
export async function maintainRequesterCustody(tx: SqlTag): Promise<void> {
  // No staged reference and no confirm authorization: safe pre-key expiration, serialized with stage by the operation row lock.
  await tx`WITH batch AS (SELECT operation_id FROM agent_service_link_operations WHERE encrypted_secrets IS NOT NULL
    AND secret_deadline<=clock_timestamp() AND staged_connection_id IS NULL AND confirm_authorized_at IS NULL
    ORDER BY secret_deadline,operation_id LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_link_operations o SET encrypted_secrets=NULL,phase=CASE WHEN phase IN ('start_ready','start_unknown','awaiting_consent') THEN 'expired_unknown' ELSE phase END,
      state=jsonb_set(jsonb_set(state,'{phase}',to_jsonb(CASE WHEN phase IN ('start_ready','start_unknown','awaiting_consent') THEN 'expired_unknown' ELSE phase END)),'{nextAction}','"none"'),
      revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp())
    FROM batch WHERE o.operation_id=batch.operation_id AND o.staged_connection_id IS NULL AND o.confirm_authorized_at IS NULL`;
  // Custody deadline is enforced from the target's bounded activation policy, including response-loss ambiguity.
  // Lock operations before connections, exactly as stage/publication/disconnect do.
  const due =
    await tx`SELECT operation_id,state,staged_connection_id FROM agent_service_link_operations WHERE staged_connection_id IS NOT NULL
    AND secret_deadline<=clock_timestamp() AND COALESCE(state->>'quarantined','false')<>'true'
    AND phase<>'expired' ORDER BY secret_deadline,operation_id LIMIT 20 FOR UPDATE SKIP LOCKED`;
  for (const row of due) {
    const state =
      typeof row.state === "string" ? JSON.parse(row.state) : row.state;
    await tx`UPDATE connections SET encrypted_credentials=decode('','hex'),service_state='disabled' WHERE id=${row.staged_connection_id}
      AND provider='cogni-node' AND service_operation_id=${row.operation_id} AND service_identity=${JSON.stringify(state.key)}::text::jsonb AND service_credential_id=${state.credentialId}`;
    await tx`UPDATE agent_service_link_operations SET encrypted_secrets=NULL,phase='expired',state=${JSON.stringify({ ...state, phase: "expired", nextAction: "none" })}::text::jsonb,
      revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE operation_id=${row.operation_id}`;
  }
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
