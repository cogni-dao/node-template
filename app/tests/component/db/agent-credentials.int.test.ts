// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-credentials.int.test`
 * Purpose: The revocable agent key store against real Postgres with migrations 0039-0041 applied (task.0070, task.0091). Runs the package's OWN conformance suite
 *   (`runCredentialConformance`, SUITE_GATES_RELEASE) over the real SQL, then the rows only SQL can prove: the RLS wall, the
 *   external-principal trigger, hash uniqueness, the renew check and the same-users.id upgrade.
 * Scope: `@cogni-dao/agent-grants/credentials` + migration 0039. No HTTP.
 * Invariants:
 *   - SERVICE_ROLE_ONLY: the app role sees no `agent_credentials` row.
 *   - TOKEN_HASH_ONLY: only the sha256 of a key is stored.
 *   - STATE_IS_DERIVED: moving a timestamp moves the state; nothing else is written.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: DATABASE_SERVICE_URL = BYPASSRLS; DATABASE_URL = app role with FORCE RLS.
 * Links: app/src/adapters/server/db/migrations/0039_agent_credentials.sql
 */

import { randomUUID } from "node:crypto";
import { runCredentialConformance } from "@cogni/agent-grants/conformance";
import {
  agentRolesHasRoles,
  assertV1NotSuperseded,
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  hashAgentKey,
  type MintedKey,
  rotateCredential,
  upgradeSignedKey,
  verifyBearer,
} from "@cogni/agent-grants/credentials";
import { NODE_AI_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("agent credentials (real Postgres)", () => {
  let service: Sql;
  let app: Sql;
  const users: string[] = [];
  const makeUser = async () => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`cred-${id.slice(0, 6)}`})`;
    users.push(id);
    return id;
  };
  const store = () =>
    createPostgresCredentialStore(service as unknown as CredentialSql, { hasRoles: agentRolesHasRoles(service as unknown as CredentialSql) });
  const ok = (m: MintedKey) => {
    if (!m.ok) throw new Error(`refused: ${m.reason}`);
    return m;
  };
  const stateOf = async (credentialId: string) =>
    (await service`SELECT agent_credential_state(c) AS state FROM agent_credentials c WHERE c.id = ${credentialId}`)[0]?.state;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 8 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_proof_challenges WHERE principal_user_id = ANY($1) OR principal_user_id IS NULL", [users]);
    await service?.unsafe("DELETE FROM agent_stops WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_credentials WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    // identity_events is append-only (a trigger refuses DELETE) and references users: a user that was bound keeps its row (the test database is throwaway).
    await service?.unsafe("DELETE FROM users u WHERE u.id = ANY($1) AND NOT EXISTS (SELECT 1 FROM identity_events e WHERE e.user_id = u.id)", [users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  // The package's own conformance rows over the real SQL adapter. Users are real rows; timestamps move with UPDATE
  // because the database clock keeps its own time.
  runCredentialConformance({
    describe,
    it,
    expect,
    async setup(facts) {
      // The proof limits (per hour, GitHub budget) are node-wide counts: every row starts from an empty challenge table.
      await service`DELETE FROM agent_proof_challenges`;
      const ids: Record<string, string> = {};
      for (const [name, f] of Object.entries(facts)) {
        const id = await makeUser();
        ids[name] = id;
        const admin = f.roles ? await makeUser() : null;
        if (f.wallet)
          await service`UPDATE users SET wallet_address = ${`0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`} WHERE id = ${id}`;
        if (f.internal) await service`INSERT INTO agent_principals (kind, slug, user_id) VALUES ('internal', ${`conf-${id}`}, ${id})`;
        if (f.agent) await service`INSERT INTO agent_principals (kind, user_id) VALUES ('external', ${id}) ON CONFLICT (user_id) DO NOTHING`;
        if (f.roles)
          await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${id}, 'probe:scope', ${admin}, now())`;
        if (f.github || f.githubId)
          await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'github', ${f.githubId ?? `gh-${randomUUID()}`})`;
      }
      return { store: store(), ids };
    },
    async age(credentialId, to) {
      if (to === "pending_expired")
        await service`UPDATE agent_credentials SET pending_expires_at = now() - interval '1 second' WHERE id = ${credentialId}`;
      else if (to === "renew_only")
        await service`UPDATE agent_credentials SET expires_at = now() - interval '1 hour', renew_until = now() + interval '1 day' WHERE id = ${credentialId}`;
      else
        await service`UPDATE agent_credentials SET expires_at = now() - interval '2 hour', renew_until = now() - interval '1 minute' WHERE id = ${credentialId}`;
    },
    async addRoles(userId) {
      const admin = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${userId}, 'probe:scope', ${admin}, now())`;
    },
    broken: () =>
      createPostgresCredentialStore(
        (async () => {
          throw new Error("db down");
        }) as unknown as CredentialSql,
        { hasRoles: async () => false }
      ),
    storedHash: async (credentialId) =>
      (await service`SELECT token_hash FROM agent_credentials WHERE id = ${credentialId}`)[0]?.token_hash ?? null,
    liveSuccessors: async (predecessorId) =>
      (await service`SELECT count(*)::int AS n FROM agent_credentials WHERE predecessor_id = ${predecessorId} AND confirmed_at IS NULL AND revoked_at IS NULL`)[0]?.n ?? 0,
    async expireChallenge(challengeId) {
      await service`UPDATE agent_proof_challenges SET expires_at = now() - interval '1 second' WHERE id = ${challengeId}::uuid`;
    },
    async challengeInfo(challengeId) {
      const row = (await service`SELECT attempts, consumed_at FROM agent_proof_challenges WHERE id = ${challengeId}::uuid`)[0];
      return row ? { attempts: Number(row.attempts), consumed: row.consumed_at !== null } : null;
    },
    credentialRows: async (userId) => Number((await service`SELECT count(*)::int AS n FROM agent_credentials WHERE user_id = ${userId}`)[0]?.n ?? 0),
    githubBindings: async (userId) =>
      (await service`SELECT external_id FROM user_bindings WHERE user_id = ${userId} AND provider = 'github'`).map((r) => String(r.external_id)),
    bindEvents: async (userId) =>
      Number((await service`SELECT count(*)::int AS n FROM identity_events WHERE user_id = ${userId} AND event_type = 'bind'`)[0]?.n ?? 0),
  });

  describe("schema (rows only SQL can prove)", () => {
    it("the app role sees no credential row (FORCE RLS, no policy) and cannot write one", async () => {
      const user = await makeUser();
      ok(await upgradeSignedKey(store(), { userId: user }));
      expect(await app`SELECT 1 FROM agent_credentials`).toHaveLength(0);
      await expect(
        app`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, 'x', 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow();
    });

    it("the proof tables are service-role only: the app role sees no challenge and no stop row, and cannot write one (migration 0041)", async () => {
      const user = await makeUser();
      await service`INSERT INTO agent_stops (user_id, stopped_by) VALUES (${user}, ${user})`;
      await service`INSERT INTO agent_proof_challenges (purpose, nonce_hash, secret_hash, principal_user_id, expires_at)
        VALUES ('bind', 'n', 's', ${user}, now() + interval '10 minutes')`;
      expect(await app`SELECT 1 FROM agent_stops`).toHaveLength(0);
      expect(await app`SELECT 1 FROM agent_proof_challenges`).toHaveLength(0);
      await expect(app`INSERT INTO agent_stops (user_id, stopped_by) VALUES (${user}, 'x')`).rejects.toThrow();
      // A bind challenge needs a principal; the purpose is canonical.
      await expect(
        service`INSERT INTO agent_proof_challenges (purpose, nonce_hash, secret_hash, expires_at) VALUES ('bind', 'n', 's', now() + interval '1 minute')`
      ).rejects.toThrow();
      await expect(
        service`INSERT INTO agent_proof_challenges (purpose, nonce_hash, secret_hash, expires_at) VALUES ('enroll', 'n', 's', now() + interval '1 minute')`
      ).rejects.toThrow();
    });

    it("FAIL_CLOSED_ON_WRONG_ROLE: a store over the app role (no BYPASSRLS, FORCE RLS) is unavailable, never 'never confirmed'", async () => {
      const user = await makeUser();
      const key = ok(await upgradeSignedKey(store(), { userId: user }));
      await confirmCredential(store(), { credentialId: key.credentialId });
      const wrongRole = createPostgresCredentialStore(app as unknown as CredentialSql, { hasRoles: async () => false });
      // The raw read the old store did returns zero rows for this role: the gate would have silently turned off.
      expect(await app`SELECT 1 FROM agent_credentials WHERE user_id = ${user} AND confirmed_at IS NOT NULL LIMIT 1`).toHaveLength(0);
      await expect(assertV1NotSuperseded(wrongRole, user)).rejects.toMatchObject({ code: "authz_unavailable" });
      expect(await verifyBearer(wrongRole, key.apiKey)).toEqual({ ok: false, reason: "unavailable" });
      // The right role still reads the confirmed credential.
      await expect(assertV1NotSuperseded(store(), user)).rejects.toMatchObject({ code: "v1_superseded" });
    });

    it("hasRoles is the node's read: a true answer refuses upgrade without a binding even with no agent_roles row; a throw is an outage", async () => {
      const user = await makeUser();
      const sql = service as unknown as CredentialSql;
      const openFga = createPostgresCredentialStore(sql, { hasRoles: async () => true });
      expect(await upgradeSignedKey(openFga, { userId: user })).toEqual({ ok: false, reason: "binding_required" });
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${user}, 'github', ${`gh-${randomUUID()}`})`;
      expect(await upgradeSignedKey(openFga, { userId: user })).toMatchObject({ ok: true });
      const down = createPostgresCredentialStore(sql, {
        hasRoles: async () => {
          throw new Error("openfga down");
        },
      });
      await expect(upgradeSignedKey(down, { userId: user })).rejects.toMatchObject({ code: "authz_unavailable" });
    });

    it("only a user with an EXTERNAL agent principal may hold a credential (trigger)", async () => {
      const plain = await makeUser();
      const insert = (userId: string) =>
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${userId}, ${randomUUID()}, 'key_upgrade', now() + interval '1 day', now() + interval '2 day')`;
      await expect(insert(plain)).rejects.toThrow(/requires an external agent principal/);
      await expect(insert(NODE_AI_PRINCIPAL_USER_ID)).rejects.toThrow(/requires an external agent principal/);
    });

    it("a duplicate hash is refused, and renew_until must pass expires_at", async () => {
      const user = await makeUser();
      const key = ok(await upgradeSignedKey(store(), { userId: user }));
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${await hashAgentKey(key.apiKey)}, 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_token_hash_unique/);
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${randomUUID()}, 'rotation', now() + interval '2 day', now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_renew_after_expiry/);
    });

    it("the state function derives from timestamps alone", async () => {
      const key = ok(await upgradeSignedKey(store(), { userId: await makeUser() }));
      expect(await stateOf(key.credentialId)).toBe("pending");
      await confirmCredential(store(), { credentialId: key.credentialId });
      expect(await stateOf(key.credentialId)).toBe("active");
      expect(await verifyBearer(store(), key.apiKey)).toMatchObject({ ok: true });
    });

    it("upgrade writes an external principal on the SAME users.id and creates no second user", async () => {
      const user = await makeUser();
      // Other component files insert users into this shared database in parallel, so never count ALL users: scope every fact to this principal.
      const name = (await service`SELECT name FROM users WHERE id = ${user}`)[0]?.name as string;
      const key = ok(await upgradeSignedKey(store(), { userId: user }));
      expect(key.userId).toBe(user);
      expect(await service`SELECT user_id FROM agent_credentials WHERE id = ${key.credentialId}`).toEqual([expect.objectContaining({ user_id: user })]);
      expect((await service`SELECT count(*)::int AS n FROM users WHERE id = ${user}`)[0]?.n).toBe(1);
      expect((await service`SELECT count(*)::int AS n FROM users WHERE name = ${name}`)[0]?.n).toBe(1); // no second user minted for this principal
      expect(await service`SELECT kind FROM agent_principals WHERE user_id = ${user}`).toEqual([expect.objectContaining({ kind: "external" })]);
    });

    it("confirm refuses when the predecessor was revoked meanwhile (409 predecessor_revoked)", async () => {
      const user = await makeUser();
      const old = ok(await upgradeSignedKey(store(), { userId: user }));
      await confirmCredential(store(), { credentialId: old.credentialId });
      const next = ok(await rotateCredential(store(), { credentialId: old.credentialId }));
      await service`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'probe' WHERE id = ${old.credentialId}`;
      expect(await confirmCredential(store(), { credentialId: next.credentialId })).toEqual({ ok: false, reason: "predecessor_revoked" });
    });
  });
});
