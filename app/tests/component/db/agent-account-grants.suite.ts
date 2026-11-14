// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-account-grants.suite`
 * Purpose: The account grant (task.5465) against real Postgres with migration 0041 applied, as the REAL roles (R5, R11):
 *   1. the grant conformance suite (`runGrantConformance`) over the real SQL store (service role);
 *   2. row-level security as the real app role: owner rows, a live grant, and foreign, expired, revoked, wrong-scope and node-row cases all return 0 rows;
 *   3. the one narrow select policy on `agent_roles` and the function's shape (SECURITY INVOKER, no PUBLIC execute);
 *   4. the app's own read path (`UserDrizzleAccountService`) for the credits route and tool twin.
 * Scope: `@cogni-dao/agent-grants` + migration 0041 + `UserDrizzleAccountService`. No HTTP, no LLM.
 * Invariants:
 *   - SAME_PREDICATE: the SQL function `agent_has_scope` and `hasLiveAccountGrant` agree on every case below.
 *   - RLS_AS_APP_ROLE: every RLS read here runs on the app role (DATABASE_URL, FORCE RLS), never the service role.
 * Side-effects: IO (testcontainers Postgres)
 * Notes: Not a test file by name. `agent-access-requests.int.test.ts` runs it AFTER its global open-ask cap test, in the same file, so the two never race:
 *   the cap is node-wide, and a pending ask made here must not take a slot that test just freed (or hit the cap it fills).
 * Links: app/src/adapters/server/db/migrations/0041_agent_account_grants.sql, packages/agent-grants/src/grants-conformance.ts
 */

import { randomUUID } from "node:crypto";
import { createPostgresAgentGrantsStore, type SqlTag } from "@cogni/agent-grants";
import { runGrantConformance } from "@cogni/agent-grants/grants-conformance";
import { toUserId } from "@cogni/ids";
import { NODE_AI_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UserDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import { getAppDb } from "@/adapters/server/db/client";
import { isBillingAccountNotFoundPortError } from "@/ports";

export function runAccountGrantSuites(): void {
describe("account grants (real Postgres, real roles)", () => {
  let service: Sql;
  let app: Sql;
  const users: string[] = [];
  const accountIds: string[] = [];

  const makeUser = async (): Promise<string> => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${`g-${id.slice(0, 8)}`})`;
    users.push(id);
    return id;
  };
  /** A person who owns one billing account holding `credits`, with one ledger row (so RLS on both tables is exercised). */
  const makeOwner = async (credits = 1000) => {
    const userId = await makeUser();
    const accountId = randomUUID();
    await service`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${accountId}, ${userId}, ${credits})`;
    const [key] = await service`INSERT INTO virtual_keys (billing_account_id, label, is_default, active) VALUES (${accountId}, 'k', true, true) RETURNING id`;
    await service`INSERT INTO credit_ledger (billing_account_id, virtual_key_id, amount, balance_after, reason, reference)
      VALUES (${accountId}, ${key?.id as string}, ${credits}, ${credits}, 'test_seed', ${`ref-${accountId}`})`;
    accountIds.push(accountId);
    return { userId, accountId };
  };
  const sqlTag = (client: Sql): SqlTag => client as unknown as SqlTag;
  const storeOf = () => createPostgresAgentGrantsStore(sqlTag(service));

  /** A live account row the owner approved (inserted as the real decide would leave it). */
  const grant = async (principal: string, ownerUserId: string, accountId: string, scope = "account:read") =>
    service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at)
      VALUES (${principal}, ${scope}, ${ownerUserId}, now(), 'account', ${accountId}, now() + interval '7 days')`;

  /** Run `fn` on the APP role (FORCE RLS) in one transaction with `app.current_user_id` set, as a real request does. */
  const asApp = <T>(actor: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> =>
    app.begin(async (tx) => {
      if (actor) await tx`SELECT set_config('app.current_user_id', ${actor}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
  });

  afterAll(async () => {
    if (!service) return;
    await service.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [users]);
    await service.unsafe("DELETE FROM credit_ledger WHERE billing_account_id = ANY($1)", [accountIds]);
    await service.unsafe("DELETE FROM virtual_keys WHERE billing_account_id = ANY($1)", [accountIds]);
    await service.unsafe("DELETE FROM billing_accounts WHERE id = ANY($1)", [accountIds]);
    await service.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  // 1. The conformance suite, over the real SQL store. Each row cleans its own asks, so the node-wide open-ask cap never fills.
  describe("conformance over the real SQL store", () => {
    let mine: string[] = [];
    let startedAt = new Date();
    runGrantConformance({
      describe,
      it: (name, fn) =>
        it(name, async () => {
          mine = [];
          try {
            await fn();
          } finally {
            await service.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1)", [mine]);
            // The seeded AI's rows this row made (it holds only these two scopes in this suite).
            await service`DELETE FROM agent_roles WHERE principal_user_id = ${NODE_AI_PRINCIPAL_USER_ID} AND scope IN ('account:read', 'work_item:transition') AND created_at >= ${startedAt}`;
          }
        }),
      expect,
      async setup({ owners, agents, internal }) {
        const ids: Record<string, string> = {};
        const accounts: Record<string, string> = {};
        for (const name of owners) {
          const o = await makeOwner();
          ids[name] = o.userId;
          accounts[name] = o.accountId;
        }
        for (const name of agents) ids[name] = await makeUser();
        // This node's AI is the SEEDED principal: the suite adds no agent_principals row, so a test that counts principals never sees one.
        for (const name of internal) ids[name] = NODE_AI_PRINCIPAL_USER_ID;
        mine = Object.values(ids).filter((id) => id !== NODE_AI_PRINCIPAL_USER_ID);
        startedAt = new Date();
        return { store: storeOf(), ids, accounts };
      },
      async expireGrant(principalUserId, scope) {
        const rows = await service`UPDATE agent_roles
          SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day'
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND resource = 'account' AND approved_by IS NOT NULL AND revoked_at IS NULL
          RETURNING id`;
        if (rows.length === 0) throw new Error("no live account row to expire");
      },
      async expireLink(principalUserId, scope) {
        const rows = await service`UPDATE agent_roles SET link_expires_at = now() - interval '1 hour'
          WHERE principal_user_id = ${principalUserId} AND scope = ${scope} AND approved_by IS NULL AND revoked_at IS NULL
          RETURNING id`;
        if (rows.length === 0) throw new Error("no pending row to expire");
      },
      broken: () =>
        createPostgresAgentGrantsStore((() => Promise.reject(new Error("db down"))) as unknown as SqlTag),
    });
  });

  // 2. RLS as the app role: the database repeats the app's test, so the two cannot disagree.
  describe("row-level security as the real app role", () => {
    it("the owner reads their own account and ledger; no one else's", async () => {
      const a = await makeOwner(500);
      const b = await makeOwner(900);
      const seen = await asApp(a.userId, async (tx) => ({
        accounts: await tx`SELECT id FROM billing_accounts WHERE id = ANY(${[a.accountId, b.accountId]})`,
        ledger: await tx`SELECT billing_account_id FROM credit_ledger WHERE billing_account_id = ANY(${[a.accountId, b.accountId]})`,
      }));
      expect(seen.accounts.map((r) => r.id)).toEqual([a.accountId]);
      expect(seen.ledger.map((r) => r.billing_account_id)).toEqual([a.accountId]);
    });

    it("a live account:read grant opens exactly that account and its ledger, through agent_has_scope, for the agent as the tenant", async () => {
      const owner = await makeOwner(700);
      const other = await makeOwner(800);
      const agent = await makeUser();
      await grant(agent, owner.userId, owner.accountId);
      const ids = [owner.accountId, other.accountId];
      const seen = await asApp(agent, async (tx) => ({
        accounts: await tx`SELECT id FROM billing_accounts WHERE id = ANY(${ids})`,
        ledger: await tx`SELECT billing_account_id FROM credit_ledger WHERE billing_account_id = ANY(${ids})`,
        fn: await tx`SELECT agent_has_scope(${owner.accountId}, 'account:read') AS yes, agent_has_scope(${other.accountId}, 'account:read') AS foreign, agent_has_scope(${owner.accountId}, 'account:write') AS wrong_scope`,
      }));
      expect(seen.accounts.map((r) => r.id)).toEqual([owner.accountId]); // the foreign account is invisible
      expect(seen.ledger.map((r) => r.billing_account_id)).toEqual([owner.accountId]);
      expect(seen.fn[0]).toEqual({ yes: true, foreign: false, wrong_scope: false });
      // The app's own store agrees (SAME_PREDICATE).
      expect(await storeOf().hasLiveAccountGrant(agent, "account:read", owner.accountId)).toBe(true);
      expect(await storeOf().hasLiveAccountGrant(agent, "account:read", other.accountId)).toBe(false);
    });

    it("an expired, a revoked and a never-granted row each return 0 rows", async () => {
      const owner = await makeOwner();
      const expired = await makeUser();
      const revoked = await makeUser();
      const stranger = await makeUser();
      await grant(expired, owner.userId, owner.accountId);
      await service`UPDATE agent_roles SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE principal_user_id = ${expired}`;
      await grant(revoked, owner.userId, owner.accountId);
      await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${revoked}`;
      for (const actor of [expired, revoked, stranger]) {
        const seen = await asApp(actor, async (tx) => ({
          accounts: await tx`SELECT id FROM billing_accounts WHERE id = ${owner.accountId}`,
          ledger: await tx`SELECT 1 FROM credit_ledger WHERE billing_account_id = ${owner.accountId}`,
        }));
        expect(seen.accounts, actor).toHaveLength(0);
        expect(seen.ledger, actor).toHaveLength(0);
        expect(await storeOf().hasLiveAccountGrant(actor, "account:read", owner.accountId)).toBe(false);
      }
    });

    it("a NODE row for the same scope and a pending ask open nothing, and the app role cannot see or write them", async () => {
      const owner = await makeOwner();
      const holder = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${holder}, 'account:read', ${owner.userId}, now())`;
      const asker = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, requested_by, resource) VALUES (${asker}, 'account:read', ${asker}, 'account')`;
      for (const actor of [holder, asker]) {
        const seen = await asApp(actor, async (tx) => ({
          accounts: await tx`SELECT id FROM billing_accounts WHERE id = ${owner.accountId}`,
          roles: await tx`SELECT id FROM agent_roles`,
        }));
        expect(seen.accounts).toHaveLength(0);
        // The narrow policy shows only ACCOUNT rows naming the caller: the node row is hidden, and the pending ask (an account row of the caller's own) is theirs.
        expect(seen.roles.length).toBe(actor === asker ? 1 : 0);
      }
      await expect(asApp(asker, (tx) => tx`UPDATE agent_roles SET approved_by = ${asker}, granted_at = now() WHERE principal_user_id = ${asker}`)).resolves.toMatchObject({ count: 0 });
      await expect(
        asApp(asker, (tx) => tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at)
          VALUES (${asker}, 'account:read', ${owner.userId}, now(), 'account', ${owner.accountId}, now() + interval '1 day')`)
      ).rejects.toThrow();
    });

    it("the app role sees only the account rows that name it as the principal (the R11 policy), never another agent's", async () => {
      const owner = await makeOwner();
      const one = await makeUser();
      const two = await makeUser();
      await grant(one, owner.userId, owner.accountId);
      await grant(two, owner.userId, owner.accountId);
      const rows = await asApp(one, (tx) => tx`SELECT principal_user_id FROM agent_roles WHERE principal_user_id = ANY(${[one, two]})`);
      expect(rows.map((r) => r.principal_user_id)).toEqual([one]);
      expect(await asApp(null, (tx) => tx`SELECT 1 FROM agent_roles`)).toHaveLength(0); // no tenant, no row
    });

    it("ships the function as SECURITY INVOKER with no PUBLIC execute, one select-only policy on agent_roles, and the table privilege", async () => {
      const [fn] = await service`SELECT prosecdef, proacl::text AS acl, proconfig::text AS config FROM pg_proc WHERE proname = 'agent_has_scope'`;
      expect(fn?.prosecdef).toBe(false);
      expect(String(fn?.acl)).not.toMatch(/(^\{|,)=X\//); // no grant to PUBLIC
      expect(String(fn?.config)).toContain("search_path=pg_catalog, public");
      expect(await service`SELECT cmd FROM pg_policies WHERE tablename = 'agent_roles'`).toEqual([expect.objectContaining({ cmd: "SELECT" })]);
      const [priv] = await app`SELECT has_table_privilege(current_user, 'agent_roles', 'SELECT') AS can_select, has_function_privilege(current_user, 'agent_has_scope(text,text)', 'EXECUTE') AS can_execute`;
      expect(priv).toEqual({ can_select: true, can_execute: true });
    });
  });

  // 2b. CURRENT_USER in migration 0041 is the app role only while the migrating role is the runtime role.
  describe("the migrating role is the runtime role (migration 0041 grants TO CURRENT_USER)", () => {
    it("the table and the function are owned by the role the app connects as, so CURRENT_USER in the migration was the app role", async () => {
      const [appRole] = await app`SELECT current_user AS who`;
      const [serviceRole] = await service`SELECT current_user AS who`;
      const [table] = await service`SELECT tableowner FROM pg_tables WHERE tablename = 'agent_roles'`;
      const [fn] = await service`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'agent_has_scope'`;
      expect(table?.tableowner).toBe(appRole?.who);
      expect(fn?.owner).toBe(appRole?.who);
      expect(table?.tableowner).not.toBe(serviceRole?.who);
    });
  });

  // 2c. A concurrent ask never returns a link that was not stored.
  describe("a concurrent re-ask rotates onto the winner's row (no unstored link)", () => {
    it("when the insert loses the race, the new hash is written to the pending row; when the row went live meanwhile it is reported granted; when it ended, the ask fails", async () => {
      const agent = await makeUser();
      const link = (hash: string) => ({ hash, expiresAt: new Date(Date.now() + 60_000) });
      const ask = (store: ReturnType<typeof createPostgresAgentGrantsStore>, hash: string) =>
        store.requestRole({ principalUserId: agent, scope: "work_item:transition", resource: "node", link: link(hash), maxPending: 3, maxPendingTotal: 1000 });
      const first = randomUUID().replaceAll("-", "").padEnd(64, "0");
      expect(await ask(storeOf(), first)).toBe("created");
      // A store that does not see the winner's row on its first open-row read (the race window), then behaves normally.
      const blind = (): ReturnType<typeof createPostgresAgentGrantsStore> => {
        let hidden = false;
        const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("?");
          if (!hidden && text.includes("SELECT id, approved_by FROM agent_roles")) {
            hidden = true;
            return Promise.resolve([]);
          }
          return (service as unknown as SqlTag)(strings, ...values);
        }) as unknown as SqlTag;
        return createPostgresAgentGrantsStore(tag);
      };
      const second = randomUUID().replaceAll("-", "").padEnd(64, "1");
      expect(await ask(blind(), second)).toBe("pending");
      const [row] = await service`SELECT link_hash FROM agent_roles WHERE principal_user_id = ${agent} AND scope = 'work_item:transition'`;
      expect(row?.link_hash).toBe(second); // the link the caller holds is the one stored
      // The winner was approved in the meantime: the loser reports granted and writes no link.
      const admin = await makeUser();
      await service`UPDATE agent_roles SET approved_by = ${admin}, granted_at = now(), link_hash = NULL WHERE principal_user_id = ${agent} AND scope = 'work_item:transition'`;
      expect(await ask(blind(), randomUUID().replaceAll("-", "").padEnd(64, "2"))).toBe("granted");
      // The row ended in the meantime: nothing is stored, so the ask fails rather than hand back a dead link.
      await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = 'work_item:transition'`;
      let gone = false;
      const ghost = createPostgresAgentGrantsStore(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.includes("INSERT INTO agent_roles")) return Promise.resolve([]); // the insert reports a conflict, but nothing open exists
        gone = true;
        return (service as unknown as SqlTag)(strings, ...values);
      }) as unknown as SqlTag);
      await expect(ask(ghost, randomUUID().replaceAll("-", "").padEnd(64, "3"))).rejects.toThrow("ask_raced");
      expect(gone).toBe(true);
    });
  });

  // 3. The CHECKs hold the shape even for a writer that skips the package.
  describe("the row shape is enforced by the database", () => {
    it("refuses a node row with an account, an approved account row with no account or end, an end over 30 days, and self approval", async () => {
      const owner = await makeOwner();
      const agent = await makeUser();
      const base = (extra: string) =>
        service.unsafe(`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id, expires_at) VALUES ${extra}`);
      await expect(base(`('${agent}', 's1', '${owner.userId}', now(), 'node', '${owner.accountId}', NULL)`)).rejects.toThrow(/agent_roles_node_shape/);
      await expect(base(`('${agent}', 's2', '${owner.userId}', now(), 'account', NULL, NULL)`)).rejects.toThrow(/agent_roles_account_live_shape/);
      await expect(base(`('${agent}', 's3', '${owner.userId}', now(), 'account', '${owner.accountId}', now() + interval '31 days')`)).rejects.toThrow(/agent_roles_account_live_shape/);
      await expect(base(`('${agent}', 's4', '${agent}', now(), 'node', NULL, NULL)`)).rejects.toThrow(/agent_roles_no_self_approval/);
      await expect(base(`('${agent}', 's5', '${owner.userId}', now(), 'weird', NULL, NULL)`)).rejects.toThrow(/agent_roles_resource_canonical/);
      await expect(service`INSERT INTO agent_roles (principal_user_id, scope, requested_by, link_consumed_at, link_hash) VALUES (${agent}, 's6', ${agent}, now(), 'h')`).rejects.toThrow(/agent_roles_link_consumed_has_no_hash/);
    });

    it("keeps the old live-row index, so an old pod's ON CONFLICT (principal, scope) still works", async () => {
      const agent = await makeUser();
      const admin = await makeUser();
      await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at) VALUES (${agent}, 'edo:write', ${admin}, now())`;
      const again = await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${agent}, 'edo:write', ${admin})
        ON CONFLICT (principal_user_id, scope) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
      expect(again).toHaveLength(0);
      expect(await service`SELECT indexname FROM pg_indexes WHERE indexname = 'agent_roles_live_unique'`).toHaveLength(1);
    });
  });

  // 4. The app's own read path, as the credits route and the tool twin use it.
  describe("the credits read path (UserDrizzleAccountService as the caller)", () => {
    it("the owner and a granted agent read the balance; a foreign, expired and revoked agent get BillingAccountNotFound (the route's 404)", async () => {
      const owner = await makeOwner(4242);
      const granted = await makeUser();
      const expired = await makeUser();
      const revoked = await makeUser();
      const stranger = await makeUser();
      await grant(granted, owner.userId, owner.accountId);
      await grant(expired, owner.userId, owner.accountId);
      await service`UPDATE agent_roles SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE principal_user_id = ${expired}`;
      await grant(revoked, owner.userId, owner.accountId);
      await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${revoked}`;
      const read = (actor: string) => new UserDrizzleAccountService(getAppDb(), toUserId(actor)).getBalance(owner.accountId);
      await expect(read(owner.userId)).resolves.toBe(4242);
      await expect(read(granted)).resolves.toBe(4242);
      for (const actor of [expired, revoked, stranger]) {
        const error = await read(actor).then(() => null, (e: unknown) => e);
        expect(isBillingAccountNotFoundPortError(error), actor).toBe(true);
      }
      // The ledger list is gated the same way.
      const ledger = (actor: string) => new UserDrizzleAccountService(getAppDb(), toUserId(actor)).listCreditLedgerEntries({ billingAccountId: owner.accountId, limit: 5 });
      expect((await ledger(granted)).length).toBe(1);
      expect(await ledger(stranger)).toHaveLength(0);
    });
  });
});
}
