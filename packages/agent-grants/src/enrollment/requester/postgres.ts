// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Durable requester + existing connections vault over one injected service transaction. No pool or secret configuration owned here. */
import type { CredentialSql } from "../../credentials/postgres";
import type { SqlTag } from "../../postgres";
import { canonicalJson, connectionKeyDigest } from "../protocol";
import { custodyAad } from "./cipher";
import type {
  CustodyCipher,
  LeaseGuard,
  LinkHandle,
  LinkRow,
  LinkState,
  RequesterStore,
  RequesterVault,
} from "./types";

const iso = (v: unknown): string => new Date(v as string).toISOString();
const optionalIso = (v: unknown): string | null => (v == null ? null : iso(v));
function decode(r: Record<string, unknown>): LinkRow {
  const state = (
    typeof r.state === "string" ? JSON.parse(r.state) : r.state
  ) as LinkState;
  return {
    operationId: String(r.operation_id),
    revision: Number(r.revision),
    fence: Number(r.fence),
    state: { ...state, phase: r.phase as LinkState["phase"] },
    encryptedSecrets:
      r.encrypted_secrets == null ? null : String(r.encrypted_secrets),
    nextAttemptAt: iso(r.next_attempt_at),
    secretDeadline: iso(r.secret_deadline),
    leaseOwner: r.lease_owner == null ? null : String(r.lease_owner),
    leaseUntil: optionalIso(r.lease_until),
  };
}
async function deterministicId(
  operationId: string,
  credentialId: string
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${operationId}:${credentialId}`)
    )
  ).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function createPostgresRequesterCustody(
  client: CredentialSql,
  options: { cipher: CustodyCipher; systemPrincipalUserId: string; readReadyConnection: (input: LinkHandle & { connectionId: string; credentialId: string }) => Promise<{ encryptedCredentials: Uint8Array; encryptionKeyId: string } | null> }
): { store: RequesterStore; vault: RequesterVault } {
  const { cipher, systemPrincipalUserId } = options;
  let checked: Promise<void> | undefined;
  async function ready() {
    checked ??= (async () => {
      const r =
        await client`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname=current_user`;
      if (r[0]?.bypass !== true)
        throw new Error("requester_service_role_required");
    })().catch((e) => {
      checked = undefined;
      throw e;
    });
    await checked;
  }
  async function select(tx: SqlTag, h: LinkHandle, lock = false) {
    const digest = await connectionKeyDigest(h.key);
    const result = lock
      ? await tx`SELECT * FROM agent_service_link_operations WHERE operation_id=${h.operationId} AND key_digest=${digest}
      AND state->'key'=${JSON.stringify(h.key)}::text::jsonb AND billing_account_id=${h.key.billingAccountId} AND current FOR UPDATE`
      : await tx`SELECT * FROM agent_service_link_operations WHERE operation_id=${h.operationId} AND key_digest=${digest}
      AND state->'key'=${JSON.stringify(h.key)}::text::jsonb AND billing_account_id=${h.key.billingAccountId} AND current`;
    return result[0] ? decode(result[0]) : null;
  }
  async function locked(tx: SqlTag, g: LeaseGuard) {
    const r = await select(
      tx,
      { operationId: g.operationId, key: g.key },
      true
    );
    if (
      !r ||
      r.revision !== g.revision ||
      r.fence !== g.fence ||
      r.leaseOwner !== g.leaseOwner
    )
      return null;
    const valid =
      await tx`SELECT 1 FROM agent_service_link_operations WHERE operation_id=${g.operationId} AND lease_until>clock_timestamp()
      AND current AND (secret_deadline>clock_timestamp() OR state->>'quarantined'='true') AND phase NOT IN ('disconnected','denied','expired','expired_unknown','needs_reenroll')`;
    return valid.length ? r : null;
  }
  async function write(
    tx: SqlTag,
    r: LinkRow,
    state: LinkState,
    settings: {
      encryptedSecrets?: string | null;
      delaySec?: number;
      release?: boolean;
    } = {}
  ) {
    if (
      canonicalJson(r.state.key) !== canonicalJson(state.key) ||
      canonicalJson(r.state.intent) !== canonicalJson(state.intent) ||
      r.state.intentDigest !== state.intentDigest ||
      r.state.originalTokenDigest !== state.originalTokenDigest
    )
      throw new Error("immutable_link_identity");
    const out =
      await tx`UPDATE agent_service_link_operations SET state=${JSON.stringify(state)}::text::jsonb, phase=${state.phase},revision=revision+1,
      encrypted_secrets=${settings.encryptedSecrets === undefined ? r.encryptedSecrets : settings.encryptedSecrets},
      lease_owner=${settings.release ? null : r.leaseOwner},lease_until=${settings.release ? null : r.leaseUntil},
      next_attempt_at=clock_timestamp()+(${settings.delaySec ?? 0}::int*interval '1 second'),
      confirm_authorized_at=CASE WHEN ${state.phase}='confirm_unknown' THEN COALESCE(confirm_authorized_at,clock_timestamp()) ELSE confirm_authorized_at END,
      terminal_at=CASE WHEN ${["disconnected", "denied", "expired", "expired_unknown", "needs_reenroll"].includes(state.phase)} THEN COALESCE(terminal_at,clock_timestamp()) ELSE terminal_at END
      WHERE operation_id=${r.operationId} AND revision=${r.revision} AND fence=${r.fence}
        AND lease_until>clock_timestamp() AND (secret_deadline>clock_timestamp() OR state->>'quarantined'='true') RETURNING *`;
    return out[0] ? decode(out[0]) : null;
  }
  // A failed final CAS must abort the transaction containing vault changes.
  async function writeCustody(tx: SqlTag, r: LinkRow, state: LinkState, settings: Parameters<typeof write>[3]) {
    const result = await write(tx, r, state, settings);
    if (!result) throw new Error("custody_fence_expired");
    return result;
  }
  async function disable(tx: SqlTag, r: LinkRow) {
    if (!r.state.connectionId || !r.state.credentialId) return;
    await tx`UPDATE connections SET service_state='disabled' WHERE id=${r.state.connectionId} AND provider='cogni-node'
      AND billing_account_id=${r.state.key.billingAccountId} AND service_identity=${JSON.stringify(r.state.key)}::text::jsonb
      AND service_operation_id=${r.operationId} AND service_credential_id=${r.state.credentialId}`;
  }
  const store: RequesterStore = {
    durable: true,
    async reserve(row) {
      await ready();
      return client.begin(async (tx) => {
        const key = row.state.key,
          digest = await connectionKeyDigest(key);
        const owner =
          await tx`SELECT 1 FROM billing_accounts WHERE id=${key.billingAccountId} AND owner_user_id=${systemPrincipalUserId}`;
        if (!owner.length) throw new Error("requester_system_tenant_required");
        await tx`INSERT INTO agent_service_link_operations(operation_id,key_digest,home_node_id,home_environment,home_origin,service,billing_account_id,
          target_node_id,target_environment,target_origin,generation,phase,state,encrypted_secrets,secret_deadline)
          VALUES(${row.operationId},${digest},${key.home.nodeId},${key.home.environment},${key.home.origin},${key.service},${key.billingAccountId},
            ${key.target.nodeId},${key.target.environment},${key.target.origin},${row.state.intent.generation},${row.state.phase},${JSON.stringify(row.state)}::text::jsonb,${row.encryptedSecrets},${row.secretDeadline})
          ON CONFLICT DO NOTHING`;
        const existing =
          await tx`SELECT * FROM agent_service_link_operations WHERE key_digest=${digest} AND current AND state->'key'=${JSON.stringify(key)}::text::jsonb`;
        if (!existing[0]) throw new Error("requester_identity_conflict");
        return decode(existing[0]);
      });
    },
    async replace(handle, expectedRevision, draft) {
      await ready();
      return client.begin(async (tx) => {
        const r = await select(tx, handle, true);
        if (
          !r ||
          r.revision !== expectedRevision ||
          ![
            "disconnected",
            "denied",
            "expired",
            "expired_unknown",
            "needs_reenroll",
          ].includes(r.state.phase)
        )
          return null;
        const current =
          await tx`SELECT 1 FROM agent_service_link_operations WHERE operation_id=${r.operationId} AND current`;
        if (
          !current.length ||
          draft.state.intent.expectedOperationId !== r.operationId ||
          draft.state.intent.expectedGeneration !== r.state.intent.generation ||
          canonicalJson(draft.state.key) !== canonicalJson(handle.key)
        )
          return null;
        await disable(tx, r);
        await tx`UPDATE agent_service_link_operations SET current=false,fence=fence+1,revision=revision+1,lease_owner=NULL,lease_until=NULL WHERE operation_id=${r.operationId}`;
        const key = handle.key;
        const inserted =
          await tx`INSERT INTO agent_service_link_operations(operation_id,key_digest,home_node_id,home_environment,home_origin,service,billing_account_id,
          target_node_id,target_environment,target_origin,generation,phase,state,encrypted_secrets,secret_deadline)
          VALUES(${draft.operationId},${await connectionKeyDigest(key)},${key.home.nodeId},${key.home.environment},${key.home.origin},${key.service},${key.billingAccountId},
            ${key.target.nodeId},${key.target.environment},${key.target.origin},${draft.state.intent.generation},${draft.state.phase},${JSON.stringify(draft.state)}::text::jsonb,${draft.encryptedSecrets},${draft.secretDeadline}) RETURNING *`;
        if (!inserted[0]) throw new Error("replacement_commit_failed");
        return decode(inserted[0]);
      });
    },
    async read(handle) {
      await ready();
      return select(client, handle);
    },
    async acquire(handle, owner) {
      await ready();
      return client.begin(async (tx) => {
        const r = await select(tx, handle, true);
        if (!r) return null;
        // Serialized pre-key erasure cannot race stage or confirm authorization.
        await tx`UPDATE agent_service_link_operations SET phase='expired_unknown',state=jsonb_set(jsonb_set(state,'{phase}','"expired_unknown"'),'{nextAction}','"none"'),
          encrypted_secrets=NULL,revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=clock_timestamp()
          WHERE operation_id=${r.operationId} AND secret_deadline<=clock_timestamp() AND staged_connection_id IS NULL AND confirm_authorized_at IS NULL
            AND phase IN ('start_ready','start_unknown','awaiting_consent')`;
        const leased =
          await tx`UPDATE agent_service_link_operations SET lease_owner=${owner},lease_until=clock_timestamp()+interval '30 seconds',fence=fence+1,revision=revision+1
          WHERE operation_id=${r.operationId} AND current AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
            AND phase NOT IN ('disconnected','denied','expired','expired_unknown','needs_reenroll') RETURNING *`;
        return leased[0] ? decode(leased[0]) : null;
      });
    },
    async update(g, change) {
      await ready();
      return client.begin(async (tx) => {
        const r = await locked(tx, g);
        return r ? write(tx, r, change.state, change) : null;
      });
    },
    async stage(g, envelope) {
      await ready();
      return client.begin(async (tx) => {
        const r = await locked(tx, g);
        if (
          !r ||
          r.state.phase !== "awaiting_consent" ||
          r.state.connectionId ||
          r.state.credentialId
        )
          return null;
        if (
          envelope.operationId !== r.operationId ||
          envelope.generation !== r.state.intent.generation ||
          envelope.intentDigest !== r.state.intentDigest ||
          canonicalJson(envelope.home) !== canonicalJson(g.key.home) ||
          canonicalJson(envelope.target) !== canonicalJson(g.key.target) ||
          envelope.service !== g.key.service ||
          envelope.scope !== r.state.intent.scopes[0] ||
          envelope.enrollmentId !== r.state.enrollmentId ||
          envelope.principalUserId !== r.state.principalUserId
        )
          throw new Error("stage_binding_mismatch");
        const deadline =
          await tx`SELECT 1 FROM agent_service_link_operations WHERE operation_id=${r.operationId} AND staged_connection_id IS NULL
          AND confirm_authorized_at IS NULL AND secret_deadline>clock_timestamp() AND ${envelope.pendingExpiresAt}::timestamptz>clock_timestamp()`;
        if (!deadline.length) return null;
        const connectionId = await deterministicId(
          r.operationId,
          envelope.credentialId
        );
        const encrypted = await cipher.seal(
          envelope.token,
          custodyAad(g.key, r.operationId, connectionId)
        );
        await tx`INSERT INTO connections(id,billing_account_id,provider,credential_type,encrypted_credentials,encryption_key_id,scopes,created_by_user_id,
          service_key_digest,service_identity,service_operation_id,service_generation,service_credential_id,service_state,expires_at,renew_until)
          VALUES(${connectionId},${g.key.billingAccountId},'cogni-node','api_key',${encrypted},${cipher.keyId},ARRAY[${envelope.scope}],${systemPrincipalUserId},
            ${await connectionKeyDigest(g.key)},${JSON.stringify(g.key)}::text::jsonb,${r.operationId},${envelope.generation},${envelope.credentialId},'staged',${envelope.expiresAt},${envelope.renewUntil})
          ON CONFLICT (id) DO NOTHING`;
        const saved =
          await tx`SELECT encrypted_credentials FROM connections WHERE id=${connectionId} AND service_identity=${JSON.stringify(g.key)}::text::jsonb
          AND service_operation_id=${r.operationId} AND service_credential_id=${envelope.credentialId} AND service_state='staged'`;
        if (
          !saved[0] ||
          (await cipher.open(
            saved[0].encrypted_credentials as Uint8Array,
            custodyAad(g.key, r.operationId, connectionId)
          )) !== envelope.token
        )
          throw new Error("stage_custody_conflict");
        // Lost confirmation can activate as late as pendingExpiresAt; retain through that maximum44-day validity plus clock margin.
        const retention = new Date(
          Date.parse(envelope.pendingExpiresAt) + 44 * 86400000 + 60000
        ).toISOString();
        await tx`UPDATE agent_service_link_operations SET staged_connection_id=${connectionId},secret_deadline=${retention} WHERE operation_id=${r.operationId}`;
        return writeCustody(
          tx,
          r,
          {
            ...r.state,
            phase: "key_staged",
            nextAction: "confirm",
            connectionId,
            credentialId: envelope.credentialId,
            pendingExpiresAt: envelope.pendingExpiresAt,
            expiresAt: envelope.expiresAt,
            renewUntil: envelope.renewUntil,
            attempts: 0,
            error: null,
          },
          { encryptedSecrets: null, release: true }
        );
      });
    },
    async publish(g, deadlines) {
      await ready();
      return client.begin(async (tx) => {
        const r = await locked(tx, g);
        if (
          !r ||
          r.state.phase !== "confirm_unknown" ||
          !r.state.connectionId ||
          !r.state.credentialId
        )
          return null;
        const p =
          await tx`UPDATE connections SET service_state='ready',expires_at=${deadlines.expiresAt},renew_until=${deadlines.renewUntil}
          WHERE id=${r.state.connectionId} AND provider='cogni-node' AND service_identity=${JSON.stringify(g.key)}::text::jsonb AND billing_account_id=${g.key.billingAccountId}
            AND service_operation_id=${r.operationId} AND service_credential_id=${r.state.credentialId} AND service_state IN ('staged','ready')
            AND ${deadlines.expiresAt}::timestamptz>clock_timestamp() AND ${deadlines.renewUntil}::timestamptz<=${deadlines.expiresAt}::timestamptz+interval '14 days'
            AND ${deadlines.expiresAt}::timestamptz<=clock_timestamp()+interval '30 days' RETURNING id`;
        if (!p.length) return null;
        await tx`UPDATE agent_service_link_operations SET secret_deadline=${deadlines.renewUntil}::timestamptz+interval '60 seconds' WHERE operation_id=${r.operationId}`;
        return writeCustody(
          tx,
          r,
          {
            ...r.state,
            ...deadlines,
            phase: "connected",
            nextAction: "none",
            quarantined: false,
            attempts: 0,
            paused: false,
            error: null,
          },
          { encryptedSecrets: null, release: true }
        );
      });
    },
    async disconnect(handle, expectedRevision) {
      await ready();
      return client.begin(async (tx) => {
        const r = await select(tx, handle, true);
        if (!r || r.revision !== expectedRevision) return null;
        await disable(tx, r);
        const result =
          await tx`UPDATE agent_service_link_operations SET phase='disconnected',state=${JSON.stringify({ ...r.state, phase: "disconnected", nextAction: "none" })}::text::jsonb,
          revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE operation_id=${r.operationId} RETURNING *`;
        return result[0] ? decode(result[0]) : null;
      });
    },
    async keyRejected(handle, expected) {
      await ready();
      return client.begin(async (tx) => {
        const r = await select(tx, handle, true);
        if (
          !r ||
          r.state.phase !== "connected" ||
          r.state.connectionId !== expected.connectionId ||
          r.state.credentialId !== expected.credentialId
        )
          return false;
        await disable(tx, r);
        await tx`UPDATE agent_service_link_operations SET phase='needs_reenroll',state=${JSON.stringify({ ...r.state, phase: "needs_reenroll", nextAction: "none", error: "key_rejected" })}::text::jsonb,
          revision=revision+1,fence=fence+1,lease_owner=NULL,lease_until=NULL,terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE operation_id=${r.operationId}`;
        return true;
      });
    },
  };
  async function readKey(
    input: LinkHandle & { connectionId: string; credentialId: string },
    g?: LeaseGuard
  ): Promise<string | null> {
    await ready();
    return client.begin(async (tx) => {
      const r = g ? await locked(tx, g) : await select(tx, input, true);
      if (
        !r ||
        r.state.connectionId !== input.connectionId ||
        r.state.credentialId !== input.credentialId ||
        (g
          ? r.state.phase !== "confirm_unknown"
          : r.state.phase !== "connected")
      )
        return null;
      if (!g) {
        const ready = await options.readReadyConnection(input);
        if (!ready || ready.encryptionKeyId !== cipher.keyId) return null;
        return cipher.open(ready.encryptedCredentials, custodyAad(input.key, input.operationId, input.connectionId));
      }
      const c =
        await tx`SELECT encrypted_credentials,encryption_key_id FROM connections WHERE id=${input.connectionId} AND provider='cogni-node'
        AND billing_account_id=${input.key.billingAccountId} AND service_identity=${JSON.stringify(input.key)}::text::jsonb AND service_key_digest=${await connectionKeyDigest(input.key)}
        AND service_operation_id=${input.operationId} AND service_credential_id=${input.credentialId} AND revoked_at IS NULL
        AND service_state=${g ? "staged" : "ready"} AND (CASE WHEN ${Boolean(g)} THEN TRUE ELSE expires_at>clock_timestamp() END)`;
      if (!c[0] || c[0].encryption_key_id !== cipher.keyId) return null;
      return cipher.open(
        c[0].encrypted_credentials as Uint8Array,
        custodyAad(input.key, input.operationId, input.connectionId)
      );
    });
  }
  return {
    store,
    vault: {
      readStaged: (g, connectionId, credentialId) =>
        readKey({ ...g, connectionId, credentialId }, g),
      resolveServiceConnection: (input) => readKey(input),
    },
  };
}
