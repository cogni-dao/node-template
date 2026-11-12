// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real migration/locks/custody/crash fixtures. CI only; no local SQL prerequisite. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
} from "@cogni/agent-grants/enrollment-requester";
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
      r = createEnrollmentRequester({ ...first, cipher, signer, transport });
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
});
