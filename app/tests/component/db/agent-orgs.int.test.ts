// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-orgs.int.test`
 * Purpose: Org accounts (task.0181) against real Postgres: migration 0050's constraints and the live-row index (principal, scope, account), `createOrg` through the real adapter
 *   (the org's user, its `org` principal with owner source `grants`, one ordinary billing account, the creator's `org:owner`), `principalKindOf` answering `org`, the `grants` owner source,
 *   `canApprove` and `authorizeAccount` for an org-owned account over the real store, and one principal per (issuer, service).
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: ONE_ORG_PER_SOURCE, ORG_ACCOUNT_IS_ORDINARY, KIND_IS_THE_ROW, ONE_PRINCIPAL_PER_SERVICE, ROLES_NEST, ONE_LIVE_ROW_PER_PRINCIPAL_SCOPE_ACCOUNT.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import {
  authorizeAccount,
  canApprove,
  createOrg,
  createPostgresAgentGrantsStore,
  createPostgresOrgAccountStore,
  principalKindOf,
  type SqlTag,
} from "@cogni/agent-grants";
import { createGrantsOwnerSource, OwnerSourceUnavailableError, readOrgSource } from "@cogni/agent-grants/orgs";
import { ensureServicePrincipal, findServicePrincipal } from "@cogni/agent-grants/service-auth";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");

describe("org accounts (real Postgres)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  const rolledBack = async (fn: (tx: TransactionSql) => Promise<void>) => {
    await service
      .begin(async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  };

  const user = async (tx: TransactionSql, name: string): Promise<string> => {
    const id = randomUUID();
    await tx`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    return id;
  };

  it("createOrg writes the user, the org principal (source grants, ref = its own id), one ordinary account with its default key and the creator's owner grant", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const creator = await user(tx, "creator");
      const org = await createOrg(createPostgresOrgAccountStore(sql), { creatorUserId: creator, name: "  toks5  " });
      expect(org.name).toBe("toks5");
      expect(await readOrgSource(sql, org.orgUserId)).toEqual({ kind: "grants", ref: org.orgUserId });
      expect(await principalKindOf(sql, org.orgUserId)).toBe("org");
      const accounts = await tx`SELECT id, is_system_tenant, balance_credits FROM billing_accounts WHERE owner_user_id = ${org.orgUserId}`;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ id: org.billingAccountId, is_system_tenant: false });
      expect(await tx`SELECT 1 FROM virtual_keys WHERE billing_account_id = ${org.billingAccountId} AND is_default`).toHaveLength(1);
      // The creator's first owner grant is approved by the org's own users id, on the org's account.
      const grants = await tx`SELECT principal_user_id, scope, approved_by, resource, account_id FROM agent_roles WHERE account_id = ${org.billingAccountId}`;
      expect(grants).toEqual([{ principal_user_id: creator, scope: "org:owner", approved_by: org.orgUserId, resource: "account", account_id: org.billingAccountId }]);
      // Nothing outside the org is granted.
      expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${creator} AND resource = 'node'`).toHaveLength(0);
      expect(await createGrantsOwnerSource(sql).owners({ kind: "grants", ref: org.orgUserId })).toEqual([creator]);
    });
  });

  it("release 1: a person owns at most one org; a second is the named org_role_limit and writes nothing (an owner and an admin of one org each is the most)", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const creator = await user(tx, "creator");
      const first = await createOrg(store, { creatorUserId: creator, name: "first" });
      await expect(createOrg(store, { creatorUserId: creator, name: "second" })).rejects.toMatchObject({ name: "OrgError", code: "org_role_limit" });
      expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${creator} AND scope = 'org:owner' AND revoked_at IS NULL`).toHaveLength(1);
      // The same person is still free to be an ADMIN of one other org (a different role); a second admin role is refused.
      const other = await user(tx, "other");
      const otherOrg = await createOrg(store, { creatorUserId: other, name: "other" });
      await store.setRole({ orgUserId: otherOrg.orgUserId, userId: creator, role: "admin", approvedBy: other, revokedBy: other });
      const third = await user(tx, "third");
      const thirdOrg = await createOrg(store, { creatorUserId: third, name: "third" });
      await expect(store.setRole({ orgUserId: thirdOrg.orgUserId, userId: creator, role: "admin", approvedBy: third, revokedBy: third })).rejects.toMatchObject({ code: "org_role_limit" });
      expect(await store.roleOf(creator, first.orgUserId)).toBe("owner");
      expect(await store.roleOf(creator, otherOrg.orgUserId)).toBe("admin");
      expect(await store.roleOf(creator, thirdOrg.orgUserId)).toBeNull();
    });
  });

  it("the database refuses an org with no owner source, a second org for one source, and an unknown kind", async () => {
    await rolledBack(async (tx) => {
      const mk = () => user(tx, "u");
      await tx`SAVEPOINT a`;
      await expect(tx`INSERT INTO agent_principals (kind, user_id) VALUES ('org', ${await mk()})`).rejects.toMatchObject({ constraint_name: "agent_principals_org_has_owner_source" });
      await tx`ROLLBACK TO SAVEPOINT a`;
      await tx`INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref) VALUES ('org', ${await mk()}, 'grants', 'same-ref')`;
      await tx`SAVEPOINT b`;
      await expect(tx`INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref) VALUES ('org', ${await mk()}, 'grants', 'same-ref')`).rejects.toMatchObject({
        constraint_name: "agent_principals_org_source_unique",
      });
      await tx`ROLLBACK TO SAVEPOINT b`;
      await tx`SAVEPOINT c`;
      await expect(tx`INSERT INTO agent_principals (kind, user_id) VALUES ('wizard', ${await mk()})`).rejects.toMatchObject({ constraint_name: "agent_principals_kind_canonical" });
      await tx`ROLLBACK TO SAVEPOINT c`;
    });
  });

  it("release 1 live indexes: the old (principal, scope) index refuses a second org:owner in another org; the account-aware index sits beside it and refuses the same role twice on one account", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const a = await createOrg(store, { creatorUserId: alice, name: "a" });
      const b = await createOrg(store, { creatorUserId: bob, name: "b" });
      const insert = (principal: string, accountId: string) =>
        tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id) VALUES (${principal}, 'org:owner', ${a.orgUserId}, now(), 'account', ${accountId})`;
      await tx`SAVEPOINT other_org`;
      await expect(insert(alice, b.billingAccountId)).rejects.toMatchObject({ constraint_name: "agent_roles_live_unique" });
      await tx`ROLLBACK TO SAVEPOINT other_org`;
      await tx`SAVEPOINT same_org`;
      await expect(insert(alice, a.billingAccountId)).rejects.toMatchObject({ code: "23505" });
      await tx`ROLLBACK TO SAVEPOINT same_org`;
      expect(
        (await tx`SELECT indexname FROM pg_indexes WHERE tablename = 'agent_roles' AND indexname IN ('agent_roles_live_unique', 'agent_roles_live_account_unique') ORDER BY indexname`).map((r) => r.indexname)
      ).toEqual(["agent_roles_live_account_unique", "agent_roles_live_unique"]);
      // A node row stays one open row per (principal, scope), as before.
      await tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource) VALUES (${alice}, 'knowledge:read', ${a.orgUserId}, now(), 'node')`;
      await tx`SAVEPOINT node`;
      await expect(
        tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource) VALUES (${alice}, 'knowledge:read', ${b.orgUserId}, now(), 'node')`
      ).rejects.toMatchObject({ constraint_name: "agent_roles_live_unique" });
      await tx`ROLLBACK TO SAVEPOINT node`;
    });
  });

  it("every act names its actor on its own row: org create, remove, role change and suspend, with distinct caller and target", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresOrgAccountStore(sql);
      const [alice, bob, carol, admin] = [await user(tx, "alice"), await user(tx, "bob"), await user(tx, "carol"), await user(tx, "admin")] as [string, string, string, string];
      const org = await createOrg(store, { creatorUserId: alice, name: "actors" });
      expect(await tx`SELECT created_by FROM agent_principals WHERE user_id = ${org.orgUserId}`).toEqual([{ created_by: alice }]);
      await store.setRole({ orgUserId: org.orgUserId, userId: bob, role: "admin", approvedBy: alice, revokedBy: alice });
      await store.setRole({ orgUserId: org.orgUserId, userId: carol, role: "admin", approvedBy: alice, revokedBy: alice });
      // Remove: the person who removed is stored on the ended row, and is not the target.
      expect(await store.removeRole({ orgUserId: org.orgUserId, userId: bob, revokedBy: alice })).toBe(true);
      expect(await tx`SELECT revoked_by FROM agent_roles WHERE principal_user_id = ${bob} AND account_id = ${org.billingAccountId}`).toEqual([{ revoked_by: alice }]);
      // A role change ends the old row with the person who changed it; the new live row names nobody.
      await store.setRole({ orgUserId: org.orgUserId, userId: carol, role: "owner", approvedBy: alice, revokedBy: alice });
      expect(await tx`SELECT scope, revoked_by FROM agent_roles WHERE principal_user_id = ${carol} AND account_id = ${org.billingAccountId} ORDER BY scope`).toEqual([
        { scope: "org:admin", revoked_by: alice },
        { scope: "org:owner", revoked_by: null },
      ]);
      // Suspend stores the admin once (the second admin changes nothing); there is no resume.
      expect(await store.suspend(org.orgUserId, admin)).toBe(true);
      expect(await store.suspend(org.orgUserId, alice)).toBe(true);
      expect(await tx`SELECT suspended_by, suspended_at IS NOT NULL AS suspended FROM agent_principals WHERE user_id = ${org.orgUserId}`).toEqual([{ suspended_by: admin, suspended: true }]);
      expect(await store.suspend(alice, admin)).toBe(false); // not an org
      expect(Object.keys(store)).not.toContain("setSuspended");
    });
  });

  it("the node admin's list sees every org with its suspension, a page at a time, and the org list and view carry the balance and each member's wallet", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresOrgAccountStore(sql);
      const [alice, bob] = [await user(tx, "alice"), await user(tx, "bob")] as [string, string];
      const wallet = `0x${"ab".repeat(20)}`;
      await tx`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${alice}, 'wallet', ${wallet})`;
      const a = await createOrg(store, { creatorUserId: alice, name: "a org" });
      const b = await createOrg(store, { creatorUserId: bob, name: "b org" });
      await tx`UPDATE billing_accounts SET balance_credits = 1234 WHERE id = ${a.billingAccountId}`;
      await store.suspend(b.orgUserId, alice);
      const seen: Array<{ orgUserId: string; name: string; suspended: boolean }> = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof store.listAll>> = await store.listAll({ limit: 1, after: cursor });
        expect(page.items.length).toBeLessThanOrEqual(1);
        seen.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen.filter((o) => o.orgUserId === a.orgUserId || o.orgUserId === b.orgUserId).sort((x, y) => x.name.localeCompare(y.name))).toEqual([
        { orgUserId: a.orgUserId, name: "a org", suspended: false },
        { orgUserId: b.orgUserId, name: "b org", suspended: true },
      ]);
      const mine = await store.listOrgsOf(alice, { limit: 10, after: null });
      expect(mine.items[0]).toMatchObject({ orgUserId: a.orgUserId, balanceCredits: 1234 });
      expect(await store.getOrg(a.orgUserId)).toMatchObject({ balanceCredits: 1234 });
      const members = await store.members(a.orgUserId, { limit: 10, after: null });
      expect(members.items).toEqual([expect.objectContaining({ userId: alice, wallet })]);
    });
  });

  it("an org-owned account: owners, admins and a session caller's grant are read from the grant rows; strangers are refused; an unavailable source refuses", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const store = createPostgresAgentGrantsStore(sql);
      const [owner, admin, stranger, agent] = [await user(tx, "owner"), await user(tx, "admin"), await user(tx, "stranger"), await user(tx, "agent")] as [string, string, string, string];
      const org = await createOrg(orgs, { creatorUserId: owner, name: "org" });
      await orgs.setRole({ orgUserId: org.orgUserId, userId: admin, role: "admin", approvedBy: owner, revokedBy: owner });
      const owners = createGrantsOwnerSource(sql);
      expect(await store.orgSourceOfAccount?.(org.billingAccountId)).toEqual({ kind: "grants", ref: org.orgUserId });
      const row = { resource: "account" as const, principalUserId: agent, accountId: org.billingAccountId };
      expect(await canApprove(store, { userId: owner, admin: null }, row, owners)).toBe(true);
      expect(await canApprove(store, { userId: admin, admin: null }, row, owners)).toBe(true);
      expect(await canApprove(store, { userId: admin, admin: null }, { ...row, scope: "org:owner" }, owners)).toBe(false);
      expect(await canApprove(store, { userId: stranger, admin: {} }, row, owners)).toBe(false);
      expect(await canApprove(store, { userId: agent, admin: null }, row, owners)).toBe(false);
      // authorizeAccount(caller, org:admin, account) for a session caller (no `via`), the call billing makes.
      const ask = (callerUserId: string, scope: string) => authorizeAccount(store, { callerUserId, scope, accountId: org.billingAccountId });
      expect(await ask(admin, "org:admin")).toBe("delegated");
      expect(await ask(admin, "account:read")).toBe("delegated");
      expect(await ask(admin, "org:owner")).toBeNull();
      expect(await ask(owner, "org:admin")).toBe("delegated");
      expect(await ask(stranger, "org:admin")).toBeNull();
      // A removed admin reads nothing from the next call.
      await orgs.removeRole({ orgUserId: org.orgUserId, userId: admin, revokedBy: owner });
      expect(await ask(admin, "org:admin")).toBeNull();
      const down = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };
      await expect(canApprove(store, { userId: stranger, admin: null }, row, down)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      // A human-owned account is unchanged by the owner sources.
      const human = await user(tx, "h");
      const humanAccount = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${humanAccount}, ${human}, 0)`;
      expect(await store.orgSourceOfAccount?.(humanAccount)).toBeNull();
      expect(await authorizeAccount(store, { scope: "account:read", accountId: humanAccount, callerUserId: owner, owners })).toBeNull();
      expect(await authorizeAccount(store, { scope: "account:read", accountId: humanAccount, callerUserId: human, owners })).toBe("owner");
    });
  });

  it("one external principal per (issuer, service), its own users row, no credential rows, found only after it exists", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const who = { issuer: `https://home-${randomUUID().slice(0, 8)}.example`, service: "git-review" };
      expect(await findServicePrincipal(sql, who)).toBeNull();
      const id = await ensureServicePrincipal(sql, who);
      expect(await ensureServicePrincipal(sql, who)).toBe(id);
      expect(await findServicePrincipal(sql, who)).toBe(id);
      expect(await tx`SELECT kind FROM agent_principals WHERE user_id = ${id}`).toEqual([{ kind: "external" }]);
      expect(await tx`SELECT 1 FROM agent_credentials WHERE user_id = ${id}`).toHaveLength(0);
      expect(await ensureServicePrincipal(sql, { ...who, service: "node-ai" })).not.toBe(id);
    });
  });
});
