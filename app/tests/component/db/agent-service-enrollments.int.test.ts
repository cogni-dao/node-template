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

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { randomUUID } from "node:crypto";
import { AgentRolesError, authorizeCaller, buildNodeAiView, grantRole, revokeRole, createPostgresAgentGrantsStore, type SqlTag } from "@cogni/agent-grants";
import { type CredentialSql, createPostgresCredentialStore, agentRolesHasRoles, hashAgentKey, confirmCredential, verifyBearer } from "@cogni/agent-grants/credentials";
import { maintenanceTick, createPostgresEnrollmentStore, pollServiceEnrollment, requestServiceEnrollment, openSealed, SERVICE_ENROLLMENT_KIND, serviceEnrollmentAudience, type ServiceEnrollmentClaims } from "@cogni/agent-grants/enrollment";
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
    await service`UPDATE agent_authority_maintenance SET next_run_at = clock_timestamp(), oldest_due_at = NULL WHERE id = 'service-enrollment'`;
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
        approve: async (principalUserId, scope) => {
          try { await grants.approvePending({ principalUserId, scope, approvedBy: admin }); }
          catch (error) { if (!(error instanceof AgentRolesError) || error.code !== "request_expired") throw error; }
        },
        dismiss: async (principalUserId, scope) => void (await grants.denyPending({ principalUserId, scope })),
        switchOff: async (principalUserId, scope) => void (await grants.revokeRole({ principalUserId, scope })),
        switchOn: async (principalUserId, scope) => void (await grants.restoreRevoked?.({ principalUserId, scope, approvedBy: admin })),
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
          await service`UPDATE agent_roles SET request_expires_at = now() - interval '1 second' WHERE principal_user_id = ${principalUserId} AND approved_by IS NULL`;
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
    it("maintenance locks and rechecks expiry; late approval refuses without erasing identity, consent or replay evidence", async () => {
      const setup = await enrollmentHarness.setup();
      const enrollment = await startEnrollment(setup);
      await setup.lapse(enrollment.principalUserId);
      let selected!: () => void;
      let resume!: () => void;
      const selection = new Promise<void>((resolve) => { selected = resolve; });
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      let paused = false;
      const delayed = Object.assign(client().bind(null), {
        begin: <T>(fn: (tx: SqlTag) => Promise<T>): Promise<T> => client().begin(async (tx) => {
          const observed = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const rows = await tx(strings, ...values);
            if (!paused && strings.join("?").includes("SELECT id, principal_user_id FROM agent_service_enrollments")) {
              paused = true; selected(); await resumed;
            }
            return rows;
          }, tx);
          return fn(observed);
        }),
      }) as CredentialSql;
      const tick = maintenanceTick(delayed);
      try {
        await Promise.race([selection, tick.then(() => { throw new Error("maintenance never selected expired receipt"); })]);
        await setup.approve(enrollment.principalUserId, "knowledge:read");
        expect(await setup.hasLiveRole(enrollment.principalUserId, "knowledge:read")).toBe(false);
      } finally { resume(); await tick; }
      expect(await setup.principalExists(enrollment.principalUserId)).toBe(true);
      const hash = await hashAgentKey(enrollment.deviceCode);
      expect((await service`SELECT status FROM agent_service_enrollments WHERE device_code_hash = ${hash}`)[0]?.status).toBe("expired");
      expect(await setup.pendingAsks(enrollment.principalUserId, "knowledge:read")).toBe(0);
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
                AND (query LIKE '%agent_credentials%FOR UPDATE%' OR query LIKE '%pg_advisory_xact_lock%' OR query LIKE '%agent_principals%FOR UPDATE%')`;
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

    it("direct confirmation obeys receipt eligibility and retires only bounded usable siblings", async () => {
      const setup = await enrollmentHarness.setup();
      const enrollment = await startEnrollment(setup);
      await setup.approve(enrollment.principalUserId, "knowledge:read");
      const user = enrollment.principalUserId;
      const old = (await service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until, pending_expires_at, confirmed_at)
        VALUES (${user}, ${randomUUID()}, 'key_upgrade', now() + interval '29 days', now() + interval '43 days', now() + interval '15 minutes', now()) RETURNING id`)[0]?.id as string;
      const rotation = await setup.credentials.issueSuccessor({ predecessorId: old, tokenHash: randomUUID(), policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 } });
      if (!rotation.ok) throw new Error("rotation refused");
      const fresh = await pollServiceEnrollment(setup.store, { deviceCode: enrollment.deviceCode });
      if (!fresh.ok) throw new Error("poll refused");
      await service`UPDATE agent_credentials SET confirmed_at = clock_timestamp() WHERE id = ${fresh.credentialId}`;
      const state = async (id: string) => (await service`SELECT agent_credential_state(c) AS s FROM agent_credentials c WHERE c.id = ${id}`)[0]?.s;
      expect(await state(fresh.credentialId)).toBe("active");
      expect(await state(old)).toBe("revoked");
      expect(await state(rotation.credentialId)).toBe("revoked");
      const summary = (await service`SELECT ever_confirmed, first_confirmed_at FROM agent_principals WHERE user_id = ${user}`)[0];
      expect(summary?.ever_confirmed).toBe(true);
      expect(summary?.first_confirmed_at).toBeTruthy();
      await expect(service`UPDATE agent_principals SET ever_confirmed = false WHERE user_id = ${user}`).rejects.toThrow();
      await expect(service`UPDATE agent_credentials SET confirmed_at = NULL WHERE id = ${fresh.credentialId}`).rejects.toThrow();
    });

    it("direct first activation after expiry refuses while ordinary rotation outlives the receipt", async () => {
      const setup = await enrollmentHarness.setup();
      const e = await startEnrollment(setup);
      await setup.approve(e.principalUserId, "knowledge:read");
      const issued = await pollServiceEnrollment(setup.store, { deviceCode: e.deviceCode });
      if (!issued.ok) throw new Error("poll refused");
      await setup.lapse(e.principalUserId);
      await expect(service`UPDATE agent_credentials SET confirmed_at = clock_timestamp() WHERE id = ${issued.credentialId}`).rejects.toThrow();
      expect(await setup.hasLiveRole(e.principalUserId, "knowledge:read")).toBe(true);
      const next = await startEnrollment(setup);
      const fresh = await pollServiceEnrollment(setup.store, { deviceCode: next.deviceCode });
      if (!fresh.ok) throw new Error("poll refused");
      await confirmCredential(setup.credentials, { credentialId: fresh.credentialId });
      await setup.lapse(e.principalUserId);
      const successor = await setup.credentials.issueSuccessor({ predecessorId: fresh.credentialId, tokenHash: randomUUID(), policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 } });
      if (!successor.ok) throw new Error("rotation refused");
      expect(await setup.credentials.confirm({ credentialId: successor.credentialId, policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 } })).toMatchObject({ ok: true });
    });

    it("a direct credential writer fails serialization instead of waiting behind an earlier authority advisory", async () => {
      const setup = await enrollmentHarness.setup();
      const e = await startEnrollment(setup);
      await setup.approve(e.principalUserId, "knowledge:read");
      const key = await pollServiceEnrollment(setup.store, { deviceCode: e.deviceCode });
      if (!key.ok) throw new Error("poll refused");
      await service.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${e.principalUserId}))`;
        await expect(service`UPDATE agent_credentials SET confirmed_at = clock_timestamp() WHERE id = ${key.credentialId}`)
          .rejects.toMatchObject({ code: "40001" });
      });
      expect((await service`SELECT confirmed_at FROM agent_credentials WHERE id = ${key.credentialId}`)[0]?.confirmed_at).toBeNull();
      expect(await confirmCredential(setup.credentials, { credentialId: key.credentialId })).toMatchObject({ ok: true });
    });

    it("approval and confirm waiting on the user lock recheck wall-clock deadlines after acquiring it", async () => {
      const setup = await enrollmentHarness.setup();
      const e = await startEnrollment(setup);
      const admin = await makeAdmin();
      const serviceUrl = process.env.DATABASE_SERVICE_URL;
      if (!serviceUrl) throw new Error("component PostgreSQL required");
      const name = `deadline-writer-${randomUUID()}`;
      const other = postgres(serviceUrl, { max: 1, connection: { application_name: name } });
      const grants = createPostgresAgentGrantsStore(other as unknown as SqlTag);
      const credentials = createPostgresCredentialStore(other as unknown as CredentialSql, { hasRoles: async () => false });
      const blocked = async () => expect.poll(async () => Number((await service`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = ${name} AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`)[0]?.n), { timeout: 3000 }).toBe(1);
      let approving: Promise<boolean> | undefined;
      let confirming: ReturnType<typeof credentials.confirm> | undefined;
      try {
        await service.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${e.principalUserId}))`;
          approving = grants.approvePending({ principalUserId: e.principalUserId, scope: "knowledge:read", approvedBy: admin });
          await blocked();
          await tx`UPDATE agent_roles SET request_expires_at = clock_timestamp() - interval '1 second'
            WHERE principal_user_id = ${e.principalUserId} AND approved_by IS NULL`;
        });
        await expect(approving).rejects.toMatchObject({ code: "request_expired" });
        await service`UPDATE agent_roles SET request_expires_at = clock_timestamp() + interval '1 hour' WHERE principal_user_id = ${e.principalUserId}`;
        await setup.approve(e.principalUserId, "knowledge:read");
        const issued = await pollServiceEnrollment(setup.store, { deviceCode: e.deviceCode });
        if (!issued.ok) throw new Error("poll refused");
        await service.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${e.principalUserId}))`;
          confirming = credentials.confirm({ credentialId: issued.credentialId, policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 } });
          await blocked();
          await tx`UPDATE agent_service_enrollments SET expires_at = clock_timestamp() - interval '1 second' WHERE principal_user_id = ${e.principalUserId}`;
        });
        expect(await confirming).toMatchObject({ ok: false, reason: "expired" });
        expect((await service`SELECT confirmed_at FROM agent_credentials WHERE id = ${issued.credentialId}`)[0]?.confirmed_at).toBeNull();
      } finally { await approving?.catch(() => undefined); await confirming?.catch(() => undefined); await other.end({ timeout: 1 }); }
    });

    it("all retained service Off controls remain reachable through keyset pages beyond25 identities", async () => {
      await enrollmentHarness.setup();
      const admin = await makeAdmin();
      const scope = "knowledge:read";
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const id = randomUUID(); ids.push(id);
        await service`INSERT INTO users (id, name) VALUES (${id}, ${`paged-service-${i}`})`;
        await service`INSERT INTO agent_principals (kind, user_id, service_key) VALUES ('external', ${id}, ${`https://paging.example#service-${i}`})`;
        await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, revoked_at)
          VALUES (${id}, ${scope}, ${admin}, now(), now())`;
      }
      const grants = createPostgresAgentGrantsStore(client());
      const first = await grants.listRoleRows(25, [scope]);
      expect(first.nextCursor).toBeTruthy();
      const second = await grants.listRoleRows(25, [scope], first.nextCursor ?? undefined);
      expect(second.nextCursor).toBeNull();
      const controls = [...first.rows, ...second.rows].filter((r) => ids.includes(r.principalUserId));
      expect(new Set(controls.map((r) => r.principalUserId)).size).toBe(40);
      expect(controls.every((r) => r.state === "revoked")).toBe(true);
      ids.sort();
      const last = ids[ids.length - 1];
      if (!last) throw new Error("missing last control");
      expect(await grants.restoreRevoked?.({ principalUserId: last, scope, approvedBy: admin })).toBe(true);
      expect(await grants.hasLiveRole(last, scope)).toBe(true);
    });

    it("maintenance is leased and bounded; expired approved identities and children persist with purge disabled", async () => {
      const setup = await enrollmentHarness.setup();
      const first = await startEnrollment(setup);
      await setup.approve(first.principalUserId, "knowledge:read");
      const prefix = randomUUID();
      const cnf = JSON.stringify({ kty: "OKP", crv: "X25519", x: Buffer.alloc(32, 7).toString("base64url") });
      await service`UPDATE agent_service_enrollments SET expires_at = now() - interval '1 second' WHERE principal_user_id = ${first.principalUserId}`;
      await service`INSERT INTO agent_service_enrollments (jti, issuer, service, principal_user_id, scope, device_code_hash, cnf_jwk, expires_at)
        SELECT ${prefix} || '-' || n, 'https://home.example', 'git-review', ${first.principalUserId}, 'knowledge:read', ${prefix} || '-code-' || n, ${cnf}, now() - interval '1 second' FROM generate_series(1, 24) n`;
      await service`UPDATE agent_authority_maintenance SET next_run_at = now() WHERE id = 'service-enrollment'`;
      const results = await Promise.all([maintenanceTick(client()), maintenanceTick(client())]);
      expect(results.map((r) => r.processed).sort((a,b) => a-b)).toEqual([0,20]);
      expect((await service`SELECT count(*)::int AS n FROM agent_service_enrollments WHERE status = 'open'`)[0]?.n).toBe(5);
      expect((await service`SELECT count(*)::int AS n FROM agent_service_enrollments`)[0]?.n).toBe(25);
      expect(await setup.hasLiveRole(first.principalUserId, "knowledge:read")).toBe(true);
      expect(await setup.principalExists(first.principalUserId)).toBe(true);
      expect((await service`SELECT purge_enabled, minimum_reader_build FROM agent_authority_maintenance WHERE id = 'service-enrollment'`)[0]).toMatchObject({ purge_enabled: false, minimum_reader_build: null });
    });

  });
});


// CI only: the real runner migrates a disposable database from immutable0042, with pre-existing historical confirmations.
describe("service authority forward migration", () => {
  it("backfills every confirmation atomically and keeps purge disabled; lock timeout rolls back before retry", async () => {
    const container = await new PostgreSqlContainer("postgres:15-alpine").start();
    const db = postgres(container.getConnectionUri(), { max: 3 });
    const directory = await mkdtemp(join(tmpdir(), "authority-foundation-"));
    const migrations = resolve("src/adapters/server/db/migrations");
    const previous = join(directory, "previous");
    const run = (folder: string) => promisify(execFile)(process.execPath, [resolve("../scripts/db/migrate.mjs"), folder], {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri(), NODE_NAME: "node-template" }, timeout: 90000,
    });
    try {
      await cp(migrations, previous, { recursive: true });
      const journalPath = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 42);
      await writeFile(journalPath, JSON.stringify(journal));
      expect((await run(previous)).stdout).toContain("migrations applied");
      const ids = { active: randomUUID(), revoked: randomUUID(), expired: randomUUID(), multiple: randomUUID(), never: randomUUID() };
      const first = new Date("2026-01-01T00:00:00.000Z");
      for (const [kind, user] of Object.entries(ids)) {
        await db`INSERT INTO users (id, name) VALUES (${user}, ${kind})`;
        await db`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${user})`;
        if (kind === "never") continue;
        await db`INSERT INTO agent_credentials (user_id, token_hash, created_from, confirmed_at, expires_at, renew_until, revoked_at)
          VALUES (${user}, ${randomUUID()}, 'key_upgrade', ${first},
            ${kind === "expired" ? new Date("2026-01-02T00:00:00Z") : new Date("2099-01-01T00:00:00Z")},
            ${kind === "expired" ? new Date("2026-01-03T00:00:00Z") : new Date("2099-01-02T00:00:00Z")},
            ${kind === "revoked" ? first : null})`;
        if (kind === "multiple") await db`INSERT INTO agent_credentials (user_id, token_hash, created_from, confirmed_at, expires_at, renew_until, revoked_at)
          VALUES (${user}, ${randomUUID()}, 'key_upgrade', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z', '2026-02-03T00:00:00Z', '2026-02-02T00:00:00Z')`;
      }
      // Credential mutation blocks0043's bounded quiescence. The runner must fail with no partial schema/state qualification.
      await db.begin(async (tx) => {
        await tx`UPDATE agent_credentials SET revoked_reason = 'fixture' WHERE user_id = ${ids.active}`;
        await expect(run(migrations)).rejects.toThrow();
        expect((await tx`SELECT to_regclass('public.agent_authority_maintenance') AS relation`)[0]?.relation).toBeNull();
      });
      expect((await run(migrations)).stdout).toContain("0043_service_authority_foundation");
      const store = createPostgresCredentialStore(db as unknown as CredentialSql, { hasRoles: async () => false });
      for (const [kind, user] of Object.entries(ids)) {
        const row = (await db`SELECT ever_confirmed, first_confirmed_at FROM agent_principals WHERE user_id = ${user}`)[0];
        expect(row?.ever_confirmed).toBe(kind !== "never");
        expect(row?.first_confirmed_at?.toISOString() ?? null).toBe(kind === "never" ? null : first.toISOString());
        expect(await store.everConfirmed(user)).toBe(kind !== "never");
      }
      expect((await db`SELECT backfill_ready, purge_enabled, minimum_reader_build FROM agent_authority_maintenance WHERE id = 'service-enrollment'`)[0])
        .toMatchObject({ backfill_ready: true, purge_enabled: false, minimum_reader_build: null });
      // Purge is not enabled/executed. A compatible reader must still OR the historical source if a pre-summary row is encountered.
      await expect(db`UPDATE agent_principals SET first_confirmed_at = NULL WHERE user_id = ${ids.multiple}`).rejects.toThrow();
    } finally {
      await db.end({ timeout: 1 });
      await container.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }, 180000);
});
