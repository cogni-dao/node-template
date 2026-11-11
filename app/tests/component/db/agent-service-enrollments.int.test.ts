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
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS. Every `setup()` removes ALL enrollment principals first: this file is
 *   the only writer of `agent_principals.service_key`, and the caps (5 open enrollments, 25 agents) are node-wide.
 * Links: app/src/adapters/server/db/migrations/0041_agent_service_enrollments.sql
 */

import { randomUUID } from "node:crypto";
import { createPostgresAgentGrantsStore } from "@cogni/agent-grants";
import { type CredentialSql, createPostgresCredentialStore, agentRolesHasRoles, hashAgentKey } from "@cogni/agent-grants/credentials";
import { createPostgresEnrollmentStore } from "@cogni/agent-grants/enrollment";
import { runEnrollmentConformance } from "@cogni/agent-grants/enrollment-conformance";
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

  runEnrollmentConformance({
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
  });

  describe("schema (rows only SQL can prove)", () => {
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
