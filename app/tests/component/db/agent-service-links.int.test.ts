// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real migration/locks/custody/crash fixtures. CI only; no local SQL prerequisite. */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  createPostgresAgentGrantsStore,
  grantRole,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  agentRolesHasRoles,
  type CredentialSql,
  confirmCredential,
  credentialHttp,
  assertV1NotSuperseded,
  verifyBearer,
  createPostgresCredentialStore,
  hashAgentKey,
  formatRevocableKey,
} from "@cogni/agent-grants/credentials";
import { runDurableEnrollmentConformance } from "@cogni/agent-grants/durable-enrollment-conformance";
import {
  createDurableProviderStore,
  maintenanceTick,
  maintainEnrollmentDelivery,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  type EnrollmentIntent,
  fullServiceKey,
  intentDigestOf,
  intentOf,
  canonicalJson,
  openSealed,
} from "@cogni/agent-grants/enrollment";
import {
  type ConnectionKey,
  createCustodyCipher,
  createEnrollmentProofSigner,
  createEnrollmentRequester,
  createEnrollmentTransport,
  createPostgresRequesterCustody,
  requesterMaintenanceTick,
  maintainRequesterCustody,
} from "@cogni/agent-grants/enrollment-requester";
import { EnrollmentClientError } from "@cogni/agent-grants/enrollment-client";
import {
  COGNI_SYSTEM_BILLING_ACCOUNT_ID,
  COGNI_SYSTEM_PRINCIPAL_USER_ID,
} from "@cogni/node-shared";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { exportJWK, generateKeyPair } from "jose";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const home = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  environment: "candidate-a",
  origin: "https://home.example",
};
const target = {
  nodeId: "22222222-2222-4222-8222-222222222222",
  environment: "candidate-a",
  origin: "https://target.example",
};
const key: ConnectionKey = {
  home,
  target,
  service: "node-ai",
  billingAccountId: COGNI_SYSTEM_BILLING_ACCOUNT_ID,
};
const discoveryFetch: typeof fetch = async () => Response.json({ nodeId: target.nodeId, serviceEnrollment: {
  protocol: ENROLLMENT_PROTOCOL, receiver: target, credentialCeilings: { ttlSec: 2592000, renewWindowSec: 1209600, pendingSec: 900 },
} });

let container: StartedPostgreSqlContainer, db: Sql, second: Sql;
const client = () => db as unknown as CredentialSql;
const creds = () =>
  createPostgresCredentialStore(client(), {
    hasRoles: agentRolesHasRoles(client()),
  });
const provider = () => createDurableProviderStore(client());
async function proofAt(now = Date.now(), ttl = 600) {
  const pair = await generateKeyPair("ECDH-ES", {
      crv: "X25519",
      extractable: true,
    }),
    pub = await exportJWK(pair.publicKey);
  const jti = randomUUID(),
    iat = Math.floor(now / 1000);
  const intent: EnrollmentIntent = {
    kind: ENROLLMENT_PROTOCOL,
    operationId: randomUUID(),
    generation: 1,
    expectedGeneration: 0,
    expectedOperationId: null,
    home,
    target,
    service: "node-ai",
    scopes: ["knowledge:read"],
    cnf: {
      jwk: { kty: "OKP" as const, crv: "X25519" as const, x: pub.x as string },
    },
    originalStartJti: jti,
    originalStartIat: iat,
    originalStartExp: iat + ttl,
  };
  return {
    proof: {
      ...intent,
      op: "start" as const,
      intentDigest: await intentDigestOf(intent),
      iss: home.origin,
      aud: `urn:cogni:node:${target.nodeId}`,
      iat,
      exp: iat + ttl,
      jti,
    } as EnrollmentProof,
    privateJwk: await exportJWK(pair.privateKey),
  };
}
async function inspect() {
  const r =
    await db`SELECT (SELECT count(*)::int FROM agent_service_enrollments WHERE operation_id IS NOT NULL) AS operations,
    (SELECT count(*)::int FROM agent_principals WHERE home_node_id IS NOT NULL) AS principals,
    (SELECT count(*)::int FROM agent_roles WHERE enrollment_operation_id IS NOT NULL) AS asks,
    (SELECT count(*)::int FROM agent_credentials WHERE service_operation_id IS NOT NULL) AS credentials,
    (SELECT min(granted_at)::text FROM agent_roles WHERE enrollment_operation_id IS NOT NULL) AS approval_at`;
  return {
    operations: Number(r[0]?.operations),
    principals: Number(r[0]?.principals),
    asks: Number(r[0]?.asks),
    credentials: Number(r[0]?.credentials),
    approvalAt: r[0]?.approval_at ?? null,
  };
}

describe("v2 enrollment and requester SQL", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    await promisify(execFile)(
      process.execPath,
      [
        resolve("../scripts/db/migrate.mjs"),
        resolve("src/adapters/server/db/migrations"),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: container.getConnectionUri(),
          NODE_NAME: "requester-v2-ci",
        },
        timeout: 90000,
      }
    );
    db = postgres(container.getConnectionUri(), { max: 8 });
    second = postgres(container.getConnectionUri(), { max: 2 });
  }, 90000);
  beforeEach(async () => {
    // An isolated migrated database; no sibling test's node-wide admission/counters can race these fixtures.
    await db`TRUNCATE agent_service_link_operations, agent_service_quotas, agent_service_enrollments, agent_credentials, agent_roles CASCADE`;
    await db`DELETE FROM agent_principals WHERE service_key IS NOT NULL`;
    await db`DELETE FROM connections WHERE provider='cogni-node'`;
    await db`UPDATE agent_authority_maintenance SET oldest_due_at=NULL,next_run_at=clock_timestamp(),purge_enabled=false,minimum_reader_build=NULL,audit_cursors='{}'::jsonb WHERE id='service-enrollment'`;
  });
  afterAll(async () => {
    await db?.end({ timeout: 1 });
    await second?.end({ timeout: 1 });
    await container?.stop();
  });
  runDurableEnrollmentConformance({
    describe,
    it,
    expect,
    async setup() {
      const { proof, privateJwk } = await proofAt(),
        tokenDigest = await hashAgentKey(randomUUID()),
        admin = randomUUID();
      await db`INSERT INTO users(id,name) VALUES(${admin},'fixture DAO admin')`;
      const grants = createPostgresAgentGrantsStore(db as unknown as SqlTag);
      return {
        store: provider(),
        proof,
        privateJwk,
        tokenDigest,
        inspect,
        approve: async (principalUserId: string) => {
          await grants.approvePending({
            principalUserId,
            scope: "knowledge:read",
            approvedBy: admin,
          });
        },
        confirm: async (credentialId: string) => {
          const r = await confirmCredential(creds(), { credentialId });
          if (!r.ok) throw new Error(r.reason);
        },
        revoke: async (credentialId: string) => {
          const r =
            await db`SELECT user_id FROM agent_credentials WHERE id=${credentialId}`;
          await creds().revoke({
            credentialId,
            userId: String(r[0]?.user_id),
            reason: "fixture",
            revokedBy: admin,
          });
        },
      };
    },
  });

  it("a start queued behind the service lock rechecks proof expiry; post-expiry404 cannot become creation", async () => {
    const { proof } = await proofAt(Date.now(), 2),
      digest = await hashAgentKey("exact-original"),
      marker = await fullServiceKey(home, "node-ai");
    let release!: () => void, held!: () => void;
    const acquired = new Promise<void>((r) => {
      held = r;
    });
    const holder = second.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`service:${marker}`}))`;
      held();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await acquired;
    const delayed = provider().acceptProof(proof, digest);
    // DB wall time crosses the original exp while the writer is queued. No local sleep/deployment dependency.
    await db`SELECT pg_sleep(GREATEST(0,${proof.exp}-extract(epoch FROM clock_timestamp()))+0.05)`;
    release();
    await holder;
    expect(await delayed).toMatchObject({ ok: false, reason: "invalid_token" });
    const at = Math.floor(Date.now() / 1000),
      continuation = {
        ...proof,
        op: "continue" as const,
        originalTokenDigest: digest,
        jti: randomUUID(),
        iat: at,
        exp: at + 600,
      };
    expect(
      await provider().acceptProof(continuation, "0".repeat(64))
    ).toMatchObject({ ok: false, reason: "unknown_operation" });
    expect((await inspect()).operations).toBe(0);
  });

  it("real custody keeps exact encrypted intent across process reconstruction and fence takeover", async () => {
    const cipher = createCustodyCipher(
        new Uint8Array(32).fill(8),
        "fixture-v2"
      ),
      signing = await generateKeyPair("EdDSA");
    const signer = createEnrollmentProofSigner({
      kid: "fixture",
      key: signing.privateKey,
    });
    const custody = () =>
      createPostgresRequesterCustody(client(), {
        cipher,
        systemPrincipalUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
        readReadyConnection: async () => null,
      });
    const transport = {
      postProof: async () => {
        throw new Error("injected lost response");
      },
      pollToken: async () => ({ kind: "authorization_pending" as const }),
      confirmStaged: async () => ({ status: 503 }),
    };
    const first = custody(),
      r = createEnrollmentRequester({ ...first, cipher, signer, transport, fetch: discoveryFetch });
    const [a, b] = await Promise.all([r.ensure(key), r.ensure(key)]);
    expect(a.linkId).toBe(b.linkId);
    const h = { operationId: a.linkId, key },
      original = (await first.store.read(h))?.encryptedSecrets;
    await r.advance(h);
    const reconstructed = custody();
    expect((await reconstructed.store.read(h))?.encryptedSecrets).toBe(
      original
    );
    await db`UPDATE agent_service_link_operations SET lease_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE operation_id=${a.linkId}`;
    const old = await reconstructed.store.acquire(h, randomUUID());
    if (!old?.leaseOwner) throw new Error("fixture lease");
    await db`UPDATE agent_service_link_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE operation_id=${a.linkId}`;
    const newer = await reconstructed.store.acquire(h, randomUUID());
    expect(newer?.fence).toBeGreaterThan(old.fence);
    expect(
      await reconstructed.store.update(
        {
          operationId: a.linkId,
          key,
          revision: old.revision,
          fence: old.fence,
          leaseOwner: old.leaseOwner,
        },
        { state: { ...old.state, phase: "connected" } }
      )
    ).toBeNull();
    expect((await reconstructed.store.read(h))?.encryptedSecrets).toBe(
      original
    );
  });
  it("explicit never-accepted replacement preserves local fences and the real target initial CAS", async () => {
    const cipher = createCustodyCipher(new Uint8Array(32).fill(8), "fixture-v2");
    const signing = await generateKeyPair("EdDSA");
    const custody = createPostgresRequesterCustody(client(), {
      cipher, systemPrincipalUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID, readReadyConnection: async () => null,
    });
    let clock = Date.now() - 11 * 60000;
    const requester = createEnrollmentRequester({ ...custody, cipher, fetch: discoveryFetch,
      now: () => new Date(clock), signer: createEnrollmentProofSigner({ kid: "fixture", key: signing.privateKey }),
      transport: {
        postProof: async () => { throw new EnrollmentClientError("enrollment_rejected", 404, new Date().toISOString(), "unknown_operation"); },
        pollToken: async () => ({ kind: "authorization_pending" as const }), confirmStaged: async () => ({ status: 503 }),
      },
    });
    const first = await requester.ensure(key), oldHandle = { operationId: first.linkId, key };
    clock = Date.now();
    expect((await requester.advance(oldHandle)).phase).toBe("expired_unknown");
    const old = await custody.store.read(oldHandle);
    if (!old) throw new Error("missing expired intent");
    expect(old.encryptedSecrets).toBeNull();
    expect(old.state.nonacceptanceObservedAt).toBeTruthy();
    expect(Date.parse(old.secretDeadline)).toBeGreaterThan(Date.now()); // Definitive evidence, not the24h fallback.
    const next = await requester.reenroll(oldHandle, old.revision);
    const replacement = await custody.store.read({ operationId: next.linkId, key });
    if (!replacement) throw new Error("missing replacement");
    expect(replacement.state.intent).toMatchObject({ generation: 1, expectedGeneration: 0, expectedOperationId: null });
    const current = await db`SELECT operation_id,current,fence FROM agent_service_link_operations ORDER BY current`;
    expect(current.map(r => [r.operation_id, r.current])).toEqual([[first.linkId, false], [next.linkId, true]]);
    expect(Number(current[0]?.fence)).toBeGreaterThan(old.fence);
    expect(await custody.store.acquire(oldHandle, randomUUID())).toBeNull();
    const baseline = (await proofAt()).proof;
    const proof = { ...baseline, ...replacement.state.intent, intentDigest: replacement.state.intentDigest,
      jti: replacement.state.intent.originalStartJti, iat: replacement.state.intent.originalStartIat, exp: replacement.state.intent.originalStartExp };
    expect(await provider().acceptProof(proof, "f".repeat(64))).toMatchObject({ ok: true });
  });

  it("publication rolls back ready custody when a connection lock outlives the lease", async () => {
    const cipher = createCustodyCipher(new Uint8Array(32).fill(8), "fixture-v2");
    const signing = await generateKeyPair("EdDSA");
    const custody = createPostgresRequesterCustody(client(), {
      cipher, systemPrincipalUserId: COGNI_SYSTEM_PRINCIPAL_USER_ID,
      readReadyConnection: async () => null,
    });
    const requester = createEnrollmentRequester({
      ...custody, cipher, fetch: discoveryFetch, signer: createEnrollmentProofSigner({ kid: "fixture", key: signing.privateKey }),
      transport: {
        postProof: async () => { throw new Error("unused"); },
        pollToken: async () => ({ kind: "authorization_pending" as const }),
        confirmStaged: async () => ({ status: 503 }),
      },
    });
    const view = await requester.ensure(key);
    const handle = { operationId: view.linkId, key };
    const row = await custody.store.read(handle);
    if (!row) throw new Error("missing operation");
    const connectionId = randomUUID(), credentialId = randomUUID();
    await db`INSERT INTO connections(id,billing_account_id,provider,credential_type,encrypted_credentials,encryption_key_id,scopes,created_by_user_id,service_identity,service_operation_id,service_credential_id,service_state)
      VALUES(${connectionId},${key.billingAccountId},'cogni-node','api_key',${Buffer.from('ciphertext')},'fixture-v2',ARRAY['knowledge:read'],${COGNI_SYSTEM_PRINCIPAL_USER_ID},${JSON.stringify(key)}::text::jsonb,${handle.operationId},${credentialId},'staged')`;
    const state = { ...row.state, phase: "confirm_unknown", nextAction: "confirm", connectionId, credentialId };
    await db`UPDATE agent_service_link_operations SET phase='confirm_unknown',state=${JSON.stringify(state)}::text::jsonb,staged_connection_id=${connectionId},confirm_authorized_at=clock_timestamp() WHERE operation_id=${handle.operationId}`;
    const lease = await custody.store.acquire(handle, randomUUID());
    if (!lease?.leaseOwner) throw new Error("missing lease");
    await db`UPDATE agent_service_link_operations SET lease_until=clock_timestamp()+interval '1 second' WHERE operation_id=${handle.operationId}`;
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => { locked = resolve; });
    const holder = second.begin(async (tx) => {
      await tx`SELECT id FROM connections WHERE id=${connectionId} FOR UPDATE`;
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await held;
    const delayed = custody.store.publish({ ...handle, revision: lease.revision, fence: lease.fence, leaseOwner: lease.leaseOwner }, {
      expiresAt: new Date(Date.now()+86400000).toISOString(), renewUntil: new Date(Date.now()+2*86400000).toISOString(),
    });
    const verdict = expect(delayed).rejects.toThrow("custody_fence_expired");
    await db`SELECT pg_sleep(1.2)`;
    release();
    await holder;
    await verdict;
    const connection = await db`SELECT service_state FROM connections WHERE id=${connectionId}`;
    expect(connection[0]?.service_state).toBe("staged");
    expect((await custody.store.read(handle))?.state.phase).toBe("confirm_unknown");
  }, 10000);

  it("Off after bearer verification is permission_off; On before pending expiry confirms the same real key", async () => {
    const {proof,privateJwk}=await proofAt(), store=provider(), result=await store.acceptProof(proof,await hashAgentKey('consent-race'));
    if (!result.ok || !result.reply.sealedAcceptance) throw new Error('missing acceptance');
    const admin=randomUUID(); await db`INSERT INTO users(id,name) VALUES(${admin},'consent admin')`;
    const grants=createPostgresAgentGrantsStore(db as unknown as SqlTag);
    await grants.approvePending({principalUserId:result.principalUserId,scope:'knowledge:read',approvedBy:admin});
    const receipt=JSON.parse(await openSealed(result.reply.sealedAcceptance,privateJwk)) as {deviceCode:string};
    const pending=await store.pollStable(await hashAgentKey(receipt.deviceCode));
    if (!pending.ok) throw new Error('missing pending key');
    const keyEnvelope=JSON.parse(await openSealed(pending.sealedKey,privateJwk)) as {token:string};
    expect(await verifyBearer(creds(),keyEnvelope.token,['pending','active'])).toMatchObject({ok:true,credentialId:pending.credentialId});
    await grants.revokeRole({principalUserId:result.principalUserId,scope:'knowledge:read'});
    const wire=createEnrollmentTransport({fetch:async () => {
      const http=credentialHttp({op:'confirm',credentialId:pending.credentialId,result:await confirmCredential(creds(),{credentialId:pending.credentialId})});
      return Response.json(http.body,{status:http.status,headers:http.headers});
    }});
    expect(await wire.confirmStaged(target.origin,keyEnvelope.token)).toEqual({status:403,refusal:'permission_off'});
    expect((await db`SELECT confirmed_at FROM agent_credentials WHERE id=${pending.credentialId}`)[0]?.confirmed_at).toBeNull();
    if (!grants.restoreRevoked) throw new Error('missing retained consent restore');
    expect(await grants.restoreRevoked({principalUserId:result.principalUserId,scope:'knowledge:read',approvedBy:admin})).toBe(true);
    expect(await wire.confirmStaged(target.origin,keyEnvelope.token)).toMatchObject({status:200,credentialId:pending.credentialId,observedAt:expect.any(String)});
    expect(await verifyBearer(creds(),keyEnvelope.token,['active'])).toMatchObject({ok:true,credentialId:pending.credentialId});
  });

  it.each(['expired','revoked'] as const)('a %s winner between bearer verification and confirmation keeps its typed race result', async winner => {
    const {proof,privateJwk}=await proofAt(), store=provider(), result=await store.acceptProof(proof,await hashAgentKey('confirm-race'));
    if (!result.ok || !result.reply.sealedAcceptance) throw new Error('missing acceptance');
    const admin=randomUUID(); await db`INSERT INTO users(id,name) VALUES(${admin},'race admin')`;
    await createPostgresAgentGrantsStore(db as unknown as SqlTag).approvePending({principalUserId:result.principalUserId,scope:'knowledge:read',approvedBy:admin});
    const receipt=JSON.parse(await openSealed(result.reply.sealedAcceptance,privateJwk)) as {deviceCode:string};
    const pending=await store.pollStable(await hashAgentKey(receipt.deviceCode));
    if (!pending.ok) throw new Error('missing pending key');
    const envelope=JSON.parse(await openSealed(pending.sealedKey,privateJwk)) as {token:string};
    expect(await verifyBearer(creds(),envelope.token,['pending','active'])).toMatchObject({ok:true});
    if (winner==='expired') await db`UPDATE agent_credentials SET pending_expires_at=clock_timestamp()-interval '1 second' WHERE id=${pending.credentialId}`;
    else await creds().revoke({credentialId:pending.credentialId,userId:result.principalUserId,reason:'fixture',revokedBy:admin});
    const confirmed=await confirmCredential(creds(),{credentialId:pending.credentialId});
    expect(confirmed).toEqual({ok:false,reason:winner});
    expect(credentialHttp({op:'confirm',credentialId:pending.credentialId,result:confirmed})).toMatchObject({status:409,body:{error:winner==='expired'?'pending_expired':'superseded'}});
  });

  it.each([false,true])('home SQL publication uses receiver time at maximum lifetime (oversized=%s)', async oversized => {
    const cipher=createCustodyCipher(new Uint8Array(32).fill(8),'fixture-v2'), signing=await generateKeyPair('EdDSA');
    const custody=createPostgresRequesterCustody(client(),{cipher,systemPrincipalUserId:COGNI_SYSTEM_PRINCIPAL_USER_ID,readReadyConnection:async()=>null});
    const requester=createEnrollmentRequester({...custody,cipher,fetch:discoveryFetch,signer:createEnrollmentProofSigner({kid:'fixture',key:signing.privateKey}),
      transport:{postProof:async()=>{throw new Error('unused');},pollToken:async()=>({kind:'authorization_pending' as const}),confirmStaged:async()=>({status:503})}});
    const view=await requester.ensure(key), handle={operationId:view.linkId,key}, row=await custody.store.read(handle);
    if (!row) throw new Error('missing intent');
    const connectionId=randomUUID(),credentialId=randomUUID(),ciphertext=Buffer.from('retained-staged-custody');
    await db`INSERT INTO connections(id,billing_account_id,provider,credential_type,encrypted_credentials,encryption_key_id,scopes,created_by_user_id,service_identity,service_operation_id,service_credential_id,service_state)
      VALUES(${connectionId},${key.billingAccountId},'cogni-node','api_key',${ciphertext},'fixture-v2',ARRAY['knowledge:read'],${COGNI_SYSTEM_PRINCIPAL_USER_ID},${JSON.stringify(key)}::text::jsonb,${view.linkId},${credentialId},'staged')`;
    await db`UPDATE agent_service_link_operations SET phase='confirm_unknown',state=${JSON.stringify({...row.state,phase:'confirm_unknown',nextAction:'confirm',connectionId,credentialId})}::text::jsonb,
      staged_connection_id=${connectionId},confirm_authorized_at=clock_timestamp() WHERE operation_id=${view.linkId}`;
    const lease=await custody.store.acquire(handle,randomUUID()); if (!lease?.leaseOwner) throw new Error('missing lease');
    const native=await db`SELECT clock_timestamp() AS at`, observedAt=new Date(new Date(native[0]?.at as string).getTime()+10000).toISOString();
    const expiresAt=new Date(Date.parse(observedAt)+(oversized?31:30)*86400000).toISOString(),renewUntil=new Date(Date.parse(expiresAt)+14*86400000).toISOString();
    const published=await custody.store.publish({...handle,revision:lease.revision,fence:lease.fence,leaseOwner:lease.leaseOwner},{expiresAt,renewUntil,observedAt});
    if (oversized) expect(published).toBeNull(); else expect(published?.state.phase).toBe('connected');
    const connection=await db`SELECT encrypted_credentials,service_state FROM connections WHERE id=${connectionId}`;
    expect(connection[0]?.service_state).toBe(oversized?'staged':'ready');
    expect(Buffer.from(connection[0]?.encrypted_credentials as Uint8Array)).toEqual(ciphertext);
  });

  it("authenticated terminal evidence fences real staged custody without erasing or publishing it", async () => {
    const cipher=createCustodyCipher(new Uint8Array(32).fill(8),'fixture-v2'), signing=await generateKeyPair('EdDSA');
    const custody=createPostgresRequesterCustody(client(),{cipher,systemPrincipalUserId:COGNI_SYSTEM_PRINCIPAL_USER_ID,readReadyConnection:async()=>null});
    const requester=createEnrollmentRequester({...custody,cipher,fetch:discoveryFetch,signer:createEnrollmentProofSigner({kid:'fixture',key:signing.privateKey}),
      transport:{postProof:async()=>{throw new Error('unused');},pollToken:async()=>({kind:'authorization_pending' as const}),confirmStaged:async()=>({status:503})}});
    const first=await requester.ensure(key), h={operationId:first.linkId,key}, row=await custody.store.read(h);
    if (!row) throw new Error('missing intent');
    const connectionId=randomUUID(),credentialId=randomUUID(),ciphertext=Buffer.from('retained-terminal-stage');
    await db`INSERT INTO connections(id,billing_account_id,provider,credential_type,encrypted_credentials,encryption_key_id,scopes,created_by_user_id,service_identity,service_operation_id,service_credential_id,service_state)
      VALUES(${connectionId},${key.billingAccountId},'cogni-node','api_key',${ciphertext},'fixture-v2',ARRAY['knowledge:read'],${COGNI_SYSTEM_PRINCIPAL_USER_ID},${JSON.stringify(key)}::text::jsonb,${first.linkId},${credentialId},'staged')`;
    await db`UPDATE agent_service_link_operations SET phase='confirm_unknown',state=${JSON.stringify({...row.state,phase:'confirm_unknown',nextAction:'continue',connectionId,credentialId})}::text::jsonb,
      staged_connection_id=${connectionId},confirm_authorized_at=clock_timestamp(),secret_deadline=clock_timestamp()+interval '44 days' WHERE operation_id=${first.linkId}`;
    const lease=await custody.store.acquire(h,randomUUID()); if (!lease?.leaseOwner) throw new Error('missing lease');
    const guard={...h,revision:lease.revision,fence:lease.fence,leaseOwner:lease.leaseOwner};
    const terminal=await custody.store.update(guard,{state:{...lease.state,phase:'needs_reenroll',nextAction:'none',terminalObservedAt:new Date().toISOString()},release:true});
    expect(terminal?.fence).toBeGreaterThan(lease.fence);
    expect(terminal?.secretDeadline).toBe(lease.secretDeadline);
    expect(await custody.store.publish(guard,{expiresAt:new Date(Date.now()+86400000).toISOString(),renewUntil:new Date(Date.now()+2*86400000).toISOString()})).toBeNull();
    expect(await custody.store.acquire(h,randomUUID())).toBeNull();
    expect((await db`SELECT encrypted_credentials,service_state FROM connections WHERE id=${connectionId}`)[0])
      .toMatchObject({encrypted_credentials:ciphertext,service_state:'staged'});
  });

  it("v2 service-bound alternate origins cannot first-activate outside receipt eligibility", async () => {
    const { proof } = await proofAt(Date.now() - 2 * 86400000);
    const user = randomUUID();
    await db`INSERT INTO users(id,name) VALUES(${user},'retained service')`;
    await db`INSERT INTO agent_principals(kind,user_id,service_key,current_operation_id,current_generation)
      VALUES('external',${user},${await fullServiceKey(home,'node-ai')},${proof.operationId},1)`;
    await db`INSERT INTO agent_service_enrollments(jti,issuer,service,principal_user_id,scope,device_code_hash,cnf_jwk,
      expires_at,status,operation_id,generation,original_start_iat,original_start_exp,original_token_digest,intent_digest,canonical_intent,created_at)
      VALUES(${proof.jti},${home.origin},'node-ai',${user},'knowledge:read',${randomUUID()},${JSON.stringify(proof.cnf.jwk)}::text::jsonb,
        clock_timestamp()-interval '1 day','expired',${proof.operationId},1,to_timestamp(${proof.originalStartIat}),to_timestamp(${proof.originalStartExp}),
        ${'a'.repeat(64)},${proof.intentDigest},${canonicalJson(intentOf(proof))},clock_timestamp()-interval '2 days')`;
    for (const origin of ['key_upgrade','spawn_grant','binding_recovery','recovery_grant']) {
      const rows = await db`INSERT INTO agent_credentials(user_id,token_hash,created_from,service_operation_id,service_generation,
        pending_expires_at,expires_at,renew_until) VALUES(${user},${randomUUID()},${origin},${proof.operationId},1,
        clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days') RETURNING id`;
      await expect(db`UPDATE agent_credentials SET confirmed_at=clock_timestamp() WHERE id=${rows[0]?.id}`)
        .rejects.toThrow('unsupported service activation origin');
      await expect(db`INSERT INTO agent_credentials(user_id,token_hash,created_from,service_operation_id,service_generation,
        pending_expires_at,expires_at,renew_until,confirmed_at) VALUES(${user},${randomUUID()},${origin},${proof.operationId},1,
        clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',clock_timestamp())`)
        .rejects.toThrow('unsupported service activation origin');
    }
    expect((await db`SELECT id FROM agent_credentials WHERE user_id=${user} AND confirmed_at IS NOT NULL`)).toHaveLength(0);
    expect(await readFile(resolve('../packages/agent-grants/migrations/agent_service_enrollment_review_guards.sql'),'utf8'))
      .toBe(await readFile(resolve('src/adapters/server/db/migrations/0048_service_enrollment_review_guards.sql'),'utf8'));
  });

  it("Dismiss commits terminal denial before the caller returns; continuation, capacity and replacement agree", async () => {
    const { proof, privateJwk } = await proofAt(), digest = await hashAgentKey('dismiss-start');
    const store = provider(), accepted = await store.acceptProof(proof,digest);
    if (!accepted.ok || !accepted.reply.sealedAcceptance) throw new Error('missing acceptance');
    const receipt = JSON.parse(await openSealed(accepted.reply.sealedAcceptance,privateJwk)) as {deviceCode:string};
    const grants = createPostgresAgentGrantsStore(db as unknown as SqlTag);
    expect(await grants.denyPending({principalUserId:accepted.principalUserId,scope:'knowledge:read'})).toBe(true);
    const denied = await db`SELECT status,terminal_at FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`;
    expect(denied[0]?.status).toBe('denied'); expect(denied[0]?.terminal_at).not.toBeNull();
    expect((await db`SELECT id FROM agent_service_enrollments WHERE status='open' AND expires_at>clock_timestamp()`)).toHaveLength(0);
    expect(await store.pollStable(await hashAgentKey(receipt.deviceCode))).toEqual({ok:false,error:'access_denied'});
    expect(await store.acceptProof({...proof,op:'continue',originalTokenDigest:digest},'0'.repeat(64)))
      .toMatchObject({ok:false,reason:'terminal_operation'});
    const replacement = {...(await proofAt()).proof,generation:2,expectedGeneration:1,expectedOperationId:proof.operationId};
    replacement.intentDigest = await intentDigestOf(intentOf(replacement));
    expect(await store.acceptProof(replacement,await hashAgentKey('replacement-after-dismiss')))
      .toMatchObject({ok:true,principalUserId:accepted.principalUserId,principalCreated:false});
    expect((await db`SELECT id FROM agent_service_enrollments WHERE status='open' AND expires_at>clock_timestamp()`)).toHaveLength(1);
    const history = await db`SELECT approved_by,revoked_at FROM agent_roles WHERE enrollment_operation_id=${proof.operationId}`;
    expect(history[0]?.approved_by).toBeNull(); expect(history[0]?.revoked_at).not.toBeNull();
  });

  it.each(['dismiss','approve'] as const)('%s wins the real two-session Dismiss/approval race at the user authority boundary', async winner => {
    const {proof}=await proofAt(), accepted=await provider().acceptProof(proof,await hashAgentKey('denial-race'));
    if (!accepted.ok) throw new Error('missing acceptance');
    const user=accepted.principalUserId, admin=randomUUID(); await db`INSERT INTO users(id,name) VALUES(${admin},'race admin')`;
    let locked!:()=>void,release!:()=>void,entered!:()=>void,waitingPid=0;
    const held=new Promise<void>(resolve=>{locked=resolve;}), go=new Promise<void>(resolve=>{release=resolve;}), queued=new Promise<void>(resolve=>{entered=resolve;});
    const first=db.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext(${user}))`;
      await tx`SELECT user_id FROM agent_principals WHERE user_id=${user} FOR UPDATE`;
      locked(); await go;
      const grants=createPostgresAgentGrantsStore(tx as unknown as SqlTag);
      return winner==='dismiss' ? grants.denyPending({principalUserId:user,scope:'knowledge:read'}) :
        grants.approvePending({principalUserId:user,scope:'knowledge:read',approvedBy:admin});
    });
    await held;
    const follower=second.begin(async tx=>{
      const pid=await tx`SELECT pg_backend_pid() AS pid`; waitingPid=Number(pid[0]?.pid); entered();
      const grants=createPostgresAgentGrantsStore(tx as unknown as SqlTag);
      return winner==='dismiss' ? grants.approvePending({principalUserId:user,scope:'knowledge:read',approvedBy:admin}) :
        grants.denyPending({principalUserId:user,scope:'knowledge:read'});
    });
    let failure:unknown;
    try {
      await queued;
      let blocked=false; const deadline=Date.now()+2000;
      while (!blocked && Date.now()<deadline) {
        blocked=(await db`SELECT 1 FROM pg_locks WHERE pid=${waitingPid} AND locktype='advisory' AND NOT granted`).length>0;
      }
      expect(blocked).toBe(true); // Both sessions reached the actual serialized writer, not a timer approximation.
    } catch(error) { failure=error; } finally { release(); }
    const results=await Promise.all([first,follower]); if (failure) throw failure;
    expect(results).toEqual([true,false]);
    const receipt=await db`SELECT status,terminal_at FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`;
    const role=await db`SELECT approved_by,revoked_at FROM agent_roles WHERE enrollment_operation_id=${proof.operationId}`;
    expect(receipt[0]?.status).toBe(winner==='dismiss'?'denied':'open');
    if (winner==='dismiss') {
      expect(receipt[0]?.terminal_at).not.toBeNull(); expect(role[0]?.approved_by).toBeNull(); expect(role[0]?.revoked_at).not.toBeNull();
    } else {
      expect(receipt[0]?.terminal_at).toBeNull(); expect(role[0]?.approved_by).toBe(admin); expect(role[0]?.revoked_at).toBeNull();
    }
  },10000);

  it("replacement proves absence by indexed live ranges despite ten thousand expired unrevoked credentials", async () => {
    const user = randomUUID();
    await db`INSERT INTO users(id,name) VALUES(${user},'retained audit')`;
    await db`INSERT INTO agent_principals(kind,user_id) VALUES('external',${user})`;
    // Ordinary guarded writes create confirmed history, then shorten its validity; no trigger/authority bypass.
    await db`INSERT INTO agent_credentials(user_id,token_hash,created_from,pending_expires_at,expires_at,renew_until,confirmed_at)
      SELECT ${user},'confirmed-audit-'||n,'key_upgrade',clock_timestamp()+interval '5 minutes',
        clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',clock_timestamp() FROM generate_series(1,5000) n`;
    await db`UPDATE agent_credentials SET expires_at=clock_timestamp()-interval '2 days',renew_until=clock_timestamp()-interval '1 day' WHERE user_id=${user}`;
    await db`INSERT INTO agent_credentials(user_id,token_hash,created_from,issued_at,pending_expires_at,expires_at,renew_until)
      SELECT ${user},'pending-audit-'||n,'key_upgrade',clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days'+interval '5 minutes',
        clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 hour' FROM generate_series(1,5000) n`;
    const marker = await fullServiceKey(home,'node-ai');
    await db`UPDATE agent_principals SET service_key=${marker},home_node_id=${home.nodeId},home_environment=${home.environment},home_origin=${home.origin},home_service='node-ai' WHERE user_id=${user}`;
    const {proof} = await proofAt(), store = provider();
    const first = await store.acceptProof(proof,await hashAgentKey('audit-first'));
    if (!first.ok) throw new Error('missing first operation');
    await createPostgresAgentGrantsStore(db as unknown as SqlTag).denyPending({principalUserId:user,scope:'knowledge:read'});
    // Remove only MVCC versions from seeding; all ten thousand retained audit rows remain.
    await db.unsafe('VACUUM (ANALYZE) agent_credentials');
    const probes: {query:string;values:string[]}[] = [];
    // Record the actual production queries and parameters while every call still executes against PostgreSQL.
    const recording = Object.assign(((strings,...values) => client()(strings,...values)) as SqlTag, {
      begin: <T>(fn:(tx:SqlTag)=>Promise<T>) => db.begin(async tx => {
        const tag: SqlTag = (strings,...values) => {
          if (strings.join('').includes('FROM agent_credentials WHERE user_id=') && strings.join('').includes('ORDER BY')) {
            probes.push({query:strings.reduce((q,part,n) => q+(n ? '$'+n : '')+part,''),values:values.map(value => {
              if (typeof value !== 'string') throw new Error('unexpected live-range parameter'); return value;
            })});
          }
          return (tx as unknown as SqlTag)(strings,...values);
        };
        return fn(Object.assign(tag,{savepoint:tx.savepoint.bind(tx)}));
      }),
    }) as CredentialSql;
    const replacement = {...(await proofAt()).proof,generation:2,expectedGeneration:1,expectedOperationId:proof.operationId};
    replacement.intentDigest = await intentDigestOf(intentOf(replacement));
    expect(await createDurableProviderStore(recording).acceptProof(replacement,await hashAgentKey('audit-replacement'))).toMatchObject({ok:true,principalUserId:user});
    expect(probes).toHaveLength(2); expect(probes[0]?.values[1]).toBe(probes[1]?.values[1]);
    for (const [index,probe] of probes.entries()) {
      const rows = await db.unsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+probe.query,probe.values);
      const plan = rows[0]?.['QUERY PLAN'][0].Plan;
      const text = JSON.stringify(plan);
      expect(text).toContain(index===0 ? 'agent_credentials_usable_idx' : 'agent_credentials_pending_idx');
      expect(text).toContain('Index Cond'); expect(text).not.toContain('Seq Scan');
      expect(plan['Actual Rows']).toBe(0);
      expect((plan['Shared Hit Blocks']??0)+(plan['Shared Read Blocks']??0)).toBeLessThan(64);
    }
    expect((await db`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id=${user} AND revoked_at IS NULL`)[0]?.n).toBe(10000);
  },30000);

  it("verified legacy tuple reconciliation preserves the marker, user and grant and refuses ambiguous environments", async () => {
    const { proof } = await proofAt();
    const user = randomUUID(), admin = randomUUID(), role = randomUUID();
    const marker = `${home.origin}#node-ai`;
    await db`INSERT INTO users(id,name) VALUES(${user},'legacy service'),(${admin},'legacy admin')`;
    await db`INSERT INTO agent_principals(kind,user_id,service_key) VALUES('external',${user},${marker})`;
    await db`INSERT INTO agent_roles(id,principal_user_id,scope,approved_by,granted_at) VALUES(${role},${user},'knowledge:read',${admin},clock_timestamp())`;
    await db`INSERT INTO agent_service_enrollments(jti,issuer,service,principal_user_id,scope,device_code_hash,cnf_jwk,expires_at,status)
      VALUES(${randomUUID()},${home.origin},'node-ai',${user},'knowledge:read',${randomUUID()},${JSON.stringify(proof.cnf.jwk)}::text::jsonb,clock_timestamp()-interval '1 day','expired')`;
    const legacyCredential = await db`INSERT INTO agent_credentials(user_id,token_hash,created_from,issued_at,pending_expires_at,expires_at,renew_until,confirmed_at)
      VALUES(${user},${await hashAgentKey('legacy-key')},'key_upgrade',clock_timestamp(),clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',clock_timestamp()) RETURNING id`;
    const digest = await hashAgentKey("legacy-start");
    expect(await provider().acceptProof(proof,digest)).toMatchObject({ok:false,reason:"intent_conflict"});
    const ambiguous = createDurableProviderStore(client(), { legacyHomes: [
      {home,services:['node-ai']},{home:{...home,environment:'production'},services:['node-ai']},
    ] });
    expect(await ambiguous.acceptProof(proof,digest)).toMatchObject({ok:false,reason:"intent_conflict"});
    const mapped = createDurableProviderStore(client(), {legacyHomes:[{home,services:['node-ai']}]});
    expect(await mapped.acceptProof(proof,digest)).toMatchObject({ok:true,principalUserId:user,principalCreated:false});
    expect(await creds().lookup(await hashAgentKey('legacy-key'))).toMatchObject({credentialId:legacyCredential[0]?.id,userId:user,state:'active'});
    const principal = await db`SELECT user_id,service_key,home_node_id,home_environment,home_origin,home_service,active_until FROM agent_principals WHERE user_id=${user}`;
    const horizon = await db`SELECT renew_until FROM agent_credentials WHERE id=${legacyCredential[0]?.id}`;
    expect(new Date(principal[0]?.active_until as string).getTime()).toBeGreaterThanOrEqual(new Date(horizon[0]?.renew_until as string).getTime());
    const recovery = await db`SELECT expires_at FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`;
    expect(new Date(principal[0]?.active_until as string).getTime()).toBeGreaterThan(new Date(recovery[0]?.expires_at as string).getTime());
    expect(principal[0]).toMatchObject({user_id:user,service_key:marker,home_node_id:home.nodeId,home_environment:home.environment,home_origin:home.origin,home_service:'node-ai'});
    expect((await db`SELECT id,approved_by FROM agent_roles WHERE principal_user_id=${user} AND scope='knowledge:read'`)).toEqual([expect.objectContaining({id:role,approved_by:admin})]);
    expect((await db`SELECT user_id FROM agent_principals WHERE home_node_id=${home.nodeId} AND home_environment=${home.environment} AND home_origin=${home.origin} AND home_service='node-ai'`)).toHaveLength(1);
    // A different operation using the verified tuple reaches this same retained identity even without a legacy mapping.
    expect(await provider().acceptProof(proof,digest)).toMatchObject({ok:true,principalUserId:user,principalCreated:false});
  });

  it.each(['logical','request_expired','enrollment_expired'] as const)('expired newer ask (%s) preserves earlier Off and ordinary On cannot revive an expired credential', async closure => {
    const user=randomUUID(), admin=randomUUID(), oldRole=randomUUID(), marker=await fullServiceKey(home,'node-ai');
    await db`INSERT INTO users(id,name) VALUES(${user},'retained service'),(${admin},'DAO admin')`;
    await db`INSERT INTO agent_principals(kind,user_id,service_key,home_node_id,home_environment,home_origin,home_service)
      VALUES('external',${user},${marker},${home.nodeId},${home.environment},${home.origin},'node-ai')`;
    await db`INSERT INTO agent_roles(id,principal_user_id,scope,approved_by,granted_at,revoked_at,created_at)
      VALUES(${oldRole},${user},'knowledge:read',${admin},clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '3 days')`;
    const oldToken=formatRevocableKey(randomBytes(32).toString('base64url')),oldHash=await hashAgentKey(oldToken);
    const credentials=await db`INSERT INTO agent_credentials(user_id,token_hash,created_from,pending_expires_at,expires_at,renew_until,confirmed_at)
      VALUES(${user},${oldHash},'key_upgrade',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day',clock_timestamp()+interval '2 days',clock_timestamp()) RETURNING id`;
    await db`UPDATE agent_credentials SET expires_at=clock_timestamp()-interval '2 days',renew_until=clock_timestamp()-interval '1 day' WHERE id=${credentials[0]?.id}`;
    const {proof}=await proofAt(), accepted=await provider().acceptProof(proof,await hashAgentKey('new-ask-after-off'));
    expect(accepted).toMatchObject({ok:true,principalUserId:user,principalCreated:false});
    const grants=createPostgresAgentGrantsStore(db as unknown as SqlTag);
    expect((await grants.listRoleRows(100,['knowledge:read'])).rows.find(row=>row.principalUserId===user)?.state).toBe('pending');
    await db`UPDATE agent_roles SET request_expires_at=clock_timestamp()-interval '1 second' WHERE principal_user_id=${user} AND approved_by IS NULL AND revoked_at IS NULL`;
    if (closure!=='logical') await db`UPDATE agent_roles SET revoked_at=clock_timestamp(),closed_reason=${closure} WHERE principal_user_id=${user} AND approved_by IS NULL AND revoked_at IS NULL`;
    expect((await db`SELECT status FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`)[0]?.status).not.toBe('denied');
    expect((await grants.listRoleRows(100,['knowledge:read'])).rows.find(row=>row.principalUserId===user)?.state).toBe('revoked');
    expect(await grants.listOwnRoles(user)).toEqual([expect.objectContaining({scope:'knowledge:read',state:'revoked'})]);
    expect(await grantRole(grants,{principalUserId:user,scope:'knowledge:read',approvedBy:admin,declaredScopes:['knowledge:read']})).toMatchObject({created:true});
    expect(await grants.hasLiveRole(user,'knowledge:read')).toBe(true);
    const rows=await db`SELECT approved_by,closed_reason FROM agent_roles WHERE principal_user_id=${user} AND approved_by IS NULL`;
    expect(rows).toHaveLength(1); expect(rows[0]?.approved_by).toBeNull();
    expect(['request_expired','enrollment_expired']).toContain(rows[0]?.closed_reason);
    expect(await verifyBearer(creds(),oldToken,['active'])).toMatchObject({ok:false,reason:'invalid'});
    expect((await db`SELECT id,approved_by FROM agent_roles WHERE id=${oldRole}`)[0]).toMatchObject({id:oldRole,approved_by:admin});
  });

  it("explicit Dismiss remains a denial barrier after later automatic expiries", async () => {
    const user=randomUUID(), admin=randomUUID(), marker=await fullServiceKey(home,'node-ai');
    await db`INSERT INTO users(id,name) VALUES(${user},'retained service'),(${admin},'DAO admin')`;
    await db`INSERT INTO agent_principals(kind,user_id,service_key,home_node_id,home_environment,home_origin,home_service)
      VALUES('external',${user},${marker},${home.nodeId},${home.environment},${home.origin},'node-ai')`;
    await db`INSERT INTO agent_roles(principal_user_id,scope,approved_by,granted_at,revoked_at,created_at)
      VALUES(${user},'knowledge:read',${admin},clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',clock_timestamp()-interval '3 days')`;
    const {proof}=await proofAt(); expect(await provider().acceptProof(proof,await hashAgentKey('dismiss-after-off'))).toMatchObject({ok:true});
    const grants=createPostgresAgentGrantsStore(db as unknown as SqlTag);
    expect(await grants.denyPending({principalUserId:user,scope:'knowledge:read'})).toBe(true);
    expect((await db`SELECT status FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`)[0]?.status).toBe('denied');
    await db`INSERT INTO agent_roles(principal_user_id,scope,created_at,request_expires_at,revoked_at,closed_reason)
      SELECT ${user},'knowledge:read',clock_timestamp(),clock_timestamp()-interval '1 second',clock_timestamp(),'request_expired' FROM generate_series(1,5000)`;
    await db`ANALYZE agent_roles`;
    expect((await grants.listRoleRows(100,['knowledge:read'])).rows.filter(row=>row.principalUserId===user)).toHaveLength(0);
    expect(await grants.listOwnRoles(user)).toEqual([expect.objectContaining({scope:'knowledge:read',state:'denied'})]);
    await expect(grantRole(grants,{principalUserId:user,scope:'knowledge:read',approvedBy:admin,declaredScopes:['knowledge:read']})).rejects.toMatchObject({code:'request_expired'});
    expect(await grants.hasLiveRole(user,'knowledge:read')).toBe(false);
    const plan=await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM agent_roles WHERE principal_user_id=${user} AND scope='knowledge:read'
      AND (approved_by IS NOT NULL OR (approved_by IS NULL AND revoked_at IS NOT NULL AND (closed_reason IS NULL OR closed_reason NOT IN ('enrollment_expired','request_expired'))))
      ORDER BY created_at DESC NULLS LAST,id DESC NULLS LAST LIMIT 1`;
    expect(JSON.stringify(plan)).toContain('agent_roles_explicit_control_idx');
  },30000);

  it("a first-ever expired ask cannot invent a previous consent control", async () => {
    const reference=await readFile(resolve('src/adapters/server/db/migrations/0049_retained_explicit_consent.sql'),'utf8');
    expect(reference).toContain((await readFile(resolve('../packages/agent-grants/migrations/agent_authority_consent_control.sql'),'utf8')).trim());
    expect(reference).toContain((await readFile(resolve('../packages/agent-grants/migrations/agent_service_enrollment_consent_expiry.sql'),'utf8')).trim());
    const user=randomUUID(),admin=randomUUID();
    await db`INSERT INTO users(id,name) VALUES(${user},'first ask'),(${admin},'admin')`;
    await db`INSERT INTO agent_principals(kind,user_id,service_key) VALUES('external',${user},${`https://first-${randomUUID()}.example#node-ai`})`;
    await db`INSERT INTO agent_roles(principal_user_id,scope,request_expires_at) VALUES(${user},'knowledge:read',clock_timestamp()-interval '1 second')`;
    const grants=createPostgresAgentGrantsStore(db as unknown as SqlTag);
    expect((await grants.listRoleRows(100,['knowledge:read'])).rows.filter(row=>row.principalUserId===user)).toHaveLength(0);
    await expect(grantRole(grants,{principalUserId:user,scope:'knowledge:read',approvedBy:admin,declaredScopes:['knowledge:read']})).rejects.toMatchObject({code:'request_expired'});
    expect(await grants.hasLiveRole(user,'knowledge:read')).toBe(false);
  });

  it("staged expiry uses its partial deadline index across terminal retained history", async () => {
    const connection = randomUUID();
    await db`INSERT INTO connections(id,billing_account_id,provider,credential_type,encrypted_credentials,encryption_key_id,created_by_user_id,service_state)
      VALUES(${connection},${key.billingAccountId},'cogni-node','api_key',${Buffer.from('fixture')},'fixture',${COGNI_SYSTEM_PRINCIPAL_USER_ID},'staged')`;
    await db`INSERT INTO agent_service_link_operations(operation_id,key_digest,home_node_id,home_environment,home_origin,service,billing_account_id,target_node_id,target_environment,target_origin,generation,phase,current,state,secret_deadline,staged_connection_id)
      SELECT gen_random_uuid(),'terminal-'||n,${home.nodeId},${home.environment},${home.origin},'node-ai',${key.billingAccountId},${target.nodeId},${target.environment},${target.origin},n,'expired',false,'{}'::jsonb,clock_timestamp()-interval '1 day',${connection}
      FROM generate_series(1,5000) n`;
    await db`INSERT INTO agent_service_link_operations(operation_id,key_digest,home_node_id,home_environment,home_origin,service,billing_account_id,target_node_id,target_environment,target_origin,generation,phase,current,state,secret_deadline,staged_connection_id)
      VALUES(gen_random_uuid(),'staged-due',${home.nodeId},${home.environment},${home.origin},'node-ai',${key.billingAccountId},${target.nodeId},${target.environment},${target.origin},5001,'confirm_unknown',false,'{}'::jsonb,clock_timestamp()-interval '1 minute',${connection})`;
    await db`ANALYZE agent_service_link_operations`;
    const plan = await db`EXPLAIN (FORMAT JSON) SELECT operation_id,state,staged_connection_id FROM agent_service_link_operations
      WHERE staged_connection_id IS NOT NULL AND secret_deadline<=clock_timestamp() AND COALESCE(state->>'quarantined','false')<>'true' AND phase<>'expired'
      ORDER BY secret_deadline,operation_id LIMIT 20 FOR UPDATE SKIP LOCKED`;
    expect(JSON.stringify(plan)).toContain('agent_service_links_staged_expiry_idx');
  }, 10000);

  it("the requester-only template and bounded maintenance need no provider tables", async () => {
    await db.unsafe('CREATE DATABASE requester_only_fixture');
    const uri = new URL(container.getConnectionUri());
    uri.pathname = '/requester_only_fixture';
    const requesterOnly = postgres(uri.toString(), {max:2});
    try {
      // Host prerequisites only. The published requester template supplies its own operations table and connection delta.
      await requesterOnly.unsafe(`CREATE TABLE billing_accounts(id text PRIMARY KEY);
        CREATE TABLE connections(id uuid PRIMARY KEY, billing_account_id text NOT NULL REFERENCES billing_accounts(id), provider text NOT NULL,
          credential_type text NOT NULL, encrypted_credentials bytea NOT NULL, encryption_key_id text NOT NULL, created_by_user_id text NOT NULL,
          revoked_at timestamptz, CONSTRAINT connections_provider_check CHECK(provider IN ('github')));
        CREATE UNIQUE INDEX connections_billing_account_provider_active_idx ON connections(billing_account_id,provider) WHERE revoked_at IS NULL;`).simple();
      const template = await readFile(resolve('../packages/agent-grants/migrations/agent_service_requester.sql'),'utf8');
      await requesterOnly.begin(async (tx) => { await tx.unsafe(template).simple(); });
      expect((await requesterOnly`SELECT to_regclass('agent_service_enrollments') AS provider,to_regclass('agent_authority_maintenance') AS lease`)[0]).toMatchObject({provider:null,lease:null});
      expect(await requesterMaintenanceTick(requesterOnly as unknown as CredentialSql)).toBe(true);
      const audit = await readFile(resolve('../packages/agent-grants/migrations/agent_service_requester_audit.sql'),'utf8');
      await requesterOnly.begin(async (tx) => { await tx.unsafe(audit).simple(); });
      expect((await requesterOnly`SELECT to_regclass('agent_service_enrollments') AS provider`)[0]?.provider).toBeNull();
      expect((await requesterOnly`SELECT purge_enabled,minimum_reader_build FROM agent_authority_maintenance WHERE id='requester-audit'`)[0])
        .toMatchObject({purge_enabled:false,minimum_reader_build:null});
      expect(await requesterMaintenanceTick(requesterOnly as unknown as CredentialSql)).toBe(true);
    } finally { await requesterOnly.end({timeout:1}); }
  }, 10000);


  const auditTick = async () => {
    await db`UPDATE agent_authority_maintenance SET next_run_at=clock_timestamp() WHERE id='service-enrollment'`;
    return maintenanceTick(client(), async (tx) => { await maintainRequesterCustody(tx); await maintainEnrollmentDelivery(tx); });
  };
  const qualifyFixtureAudit = async () => {
    // This is an isolated migrated fixture, never a live rollout or an assertion that a build was qualified.
    await db`UPDATE agent_authority_maintenance SET purge_enabled=true,minimum_reader_build=${"a".repeat(40)} WHERE id='service-enrollment' AND backfill_ready`;
  };
  async function seedAuditChain(length: number, exerciseRotations=true) {
    const user=randomUUID();
    const ids: string[]=Array.from({length:length+2},()=>randomUUID());
    const tokens=ids.map(()=>formatRevocableKey(randomBytes(32).toString('base64url')));
    await db`INSERT INTO users(id,name) VALUES(${user},'audit fixture')`;
    await db`INSERT INTO agent_principals(kind,user_id) VALUES('external',${user})`;
    if(exerciseRotations) {
      const store=creds(),policy={ttlSec:2592000,renewWindowSec:1209600,pendingSec:900};
      for(let i=0;i<ids.length;i++) {
        const tokenHash=await hashAgentKey(tokens[i]!);
        const issued=i===0 ? await store.issueUpgrade({userId:user,tokenHash,policy}) :
          await store.issueSuccessor({predecessorId:ids[i-1]!,tokenHash,policy});
        if(!issued.ok) throw new Error(`fixture issue refused: ${issued.reason}`);
        ids[i]=issued.credentialId;
        if(i<=length) {
          const confirmed=await confirmCredential(store,{credentialId:issued.credentialId,policy});
          if(!confirmed.ok) throw new Error(`fixture confirmation refused: ${confirmed.reason}`);
        }
      }
    }
    // Real rotation writes above establish ancestry. Timestamp fixtures age that history; all guards return before maintenance.
    await db.begin(async tx => {
      const at=String((await tx`SELECT clock_timestamp()::text AS at`)[0]!.at);
      await tx.unsafe('ALTER TABLE agent_credentials DISABLE TRIGGER USER');
      for (let i=0;i<ids.length;i++) {
        const live=i===length,pending=i===length+1;
        if(!exerciseRotations) await tx`INSERT INTO agent_credentials(id,user_id,token_hash,created_from,predecessor_id,predecessor_provenance_id,
          issued_at,expires_at,renew_until) VALUES(${ids[i]!},${user},${await hashAgentKey(tokens[i]!)},${i?'rotation':'spawn_grant'},
            ${i?ids[i-1]!:null},${i?ids[i-1]!:null},${at}::timestamptz,${at}::timestamptz+interval '1 day',${at}::timestamptz+interval '2 days')`;
        await tx`UPDATE agent_credentials SET issued_at=(${at}::timestamptz)-(${Math.max(0,length-i)*2}::int*interval '1 day')-CASE WHEN ${pending} THEN interval '3 minutes' ELSE interval '5 minutes' END,
          confirmed_at=CASE WHEN ${pending} THEN NULL ELSE (${at}::timestamptz)-(${Math.max(0,length-i)*2}::int*interval '1 day')-interval '4 minutes' END,
          expires_at=CASE WHEN ${live || pending} THEN (${at}::timestamptz)+interval '1 day' ELSE (${at}::timestamptz)-(${(length-i)*2}::int*interval '1 day')+interval '30 days'-interval '5 minutes' END,
          renew_until=CASE WHEN ${live || pending} THEN (${at}::timestamptz)+interval '2 days' ELSE (${at}::timestamptz)-(${(length-i)*2}::int*interval '1 day')+interval '44 days'-interval '5 minutes' END,
          pending_expires_at=CASE WHEN ${pending} THEN (${at}::timestamptz)+interval '5 minutes' ELSE (${at}::timestamptz)-(${Math.max(0,length-i)*2}::int*interval '1 day')+interval '9 minutes' END,
          revoked_at=CASE WHEN ${live || pending} THEN NULL ELSE (${at}::timestamptz)-(${(length-i-1)*2}::int*interval '1 day')-interval '4 minutes' END
          WHERE id=${ids[i]!}`;
      }
      await tx.unsafe('ALTER TABLE agent_credentials ENABLE TRIGGER USER');
      await tx`UPDATE agent_credentials SET purge_after=NULL WHERE user_id=${user}`;
    });
    return {user,ids,tokens,live:ids[length]!,pending:ids[length+1]!};
  }

  it('purge-off preserves old audit, then bounded FK compaction keeps the live leaf and unconfirmed immediate predecessor', async () => {
    const chain=await seedAuditChain(100);
    const summary=(await db`SELECT ever_confirmed,first_confirmed_at FROM agent_principals WHERE user_id=${chain.user}`)[0];
    await expect(assertV1NotSuperseded(creds(),chain.user)).rejects.toThrow();
    await auditTick();
    expect((await db`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id=${chain.user}`)[0]?.n).toBe(102);
    await qualifyFixtureAudit();
    for (let tick=0;tick<20;tick++) {
      const before=(await db`SELECT count(*)::int AS rows,count(predecessor_id)::int AS edges FROM agent_credentials WHERE user_id=${chain.user}`)[0]!;
      await auditTick();
      const after=(await db`SELECT count(*)::int AS rows,count(predecessor_id)::int AS edges FROM agent_credentials WHERE user_id=${chain.user}`)[0]!;
      expect(Number(before.rows)-Number(after.rows)).toBeLessThanOrEqual(20);
      expect(Number(before.edges)-Number(after.edges)).toBeLessThanOrEqual(20);
    }
    const remaining=await db`SELECT id,predecessor_id,predecessor_provenance_id FROM agent_credentials WHERE user_id=${chain.user} ORDER BY id`;
    expect(remaining).toHaveLength(47);
    expect(remaining.find(x=>x.id===chain.ids[55])).toMatchObject({predecessor_id:null,predecessor_provenance_id:chain.ids[54]});
    expect(remaining.find(x=>x.id===chain.live)).toMatchObject({predecessor_id:chain.ids[99]});
    expect(remaining.find(x=>x.id===chain.pending)).toMatchObject({predecessor_id:chain.live,predecessor_provenance_id:chain.live});
    expect((await db`SELECT ever_confirmed,first_confirmed_at FROM agent_principals WHERE user_id=${chain.user}`)[0]).toEqual(summary);
    expect((await verifyBearer(creds(),chain.tokens[100]!,["active"])).ok).toBe(true);
    expect((await verifyBearer(creds(),chain.tokens[0]!,["active"])).ok).toBe(false);
    await expect(assertV1NotSuperseded(creds(),chain.user)).rejects.toThrow();
    // Pending confirm still consumes its immediate predecessor after distant ancestors disappear.
    expect((await confirmCredential(creds(),{credentialId:chain.pending})).ok).toBe(true);
    expect((await verifyBearer(creds(),chain.tokens[101]!,["active"])).ok).toBe(true);
    const successor=await creds().issueSuccessor({predecessorId:chain.pending,tokenHash:await hashAgentKey(randomUUID()),policy:{ttlSec:3600,renewWindowSec:3600,pendingSec:300}});
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('fixture rotation refused');
    await creds().revoke({credentialId:chain.pending,userId:chain.user,reason:'fixture',revokedBy:chain.user});
    expect((await confirmCredential(creds(),{credentialId:successor.credentialId})).ok).toBe(false);
    await db.begin(async tx=> {
      await tx`SET LOCAL enable_seqscan=off`;
      const observed=(await tx`SELECT clock_timestamp()::text AS at`)[0]!.at;
      const plan=await tx`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id,user_id,purge_after::text AS cursor_at FROM agent_credentials
        WHERE purge_after<=${observed}::timestamptz ORDER BY purge_after,id LIMIT 5`;
      expect(JSON.stringify(plan)).toContain('agent_credentials_purge_idx');
      expect(JSON.stringify(plan)).toContain('Index Cond');
    });
  },30000);

  it('never detaches an unconfirmed child even when its old parent is due',async()=> {
    const user=randomUUID(),parent=randomUUID(),child=randomUUID();
    await db`INSERT INTO users(id,name) VALUES(${user},'pending boundary')`;
    await db`INSERT INTO agent_principals(kind,user_id) VALUES('external',${user})`;
    await db.begin(async tx=> {
      const at=String((await tx`SELECT clock_timestamp()::text AS at`)[0]!.at);
      await tx.unsafe('ALTER TABLE agent_credentials DISABLE TRIGGER USER');
      await tx`INSERT INTO agent_credentials(id,user_id,token_hash,created_from,issued_at,confirmed_at,expires_at,renew_until,pending_expires_at,revoked_at)
        VALUES(${parent},${user},${await hashAgentKey(randomUUID())},'spawn_grant',(${at}::timestamptz)-interval '100 days',(${at}::timestamptz)-interval '99 days',
          (${at}::timestamptz)-interval '69 days',(${at}::timestamptz)-interval '55 days',(${at}::timestamptz)-interval '100 days'+interval '15 minutes',
          (${at}::timestamptz)-interval '90 days 5 minutes')`;
      await tx`INSERT INTO agent_credentials(id,user_id,token_hash,created_from,predecessor_id,predecessor_provenance_id,issued_at,expires_at,renew_until,pending_expires_at)
        VALUES(${child},${user},${await hashAgentKey(randomUUID())},'rotation',${parent},${parent},(${at}::timestamptz)-interval '90 days 10 minutes',
          (${at}::timestamptz)-interval '60 days 10 minutes',(${at}::timestamptz)-interval '46 days 10 minutes',(${at}::timestamptz)-interval '89 days 23 hours 55 minutes')`;
      await tx.unsafe('ALTER TABLE agent_credentials ENABLE TRIGGER USER');
      await tx`UPDATE agent_credentials SET purge_after=NULL WHERE user_id=${user}`;
    });
    await qualifyFixtureAudit();
    await expect(db`UPDATE agent_credentials SET predecessor_id=NULL WHERE id=${child}`).rejects.toThrow();
    await auditTick();
    expect((await db`SELECT predecessor_id FROM agent_credentials WHERE id=${child}`)[0]?.predecessor_id).toBe(parent);
    expect(await db`SELECT id FROM agent_credentials WHERE id=${parent}`).toHaveLength(1);
  },10000);

  it('retains latest Off and Dismiss controls, purges older closed decisions and compacts a current terminal receipt',async()=> {
    const {proof}=await proofAt(); const created=await provider().acceptProof(proof,await hashAgentKey(randomUUID()));
    if(!created.ok) throw new Error('fixture start refused');
    const user=created.principalUserId,admin=randomUUID();
    await db`INSERT INTO users(id,name) VALUES(${admin},'fixture admin')`;
    await db`UPDATE agent_roles SET approved_by=${admin},granted_at=clock_timestamp(),revoked_at=clock_timestamp()-interval '100 days'
      WHERE principal_user_id=${user}`;
    const oldOff=(await db`SELECT id FROM agent_roles WHERE principal_user_id=${user}`)[0]!.id;
    const latestOff=randomUUID(),dismiss=randomUUID();
    await db`INSERT INTO agent_roles(id,principal_user_id,scope,approved_by,granted_at,created_at,revoked_at)
      VALUES(${latestOff},${user},'knowledge:read',${admin},clock_timestamp()-interval '120 days',date_trunc('second',clock_timestamp())-interval '110 days'+interval '0.123456 seconds',clock_timestamp()-interval '100 days')`;
    // Ensure immutable order puts this explicit Off after the original decision despite timestamp reconstruction.
    await db`UPDATE agent_roles SET created_at=clock_timestamp()-interval '130 days' WHERE id=${oldOff}`;
    await db`INSERT INTO agent_roles(id,principal_user_id,scope,created_at,revoked_at,closed_reason)
      VALUES(${dismiss},${user},'work:read',clock_timestamp()-interval '110 days',clock_timestamp()-interval '100 days','dismissed')`;
    const expiredId=randomUUID(),expiredToken=formatRevocableKey(randomBytes(32).toString('base64url'));
    await db.begin(async tx=> {
      await tx.unsafe('ALTER TABLE agent_credentials DISABLE TRIGGER USER');
      await tx`INSERT INTO agent_credentials(id,user_id,token_hash,created_from,service_operation_id,service_generation,
        issued_at,confirmed_at,pending_expires_at,expires_at,renew_until,revoked_at)
        VALUES(${expiredId},${user},${await hashAgentKey(expiredToken)},'service_enrollment',${proof.operationId},1,
          clock_timestamp()-interval '150 days',clock_timestamp()-interval '149 days',clock_timestamp()-interval '149 days',
          clock_timestamp()-interval '110 days',clock_timestamp()-interval '100 days',clock_timestamp()-interval '100 days')`;
      await tx.unsafe('ALTER TABLE agent_credentials ENABLE TRIGGER USER');
      await tx`UPDATE agent_credentials SET purge_after=NULL WHERE id=${expiredId}`;
    });
    await db.begin(async tx=> {
      await tx.unsafe('ALTER TABLE agent_service_enrollments DISABLE TRIGGER agent_enrollment_v2_immutable');
      await tx`UPDATE agent_service_enrollments SET status='expired',terminal_at=clock_timestamp()-interval '100 days',sealed_acceptance=NULL,
        credential_id=${expiredId},historical_confirmed_at=clock_timestamp()-interval '149 days',original_start_exp=clock_timestamp()-interval '101 days' WHERE operation_id=${proof.operationId}`;
      await tx.unsafe('ALTER TABLE agent_service_enrollments ENABLE TRIGGER agent_enrollment_v2_immutable');
    });
    await qualifyFixtureAudit();for(let i=0;i<5;i++) await auditTick();
    expect(await db`SELECT id FROM agent_roles WHERE id=${oldOff}`).toHaveLength(0);
    expect(await db`SELECT id FROM agent_roles WHERE id IN (${latestOff},${dismiss})`).toHaveLength(2);
    expect(await db`SELECT id FROM agent_service_enrollments WHERE operation_id=${proof.operationId}`).toHaveLength(0);
    expect((await db`SELECT current_operation_id,current_generation,current_operation_digest,service_key FROM agent_principals WHERE user_id=${user}`)[0])
      .toMatchObject({current_operation_id:proof.operationId,current_generation:1,current_operation_digest:proof.intentDigest,service_key:await fullServiceKey(proof.home,proof.service)});
    expect(await db`SELECT id FROM agent_credentials WHERE id=${expiredId}`).toHaveLength(0);
    await expect(db`UPDATE agent_principals SET current_operation_id=NULL,current_generation=0 WHERE user_id=${user}`).rejects.toThrow();
    const grants=createPostgresAgentGrantsStore(db as unknown as SqlTag);
    await grantRole(grants,{principalUserId:user,scope:'knowledge:read',approvedBy:admin,declaredScopes:['knowledge:read']});
    expect(await grants.hasLiveRole(user,'knowledge:read')).toBe(true);
    expect((await verifyBearer(creds(),expiredToken,["active"])).ok).toBe(false);
    await expect(assertV1NotSuperseded(creds(),user)).rejects.toThrow();
    const continuation={...proof,op:'continue' as const,jti:randomUUID(),originalTokenDigest:await hashAgentKey(randomUUID())};
    expect((await provider().acceptProof(continuation,await hashAgentKey(randomUUID())))).toMatchObject({ok:false,reason:'unknown_operation'});
    expect((await provider().acceptProof(proof,await hashAgentKey(randomUUID())))).toMatchObject({ok:false,reason:'intent_conflict'});
  },10000);

  it('compacts current home audit without resetting K or its fence, deletes superseded audit and preserves a fresh intent',async()=> {
    let now=Date.now()-110*86400000;
    const signing=await generateKeyPair('EdDSA');
    const custody=createPostgresRequesterCustody(client(),{cipher:createCustodyCipher(new Uint8Array(32).fill(9),'audit-fixture'),
      systemPrincipalUserId:COGNI_SYSTEM_PRINCIPAL_USER_ID,readReadyConnection:async()=>null});
    const requester=createEnrollmentRequester({...custody,cipher:createCustodyCipher(new Uint8Array(32).fill(9),'audit-fixture'),
      signer:createEnrollmentProofSigner({kid:'audit-fixture',key:signing.privateKey}),now:()=>new Date(now),fetch:discoveryFetch,
      transport:{postProof:async()=>{throw new EnrollmentClientError('enrollment_rejected',404,new Date().toISOString(),'unknown_operation');},
        pollToken:async()=>{throw new Error('unused');},confirmStaged:async()=>{throw new Error('unused');}}});
    const compact=await requester.ensure(key),other={...key,service:'other-service'},obsolete=await requester.ensure(other);
    const a=await requester.disconnect({operationId:compact.linkId,key},compact.revision);
    const b=await requester.disconnect({operationId:obsolete.linkId,key:other},obsolete.revision);
    now=Date.now();const fresh=await requester.reenroll({operationId:obsolete.linkId,key:other},b.revision);
    await db`UPDATE agent_service_link_operations SET terminal_at=clock_timestamp()-interval '100 days'
      WHERE operation_id IN (${compact.linkId},${obsolete.linkId})`;
    await auditTick();
    expect(await db`SELECT operation_id FROM agent_service_link_operations WHERE operation_id=${obsolete.linkId}`).toHaveLength(1);
    await qualifyFixtureAudit();await auditTick();
    expect(await db`SELECT operation_id FROM agent_service_link_operations WHERE operation_id=${obsolete.linkId}`).toHaveLength(0);
    const retained=(await db`SELECT * FROM agent_service_link_operations WHERE operation_id=${compact.linkId}`)[0]!;
    expect(retained.current).toBe(true);expect(retained.generation).toBe(1);
    expect(retained.audit_compacted_at).not.toBeNull();expect(retained.encrypted_secrets).toBeNull();
    expect(Number(retained.revision)).toBeGreaterThan(a.revision);expect(Number(retained.fence)).toBeGreaterThan(0);
    expect((await requester.ensure(key)).linkId).toBe(compact.linkId);
    const afterCompact=await requester.read({operationId:compact.linkId,key});
    await requester.reenroll({operationId:compact.linkId,key},afterCompact.revision);
    await auditTick();
    expect(await db`SELECT operation_id FROM agent_service_link_operations WHERE operation_id=${compact.linkId}`).toHaveLength(0);
    expect(await db`SELECT operation_id FROM agent_service_link_operations WHERE operation_id=${fresh.linkId} AND encrypted_secrets IS NOT NULL`).toHaveLength(1);
  },10000);

  it('audit keyset progress skips locked identities without pinning the next unlocked identity',async()=> {
    const chains: Awaited<ReturnType<typeof seedAuditChain>>[]=[];for(let i=0;i<6;i++) chains.push(await seedAuditChain(46,false));
    await qualifyFixtureAudit();
    let held!:()=>void,release!:()=>void;
    const acquired=new Promise<void>(r=>{held=r;});
    const holder=second.begin(async tx=> {
      for(const chain of chains.slice(0,5)) await tx`SELECT pg_advisory_xact_lock(hashtext(${chain.user}))`;
      held();await new Promise<void>(r=>{release=r;});
    });
    await acquired;
    try {
      await auditTick();
      expect(await db`SELECT id FROM agent_credentials WHERE id=${chains[5]!.ids[0]!}`).toHaveLength(1);
      await auditTick();
      expect(await db`SELECT id FROM agent_credentials WHERE id=${chains[5]!.ids[0]!}`).toHaveLength(0);
      for(const chain of chains.slice(0,5)) expect(await db`SELECT id FROM agent_credentials WHERE id=${chain.ids[0]!}`).toHaveLength(1);
    } finally {release();await holder;}
  },15000);

  it('the native cumulative deadline rolls back audit bookkeeping and leaves purge work available',async()=> {
    await qualifyFixtureAudit();
    const result=await maintenanceTick(client(),async tx=> {
      await tx`UPDATE agent_authority_maintenance SET audit_cursors='{"mustRollback":true}'::jsonb WHERE id='service-enrollment'`;
      await tx`SELECT pg_sleep(3)`;
    });
    expect(result).toEqual({processed:0,due:true});
    expect((await db`SELECT audit_cursors FROM agent_authority_maintenance WHERE id='service-enrollment'`)[0]?.audit_cursors).toEqual({});
  },10000);

  it('ships the exact forward audit guards and leaves cutover off',async()=> {
    const shipped=await readFile(resolve('../packages/agent-grants/migrations/agent_service_enrollment_audit.sql'),'utf8');
    expect(shipped).toBe(await readFile(resolve('src/adapters/server/db/migrations/0050_bounded_enrollment_audit.sql'),'utf8'));
    expect((await db`SELECT purge_enabled,minimum_reader_build FROM agent_authority_maintenance WHERE id='service-enrollment'`)[0])
      .toMatchObject({purge_enabled:false,minimum_reader_build:null});
  });
});
