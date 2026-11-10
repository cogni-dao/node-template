// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-credentials.int.test`
 * Purpose: The v2 agent key store against real Postgres with migration 0039 applied (task.0070): the same conformance rows as the package suite,
 *   run over the real SQL: the derived state function and the database clock, the RLS wall, the external-principal trigger, upgrade on the
 *   same users.id, rotate/confirm/supersede/revoke, and idempotent confirm.
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
import {
  type CredentialSql,
  confirmCredential,
  createPostgresCredentialStore,
  hashAgentKey,
  type MintedKey,
  revokeCredential,
  rotateCredential,
  upgradeFromV1,
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
  const store = () => createPostgresCredentialStore(service as unknown as CredentialSql);
  const ok = (m: MintedKey) => {
    if (!m.ok) throw new Error(`refused: ${m.reason}`);
    return m;
  };
  const activeKey = async (userId: string) => {
    const key = ok(await upgradeFromV1(store(), { userId }));
    await confirmCredential(store(), { credentialId: key.credentialId });
    return key;
  };
  const stateOf = async (credentialId: string) =>
    (await service`SELECT agent_credential_state(c) AS state FROM agent_credentials c WHERE c.id = ${credentialId}`)[0]?.state;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_credentials WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM user_bindings WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  describe("schema", () => {
    it("the app role sees no credential row (FORCE RLS, no policy) and cannot write one", async () => {
      const user = await makeUser();
      await activeKey(user);
      expect(await app`SELECT 1 FROM agent_credentials`).toHaveLength(0);
      await expect(
        app`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, 'x', 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow();
    });

    it("only a user with an EXTERNAL agent principal may hold a credential (trigger)", async () => {
      const plain = await makeUser();
      const insert = (userId: string) =>
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${userId}, ${randomUUID()}, 'legacy_upgrade', now() + interval '1 day', now() + interval '2 day')`;
      await expect(insert(plain)).rejects.toThrow(/requires an external agent principal/);
      await expect(insert(NODE_AI_PRINCIPAL_USER_ID)).rejects.toThrow(/requires an external agent principal/);
    });

    it("stores only the sha256 hash, a duplicate hash is refused, and renew_until must pass expires_at", async () => {
      const user = await makeUser();
      const key = ok(await upgradeFromV1(store(), { userId: user }));
      const rows = await service`SELECT token_hash FROM agent_credentials WHERE id = ${key.credentialId}`;
      expect(rows[0]?.token_hash).toBe(await hashAgentKey(key.apiKey));
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${await hashAgentKey(key.apiKey)}, 'rotation', now(), now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_token_hash_unique/);
      await expect(
        service`INSERT INTO agent_credentials (user_id, token_hash, created_from, expires_at, renew_until)
          VALUES (${user}, ${randomUUID()}, 'rotation', now() + interval '2 day', now() + interval '1 day')`
      ).rejects.toThrow(/agent_credentials_renew_after_expiry/);
    });
  });

  describe("verify and derived state (database clock)", () => {
    it("valid v2 key resolves; wrong hash and a v1 key are invalid", async () => {
      const user = await makeUser();
      const key = await activeKey(user);
      expect(await verifyBearer(store(), key.apiKey)).toMatchObject({ ok: true, userId: user, state: "active" });
      expect(await verifyBearer(store(), `${key.apiKey.slice(0, -1)}${key.apiKey.endsWith("A") ? "B" : "A"}`)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), "cogni_ag_sk_v1_a.b")).toEqual({ ok: false, reason: "invalid" });
    });

    it("moving timestamps moves the state: expired, renew_only, expired past the window, pending_expired", async () => {
      const user = await makeUser();
      const key = await activeKey(user);
      await service`UPDATE agent_credentials SET expires_at = now() - interval '1 hour', renew_until = now() + interval '1 day' WHERE id = ${key.credentialId}`;
      expect(await stateOf(key.credentialId)).toBe("renew_only");
      expect(await verifyBearer(store(), key.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), key.apiKey, ["active", "renew_only"])).toMatchObject({ ok: true, state: "renew_only" });
      await service`UPDATE agent_credentials SET renew_until = now() - interval '1 minute' WHERE id = ${key.credentialId}`;
      expect(await stateOf(key.credentialId)).toBe("expired");

      const pending = ok(await upgradeFromV1(store(), { userId: await makeUser() }));
      expect(await stateOf(pending.credentialId)).toBe("pending");
      await service`UPDATE agent_credentials SET pending_expires_at = now() - interval '1 second' WHERE id = ${pending.credentialId}`;
      expect(await stateOf(pending.credentialId)).toBe("pending_expired");
      expect(await confirmCredential(store(), { credentialId: pending.credentialId })).toEqual({ ok: false, reason: "expired" });
    });

    it("a store failure is `unavailable`, never `invalid`", async () => {
      const broken = createPostgresCredentialStore((async () => {
        throw new Error("db down");
      }) as unknown as CredentialSql);
      expect(await verifyBearer(broken, `cogni_ag_sk_v2_${"a".repeat(43)}`)).toEqual({ ok: false, reason: "unavailable" });
    });
  });

  describe("upgrade", () => {
    it("writes an external principal on the SAME users.id, never a second user", async () => {
      const user = await makeUser();
      const before = (await service`SELECT count(*)::int AS n FROM users`)[0]?.n;
      const key = ok(await upgradeFromV1(store(), { userId: user }));
      expect(key.userId).toBe(user);
      expect((await service`SELECT count(*)::int AS n FROM users`)[0]?.n).toBe(before);
      expect(await service`SELECT kind FROM agent_principals WHERE user_id = ${user}`).toEqual([expect.objectContaining({ kind: "external" })]);
    });

    it("supersedes an unconfirmed upgrade, and refuses once a live v2 key exists", async () => {
      const user = await makeUser();
      const first = ok(await upgradeFromV1(store(), { userId: user }));
      const second = ok(await upgradeFromV1(store(), { userId: user }));
      expect(await stateOf(first.credentialId)).toBe("revoked");
      await confirmCredential(store(), { credentialId: second.credentialId });
      expect(await upgradeFromV1(store(), { userId: user })).toEqual({ ok: false, reason: "already_upgraded" });
    });

    it("refuses a wallet user, an internal principal, and an unknown user", async () => {
      const wallet = await makeUser();
      await service`UPDATE users SET wallet_address = ${`0x${randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40)}`} WHERE id = ${wallet}`;
      expect(await upgradeFromV1(store(), { userId: wallet })).toEqual({ ok: false, reason: "wallet_user" });
      expect(await upgradeFromV1(store(), { userId: NODE_AI_PRINCIPAL_USER_ID })).toEqual({ ok: false, reason: "internal_principal" });
      expect(await upgradeFromV1(store(), { userId: randomUUID() })).toEqual({ ok: false, reason: "unknown_user" });
    });

    it("C5: a user with a live role row and no GitHub binding is refused; with a binding it upgrades", async () => {
      const user = await makeUser();
      const admin = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${user}, 'probe:scope', ${admin}, now())`;
      expect(await upgradeFromV1(store(), { userId: user })).toEqual({ ok: false, reason: "binding_required" });
      await service`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${user}, 'github', ${`gh-${randomUUID()}`})`;
      expect(await upgradeFromV1(store(), { userId: user })).toMatchObject({ ok: true });
    });
  });

  describe("rotate, confirm, revoke", () => {
    it("rotate + confirm swap keys for the same user; the old key dies at confirm; confirm replays as already_active", async () => {
      const user = await makeUser();
      const old = await activeKey(user);
      const next = ok(await rotateCredential(store(), { credentialId: old.credentialId }));
      expect(next.userId).toBe(user);
      expect(await verifyBearer(store(), next.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), old.apiKey)).toMatchObject({ ok: true });
      const first = await confirmCredential(store(), { credentialId: next.credentialId });
      const replay = await confirmCredential(store(), { credentialId: next.credentialId });
      expect(first).toMatchObject({ ok: true, status: "confirmed" });
      expect(replay).toMatchObject({ ok: true, status: "already_active" });
      expect(await verifyBearer(store(), old.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), next.apiKey)).toMatchObject({ ok: true, userId: user });
    });

    it("a repeat rotate supersedes the first pending key: exactly one live pending successor", async () => {
      const user = await makeUser();
      const old = await activeKey(user);
      const first = ok(await rotateCredential(store(), { credentialId: old.credentialId }));
      const second = ok(await rotateCredential(store(), { credentialId: old.credentialId }));
      expect(await stateOf(first.credentialId)).toBe("revoked");
      expect(await stateOf(second.credentialId)).toBe("pending");
      expect(await confirmCredential(store(), { credentialId: first.credentialId })).toEqual({ ok: false, reason: "revoked" });
      const live = await service`SELECT 1 FROM agent_credentials WHERE predecessor_id = ${old.credentialId} AND confirmed_at IS NULL AND revoked_at IS NULL`;
      expect(live).toHaveLength(1);
    });

    it("concurrent rotates serialize on the predecessor: one pending winner, no deadlock", async () => {
      const user = await makeUser();
      const old = await activeKey(user);
      const results = await Promise.all([1, 2, 3, 4].map(() => rotateCredential(store(), { credentialId: old.credentialId })));
      expect(results.every((r) => r.ok)).toBe(true);
      const live = await service`SELECT 1 FROM agent_credentials WHERE predecessor_id = ${old.credentialId} AND confirmed_at IS NULL AND revoked_at IS NULL`;
      expect(live).toHaveLength(1);
    });

    it("revoking one key ends only it (A7) and kills its pending successor; another user's key stays valid", async () => {
      const a = await activeKey(await makeUser());
      const bUser = await makeUser();
      const b = await activeKey(bUser);
      const pending = ok(await rotateCredential(store(), { credentialId: a.credentialId }));
      expect(await revokeCredential(store(), { credentialId: a.credentialId, userId: bUser, revokedBy: bUser })).toBe(false);
      expect(await revokeCredential(store(), { credentialId: a.credentialId, userId: a.userId, revokedBy: a.userId })).toBe(true);
      expect(await verifyBearer(store(), a.apiKey)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), pending.apiKey, ["pending", "active"])).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(store(), b.apiKey)).toMatchObject({ ok: true });
    });

    it("confirm is refused when the predecessor was revoked meanwhile", async () => {
      const user = await makeUser();
      const old = await activeKey(user);
      const next = ok(await rotateCredential(store(), { credentialId: old.credentialId }));
      await service`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'probe' WHERE id = ${old.credentialId}`;
      expect(await confirmCredential(store(), { credentialId: next.credentialId })).toEqual({ ok: false, reason: "predecessor_revoked" });
    });
  });
});
