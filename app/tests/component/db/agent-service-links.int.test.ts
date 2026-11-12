// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real migration/locks/custody/crash fixtures. CI only; no local SQL prerequisite. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  createPostgresAgentGrantsStore,
  type SqlTag,
} from "@cogni/agent-grants";
import {
  agentRolesHasRoles,
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  hashAgentKey,
} from "@cogni/agent-grants/credentials";
import { runDurableEnrollmentConformance } from "@cogni/agent-grants/durable-enrollment-conformance";
import {
  createDurableProviderStore,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  fullServiceKey,
  intentDigestOf,
} from "@cogni/agent-grants/enrollment";
import {
  type ConnectionKey,
  createCustodyCipher,
  createEnrollmentProofSigner,
  createEnrollmentRequester,
  createPostgresRequesterCustody,
  requesterMaintenanceTick,
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
  const intent = {
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
    await db`UPDATE agent_authority_maintenance SET oldest_due_at=NULL,next_run_at=clock_timestamp(),purge_enabled=false WHERE id='service-enrollment'`;
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
    let clock = Date.now() - 26 * 3600000;
    const requester = createEnrollmentRequester({ ...custody, cipher, fetch: discoveryFetch,
      now: () => new Date(clock), signer: createEnrollmentProofSigner({ kid: "fixture", key: signing.privateKey }),
      transport: {
        postProof: async () => { throw new EnrollmentClientError("enrollment_rejected", 404, new Date().toISOString()); },
        pollToken: async () => ({ kind: "authorization_pending" as const }), confirmStaged: async () => ({ status: 503 }),
      },
    });
    const first = await requester.ensure(key), oldHandle = { operationId: first.linkId, key };
    clock = Date.now();
    expect((await requester.advance(oldHandle)).phase).toBe("expired_unknown");
    const old = await custody.store.read(oldHandle);
    if (!old) throw new Error("missing expired intent");
    expect(old.encryptedSecrets).toBeNull();
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
    const principal = await db`SELECT user_id,service_key,home_node_id,home_environment,home_origin,home_service FROM agent_principals WHERE user_id=${user}`;
    expect(principal[0]).toMatchObject({user_id:user,service_key:marker,home_node_id:home.nodeId,home_environment:home.environment,home_origin:home.origin,home_service:'node-ai'});
    expect((await db`SELECT id,approved_by FROM agent_roles WHERE principal_user_id=${user} AND scope='knowledge:read'`)).toEqual([expect.objectContaining({id:role,approved_by:admin})]);
    expect((await db`SELECT user_id FROM agent_principals WHERE home_node_id=${home.nodeId} AND home_environment=${home.environment} AND home_origin=${home.origin} AND home_service='node-ai'`)).toHaveLength(1);
    // A different operation using the verified tuple reaches this same retained identity even without a legacy mapping.
    expect(await provider().acceptProof(proof,digest)).toMatchObject({ok:true,principalUserId:user,principalCreated:false});
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
    } finally { await requesterOnly.end({timeout:1}); }
  }, 10000);

});
