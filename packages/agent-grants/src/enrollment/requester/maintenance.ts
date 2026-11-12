// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Called only inside the existing authority maintenance lease/transaction; no separate scheduler. */
import type { SqlTag } from "../../postgres";
import type { CredentialSql } from "../../credentials/postgres";
import { runBoundedMaintenance } from "../maintenance";
import { auditPurgeQualified } from "../audit-maintenance";
export async function maintainRequesterCustody(tx: SqlTag): Promise<void> {
  const observed = (await tx`SELECT clock_timestamp()::text AS at`)[0]?.at;
  if (typeof observed !== "string") throw new Error("requester_maintenance_clock_unavailable");
  // No staged reference and no confirm authorization: safe pre-key expiration, serialized with stage by the operation row lock.
  await tx`WITH batch AS (SELECT operation_id FROM agent_service_link_operations WHERE encrypted_secrets IS NOT NULL
    AND secret_deadline<=${observed}::timestamptz AND staged_connection_id IS NULL AND confirm_authorized_at IS NULL
    ORDER BY secret_deadline,operation_id LIMIT 5 FOR UPDATE SKIP LOCKED)
    UPDATE agent_service_link_operations o SET encrypted_secrets=NULL,phase=CASE WHEN phase IN ('start_ready','start_unknown','awaiting_consent') THEN 'expired_unknown' ELSE phase END,
      state=jsonb_set(jsonb_set(state,'{phase}',to_jsonb(CASE WHEN phase IN ('start_ready','start_unknown','awaiting_consent') THEN 'expired_unknown' ELSE phase END)),'{nextAction}','"none"'),
      revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp())
    FROM batch WHERE o.operation_id=batch.operation_id AND o.staged_connection_id IS NULL AND o.confirm_authorized_at IS NULL`;
  // Custody deadline is enforced from the target's bounded activation policy, including response-loss ambiguity.
  // Lock operations before connections, exactly as stage/publication/disconnect do.
  const due =
    await tx`SELECT operation_id,state,staged_connection_id FROM agent_service_link_operations WHERE staged_connection_id IS NOT NULL
    AND secret_deadline<=${observed}::timestamptz AND COALESCE(state->>'quarantined','false')<>'true'
    AND phase<>'expired' ORDER BY secret_deadline,operation_id LIMIT 5 FOR UPDATE SKIP LOCKED`;
  for (const row of due) {
    const state =
      typeof row.state === "string" ? JSON.parse(row.state) : row.state;
    await tx`UPDATE connections SET encrypted_credentials=decode('','hex'),service_state='disabled' WHERE id=${row.staged_connection_id}
      AND provider='cogni-node' AND service_operation_id=${row.operation_id} AND service_identity=${JSON.stringify(state.key)}::text::jsonb AND service_credential_id=${state.credentialId}`;
    await tx`UPDATE agent_service_link_operations SET encrypted_secrets=NULL,phase='expired',state=${JSON.stringify({ ...state, phase: "expired", nextAction: "none" })}::text::jsonb,
      revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE operation_id=${row.operation_id}`;
  }
  await maintainRequesterAudit(tx, observed);
}

/** Requester-only consumers call this from their existing maintenance driver. No provider tables or extra scheduler/lease are required. */
export async function requesterMaintenanceTick(client: CredentialSql): Promise<boolean> {
  return runBoundedMaintenance(client, async (tx) => {
    const role = await tx`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname=current_user`;
    if (role[0]?.bypass !== true) throw new Error("requester_service_role_required");
    await maintainRequesterCustody(tx);
    return true;
  }, false);
}

/** Current rows remain the exact-K high-water mark; only their expired audit payload is compacted. */
async function maintainRequesterAudit(tx: SqlTag, observed: string): Promise<void> {
  if (!(await auditPurgeQualified(tx))) return;
  const state = await tx`SELECT id,audit_cursors FROM agent_authority_maintenance
    WHERE id IN ('service-enrollment','requester-audit') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
  if (!state[0]) return;
  const cursors = typeof state[0].audit_cursors === "string" ? JSON.parse(state[0].audit_cursors) : state[0].audit_cursors;
  const cursor = cursors.requester;
  const rows = cursor ? await tx`SELECT *,purge_after::text AS audit_cursor_at FROM agent_service_link_operations WHERE purge_after<=${observed}::timestamptz
    AND (purge_after,operation_id)>(${cursor.at}::timestamptz,${cursor.id}::uuid)
    ORDER BY purge_after,operation_id LIMIT 10 FOR UPDATE SKIP LOCKED` : await tx`SELECT *,purge_after::text AS audit_cursor_at FROM agent_service_link_operations
    WHERE purge_after<=${observed}::timestamptz ORDER BY purge_after,operation_id LIMIT 10 FOR UPDATE SKIP LOCKED`;
  for (const row of rows) {
    const publicState = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
    if (row.encrypted_secrets != null || publicState.quarantined === true || !row.terminal_at ||
        !["disconnected","denied","expired","expired_unknown","needs_reenroll"].includes(String(row.phase))) continue;
    if (row.staged_connection_id != null) {
      const connection = await tx`SELECT id,encrypted_credentials,service_state FROM connections WHERE id=${row.staged_connection_id}
        AND provider='cogni-node' AND service_operation_id=${row.operation_id}
        AND billing_account_id=${row.billing_account_id} AND service_credential_id=${publicState.credentialId}
        AND service_identity=${JSON.stringify(publicState.key)}::text::jsonb FOR UPDATE SKIP LOCKED`;
      if (!connection[0] || connection[0].service_state !== "disabled" || !(connection[0].encrypted_credentials instanceof Uint8Array) || connection[0].encrypted_credentials.length !== 0) continue;
    }
    const connectionId = row.staged_connection_id;
    if (row.current) {
      // The immutable public intent is needed to sign explicit continuation/replacement after remote audit removal.
      const compact = { key:publicState.key,intent:publicState.intent,intentDigest:publicState.intentDigest,
        originalTokenDigest:publicState.originalTokenDigest,phase:row.phase,nextAction:"none",attempts:0,paused:false,error:null,
        ...(publicState.acceptedAt ? {acceptedAt:publicState.acceptedAt,recoveryExpiresAt:publicState.recoveryExpiresAt} : {}),
        ...(publicState.confirmationObservedAt ? {confirmationObservedAt:publicState.confirmationObservedAt} : {}) };
      await tx`UPDATE agent_service_link_operations SET state=${JSON.stringify(compact)}::text::jsonb,staged_connection_id=NULL,
        confirm_authorized_at=NULL,audit_compacted_at=clock_timestamp(),revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL
        WHERE operation_id=${row.operation_id} AND current AND encrypted_secrets IS NULL`;
    } else await tx`DELETE FROM agent_service_link_operations WHERE operation_id=${row.operation_id} AND NOT current AND encrypted_secrets IS NULL`;
    if (connectionId != null) await tx`DELETE FROM connections WHERE id=${connectionId} AND provider='cogni-node'
      AND service_operation_id=${row.operation_id} AND billing_account_id=${row.billing_account_id}
      AND service_credential_id=${publicState.credentialId} AND service_identity=${JSON.stringify(publicState.key)}::text::jsonb
      AND service_state='disabled' AND octet_length(encrypted_credentials)=0
      AND NOT EXISTS (SELECT 1 FROM agent_service_link_operations WHERE staged_connection_id=${connectionId})`;
  }
  const last=rows.at(-1);
  if (last) cursors.requester={at:String(last.audit_cursor_at),id:last.operation_id};
  else delete cursors.requester;
  await tx`UPDATE agent_authority_maintenance SET audit_cursors=${JSON.stringify(cursors)}::text::jsonb WHERE id=${state[0].id}`;
}
