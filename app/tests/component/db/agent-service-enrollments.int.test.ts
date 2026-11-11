// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-service-enrollments.int.test`
 * Purpose: The service enrollment store against real Postgres with migration 0041 applied (story.0038). Runs the package's OWN conformance suite
 *   (`runEnrollmentConformance`, SUITE_GATES_RELEASE) over the real SQL, then the rows only SQL can prove: the RLS wall, the unique `jti`, the one
 *   principal per `service_key`, the `service_enrollment` key origin and the trigger that kills sibling keys when an enrolled key is confirmed.
 * Scope: `@cogni-dao/agent-grants/enrollment` + migration 0041. No HTTP.
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the app role sees no `agent_service_enrollments` row.
 *   - DEVICE_CODE_HASH_ONLY: only the sha256 of a device code is stored.
 *   - ONE_USE_TOKEN: `jti` is unique in the database, not only in the store's pre-check.
 *   - DB_CLOCK: a timestamp moves with UPDATE; nothing reads the app clock.
 *   - CONFIRMED_CODE_STAYS_SPENT: polls waiting on a credential's confirmation/revocation cannot mint a replacement.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS. Every `setup()` removes ALL enrollment principals first: this file is
 *   the only writer of `agent_principals.service_key`, and the caps (5 open enrollments, 25 agents) are node-wide.
 * Links: app/src/adapters/server/db/migrations/0041_agent_service_enrollments.sql
 */

import { randomUUID } from "node:crypto";
import { authorizeCaller, buildNodeAiView, grantRole, revokeRole, createPostgresAgentGrantsStore, type SqlTag } from "@cogni/agent-grants";
import { type CredentialSql, createPostgresCredentialStore, agentRolesHasRoles, hashAgentKey, confirmCredential, verifyBearer } from "@cogni/agent-grants/credentials";
import { createPostgresEnrollmentStore, pollServiceEnrollment, requestServiceEnrollment, openSealed, SERVICE_ENROLLMENT_KIND, serviceEnrollmentAudience, type ServiceEnrollmentClaims } from "@cogni/agent-grants/enrollment";
import { runEnrollmentConformance, type EnrollmentConformanceHarness } from "@cogni/agent-grants/enrollment-conformance";
import { generateKeyPair, exportJWK } from "jose";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("agent service enrollments (real Postgres)", () => {
  let service: Sql;
  let app: Sql;
  const admins: string[] = [];
  const client = () => service as unknown as CredentialSql;

  const cleanup = async () => {
    const ids = (await service`SELECT user_id FROM agent_principals WHERE service_key IS NOT NULL`).map((r) => r.user_id as string);
    await service`DELETE FROM agent_service_enrollments`;
    if (ids.length === 0) return;
    await service`DELETE FROM agent_credentials WHERE user_id = ANY(${ids}::text[])`;
    await service`DELETE FROM agent_roles WHERE principal_user_id = ANY(${ids}::text[]) OR requested_by = ANY(${ids}::text[])`;
    await service`DELETE FROM agent_principals WHERE user_id = ANY(${ids}::text[])`;
    await service`DELETE FROM users WHERE id = ANY(${ids}::text[])`;
  };
  const makeAdmin = async () => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`enroll-admin-${id.slice(0, 6)}`})`;
    admins.push(id);
    return id;
  };

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 8 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await cleanup();
    await service?.unsafe("DELETE FROM agent_roles WHERE approved_by = ANY($1)", [admins]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [admins]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  const enrollmentHarness: EnrollmentConformanceHarness = {
    describe,
    it,
    expect,
    async setup() {
      await cleanup();
      const admin = await makeAdmin();
      const grants = createPostgresAgentGrantsStore(service as unknown as Parameters<typeof createPostgresAgentGrantsStore>[0]);
      return {
        store: createPostgresEnrollmentStore(client()),
        credentials: createPostgresCredentialStore(client(), { hasRoles: agentRolesHasRoles(client()) }),
        askableScopes: ["knowledge:read", "knowledge:contribute"],
        approve: async (principalUserId, scope) => void (await grants.approvePending({ principalUserId, scope, approvedBy: admin })),
        dismiss: async (principalUserId, scope) => void (await grants.denyPending({ principalUserId, scope })),
        switchOff: async (principalUserId, scope) => void (await grants.revokeRole({ principalUserId, scope })),
        hasLiveRole: (principalUserId, scope) => grants.hasLiveRole(principalUserId, scope),
        async pendingAsks(principalUserId, scope) {
          const rows = await service`
            SELECT count(*)::int AS n FROM agent_roles
            WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL`;
          return Number(rows[0]?.n ?? 0);
        },
        async skipPollInterval() {
          await service`UPDATE agent_service_enrollments SET last_polled_at = now() - interval '1 minute' WHERE last_polled_at IS NOT NULL`;
        },
        async lapse(principalUserId) {
          await service`UPDATE agent_service_enrollments SET expires_at = now() - interval '1 second' WHERE principal_user_id = ${principalUserId}`;
        },
        async expireCredential(credentialId) {
          await service`UPDATE agent_credentials
            SET expires_at = now() - interval '2 seconds', renew_until = now() - interval '1 second', pending_expires_at = now() - interval '1 second'
            WHERE id = ${credentialId}`;
        },
        async ageUnredeemed(principalUserId) {
          await service`UPDATE agent_principals SET created_at = now() - interval '25 hours' WHERE user_id = ${principalUserId}`;
        },
        async principalExists(principalUserId) {
          return (await service`SELECT 1 FROM agent_principals WHERE user_id = ${principalUserId}`).length > 0;
        },
        async deviceCodeStoredPlain(code) {
          const rows = await service`SELECT 1 FROM agent_service_enrollments e WHERE e::text LIKE ${`%${code}%`}`;
          return rows.length > 0;
        },
        async deviceCodeHashStored(code) {
          const hash = await hashAgentKey(code);
          return (await service`SELECT 1 FROM agent_service_enrollments WHERE device_code_hash = ${hash}`).length > 0;
        },
        storedHash: async (credentialId) => (await service`SELECT token_hash FROM agent_credentials WHERE id = ${credentialId}`)[0]?.token_hash ?? null,
        broken: () =>
          createPostgresEnrollmentStore(
            (async () => {
              throw new Error("db down");
            }) as unknown as CredentialSql
          ),
      };
    },
  };
  runEnrollmentConformance(enrollmentHarness);

  const startEnrollment = async (setup: Awaited<ReturnType<typeof enrollmentHarness.setup>>, serviceName = "git-review") => {
    const pair = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
    const publicJwk = await exportJWK(pair.publicKey);
    const claims: ServiceEnrollmentClaims = {
      iss: "https://home.example", aud: serviceEnrollmentAudience("11111111-1111-4111-8111-111111111111"),
      kind: SERVICE_ENROLLMENT_KIND, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
      service: serviceName, scopes: ["knowledge:read"], cnf: { jwk: { kty: "OKP", crv: "X25519", x: publicJwk.x as string } },
    };
    const made = await requestServiceEnrollment(setup.store, async () => ({ ok: true, claims, home: { origin: claims.iss, services: { [serviceName]: ["knowledge:read"] } } }), { token: "verified-test-claims", askableScopes: setup.askableScopes });
    if (!made.ok) throw new Error(`enrollment refused: ${made.reason}`);
    return { ...made, privateJwk: await exportJWK(pair.privateKey) };
  };

  describe("schema (rows only SQL can prove)", () => {
    it("cleanup rechecks after selection and cannot erase an approval committed by the shared role writer", async () => {
      const setup = await enrollmentHarness.setup();
      const enrollment = await startEnrollment(setup);
      await setup.lapse(enrollment.principalUserId);
      await setup.ageUnredeemed(enrollment.principalUserId);
      let selected!: () => void;
      let resume!: () => void;
      const selection = new Promise<void>((resolve) => { selected = resolve; });
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      let paused = false;
      const delayed = Object.assign(client().bind(null), {
        begin: <T>(fn: (tx: SqlTag) => Promise<T>): Promise<T> => client().begin(async (tx) => {
          const observed = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const rows = await tx(strings, ...values);
            if (!paused && strings.join("?").includes("LIMIT") && strings.join("?").includes("SELECT p.user_id FROM agent_principals")) {
              paused = true;
              selected();
              await resumed;
            }
            return rows;
          }, tx);
          return fn(observed);
        }),
      }) as CredentialSql;
      const maintenance = startEnrollment({ ...setup, store: createPostgresEnrollmentStore(delayed) }, "maintenance-trigger");
      try {
        await Promise.race([selection, maintenance.then(() => { throw new Error("cleanup never selected the abandoned principal"); })]);
        await setup.approve(enrollment.principalUserId, "knowledge:read");
        expect(await setup.hasLiveRole(enrollment.principalUserId, "knowledge:read")).toBe(true);
      } finally {
        resume();
        await maintenance;
      }
      expect(await setup.principalExists(enrollment.principalUserId)).toBe(true);
      expect(await setup.hasLiveRole(enrollment.principalUserId, "knowledge:read")).toBe(true);
      const hash = await hashAgentKey(enrollment.deviceCode);
      expect((await service`SELECT 1 FROM agent_service_enrollments WHERE device_code_hash = ${hash}`).length).toBe(1);
    });

    it("terminal history is retained while request maintenance and its index follow only open rows", async () => {
      const setup = await enrollmentHarness.setup();
      const enrollment = await startEnrollment(setup);
      const prefix = randomUUID();
      const cnf = JSON.stringify({ kty: "OKP", crv: "X25519", x: Buffer.alloc(32, 7).toString("base64url") });
      await service`INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, status, expires_at)
        SELECT ${prefix} || '-' || n, 'https://home.example', 'git-review', ${enrollment.principalUserId}, 'knowledge:read',
          ${prefix} || '-code-' || n, ${cnf}, 'expired', now() - interval '1 day'
        FROM generate_series(1, 5000) n`;
      const plan = await service`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id FROM agent_service_enrollments WHERE status = 'open' AND expires_at <= now()
        ORDER BY expires_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`;
      const explained = JSON.stringify(plan);
      expect(explained).toContain("agent_service_enrollments_open_expiry_idx");
      expect(explained).not.toContain('"Node Type":"Seq Scan"');
      await startEnrollment(setup); // same service, a new ask; retained history must not become the working set
      expect((await service`SELECT count(*)::int AS n FROM agent_service_enrollments WHERE jti LIKE ${`${prefix}-%`}`)[0]?.n).toBe(5000);
      expect((await service`SELECT count(*)::int AS n FROM agent_service_enrollments WHERE status = 'open'`)[0]?.n).toBe(1);
    });

    it("real role mutations retain the On control after Off and authorize the same confirmed credential again", async () => {
      const setup = await enrollmentHarness.setup();
      const enrollment = await startEnrollment(setup);
      const scope = "knowledge:read";
      const admin = await makeAdmin();
      const grants = createPostgresAgentGrantsStore(service as unknown as Parameters<typeof createPostgresAgentGrantsStore>[0]);
      const grant = { principalUserId: enrollment.principalUserId, scope, approvedBy: admin, declaredScopes: [scope] };
      await grantRole(grants, grant);
      const issued = await pollServiceEnrollment(setup.store, { deviceCode: enrollment.deviceCode });
      if (!issued.ok) throw new Error(`poll refused: ${issued.error}`);
      const key = await openSealed(issued.sealedKey, enrollment.privateJwk);
      expect(await confirmCredential(setup.credentials, { credentialId: issued.credentialId })).toMatchObject({ ok: true });
      const decision = () => authorizeCaller(grants, async () => "denied", { userId: enrollment.principalUserId, via: "bearer", requires: { scope, kind: "node", subject: "member" }, serviceKeyedOnly: true });
      expect(await decision()).toMatchObject({ decision: "allow" });
      await revokeRole(grants, { principalUserId: enrollment.principalUserId, scope });
      expect(await decision()).toMatchObject({ decision: "deny" });
      const controls = buildNodeAiView({ declarations: { [scope]: { label: "Read the knowledge base", description: "Read this node's knowledge." } }, scopesByPrincipal: {}, internal: [], rows: (await grants.listRoleRows(25, [scope])).rows });
      expect(controls).toEqual([expect.objectContaining({ principalUserId: enrollment.principalUserId, on: false })]);
      await grantRole(grants, grant);
      expect(await verifyBearer(setup.credentials, key)).toMatchObject({ ok: true, credentialId: issued.credentialId });
      expect(await decision()).toMatchObject({ decision: "allow" });
      expect((await service`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id = ${enrollment.principalUserId}`)[0]?.n).toBe(1);
      expect((await service`SELECT count(*)::int AS n FROM agent_roles WHERE principal_user_id = ${enrollment.principalUserId} AND revoked_at IS NOT NULL`)[0]?.n).toBe(1);
    });
    it("a poll blocked behind confirmation and revocation observes the committed confirmation and never inserts a replacement", async () => {
      await cleanup();
      const user = randomUUID();
      const admin = await makeAdmin();
      const codeHash = await hashAgentKey(randomUUID());
      const cnf = JSON.stringify({ kty: "OKP", crv: "X25519", x: Buffer.alloc(32, 7).toString("base64url") });
      await service`INSERT INTO users (id, name) VALUES (${user}, 'svc-confirm-race')`;
      await service`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', 'https://h.example#confirm-race', ${user})`;
      const grants = createPostgresAgentGrantsStore(service as unknown as Parameters<typeof createPostgresAgentGrantsStore>[0]);
      await grants.requestRole({ principalUserId: user, scope: "knowledge:read", maxPending: 5, maxPendingTotal: 25 });
      await grants.approvePending({ principalUserId: user, scope: "knowledge:read", approvedBy: admin });
      await service`INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
        VALUES (${randomUUID()}, 'https://h.example', 'confirm-race', ${user}, 'knowledge:read', ${codeHash}, ${cnf}, now() + interval '1 day')`;
      const input = { deviceCodeHash: codeHash, tokenHash: await hashAgentKey(randomUUID()), policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 }, intervalSec: 0 };
      const issued = await createPostgresEnrollmentStore(client()).poll(input);
      if (issued.state !== "issued") throw new Error(`expected pending issuance: ${issued.state}`);

      const applicationName = `enrollment-poll-${randomUUID()}`;
      const serviceUrl = process.env.DATABASE_SERVICE_URL;
      if (!serviceUrl) throw new Error("component PostgreSQL required");
      const pollClient = postgres(serviceUrl, { max: 1, connection: { application_name: applicationName } });
      const pollStore = createPostgresEnrollmentStore(pollClient as unknown as CredentialSql);
      let polling: ReturnType<typeof pollStore.poll> | undefined;
      try {
        await service.begin(async (tx) => {
          // Hold both writes uncommitted while the other connection reaches a coordinated authority lock.
          // Poll now locks the user before the credential; FK key-share locks can make it wait at that earlier lock.
          await tx`UPDATE agent_credentials SET confirmed_at = now() WHERE id = ${issued.credentialId}`;
          await tx`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = ${issued.credentialId}`;
          polling = pollStore.poll({ ...input, tokenHash: await hashAgentKey(randomUUID()) });
          await expect.poll(async () => {
            const rows = await service`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'
                AND (query LIKE '%agent_credentials%FOR UPDATE%' OR query LIKE '%SELECT id FROM users%FOR UPDATE%')`;
            return Number(rows[0]?.n);
          }, { timeout: 3000 }).toBe(1);
        });
        expect(await polling).toEqual({ state: "expired_token" });
        expect((await service`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id = ${user}`)[0]?.n).toBe(1);
        expect((await service`SELECT status FROM agent_service_enrollments WHERE device_code_hash = ${codeHash}`)[0]?.status).toBe("redeemed");
        expect(await grants.hasLiveRole(user, "knowledge:read")).toBe(true);
      } finally {
        await polling?.catch(() => undefined);
        await pollClient.end({ timeout: 1 });
      }
    });

    it("the app role sees no enrollment row (FORCE RLS, no policy) and cannot write one", async () => {
      await cleanup();
      expect(await app`SELECT 1 FROM agent_service_enrollments`).toHaveLength(0);
      await expect(
        app`INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
          VALUES ('j', 'https://h.example', 's', 'u', 'knowledge:read', 'h', '{}', now())`
      ).rejects.toThrow();
    });

    it("FAIL_CLOSED_ON_WRONG_ROLE: a store over the app role (no BYPASSRLS) is an outage, never 'no enrollment'", async () => {
      const wrong = createPostgresEnrollmentStore(app as unknown as CredentialSql);
      await expect(wrong.poll({ deviceCodeHash: "x", tokenHash: "y", policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 }, intervalSec: 5 })).rejects.toThrow(/BYPASSRLS/);
    });

    it("`jti` is unique in the database, and `service_key` names one principal", async () => {
      await cleanup();
      const user = randomUUID();
      await service`INSERT INTO users (id, name) VALUES (${user}, 'svc-unique')`;
      await service`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', 'https://h.example#svc', ${user})`;
      const other = randomUUID();
      await service`INSERT INTO users (id, name) VALUES (${other}, 'svc-unique-2')`;
      await expect(service`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', 'https://h.example#svc', ${other})`).rejects.toThrow();
      const insert = () =>
        service`INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
          VALUES ('same-jti', 'https://h.example', 'svc', ${user}, 'knowledge:read', ${randomUUID()}, '{}', now() + interval '1 day')`;
      await insert();
      await expect(insert()).rejects.toThrow();
      await service`DELETE FROM users WHERE id = ${other}`;
    });

    it("a key made by an enrollment carries created_from service_enrollment; confirming it kills every other unrevoked key of the principal in the same statement", async () => {
      await cleanup();
      const user = randomUUID();
      await service`INSERT INTO users (id, name) VALUES (${user}, 'svc-trigger')`;
      await service`INSERT INTO agent_principals (kind, service_key, user_id) VALUES ('external', 'https://h.example#trigger', ${user})`;
      const key = (from: string, confirmed: boolean) =>
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until, pending_expires_at, confirmed_at)
          VALUES (${user}, ${randomUUID()}, ${from}, now() + interval '30 days', now() + interval '44 days', now() + interval '15 minutes', ${confirmed ? service`now()` : null})
          RETURNING id`;
      const old = (await key("service_enrollment", true))[0]?.id as string;
      const rotation = (await key("rotation", false))[0]?.id as string;
      const fresh = (await key("service_enrollment", false))[0]?.id as string;
      await service`UPDATE agent_credentials SET confirmed_at = now() WHERE id = ${fresh}`;
      const state = async (id: string) => (await service`SELECT agent_credential_state(c) AS s FROM agent_credentials c WHERE c.id = ${id}`)[0]?.s;
      expect(await state(fresh)).toBe("active");
      expect(await state(old)).toBe("revoked");
      expect(await state(rotation)).toBe("revoked");
      // A confirm of a key made any other way never fires the trigger.
      const a = (await key("key_upgrade", true))[0]?.id as string;
      const b = (await key("rotation", false))[0]?.id as string;
      await service`UPDATE agent_credentials SET confirmed_at = now() WHERE id = ${b}`;
      expect(await state(a)).toBe("active");
      expect(await state(fresh)).toBe("active");
    });
  });
});
