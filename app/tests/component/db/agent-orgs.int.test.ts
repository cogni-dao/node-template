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

  it("a person owns at most five orgs: the sixth writes nothing", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const creator = await user(tx, "creator");
      for (let i = 0; i < 5; i++) await createOrg(store, { creatorUserId: creator, name: `org ${i}` });
      await expect(createOrg(store, { creatorUserId: creator, name: "six" })).rejects.toMatchObject({ code: "too_many_orgs" });
      expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${creator} AND scope = 'org:owner' AND revoked_at IS NULL`).toHaveLength(5);
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

  it("the live index is (principal, scope, account): one person is an owner of two orgs, but holds a scope on one account once", async () => {
    await rolledBack(async (tx) => {
      const store = createPostgresOrgAccountStore(tx as unknown as SqlTag);
      const person = await user(tx, "person");
      const a = await createOrg(store, { creatorUserId: person, name: "a" });
      const b = await createOrg(store, { creatorUserId: person, name: "b" });
      expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${person} AND scope = 'org:owner' AND revoked_at IS NULL`).toHaveLength(2);
      await tx`SAVEPOINT dup`;
      await expect(
        tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id) VALUES (${person}, 'org:owner', ${a.orgUserId}, now(), 'account', ${a.billingAccountId})`
      ).rejects.toMatchObject({ constraint_name: "agent_roles_live_unique" });
      await tx`ROLLBACK TO SAVEPOINT dup`;
      // A node row and a pending account ask (no account) stay one open row per (principal, scope), as before.
      await tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource) VALUES (${person}, 'knowledge:read', ${a.orgUserId}, now(), 'node')`;
      await tx`SAVEPOINT node`;
      await expect(
        tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource) VALUES (${person}, 'knowledge:read', ${b.orgUserId}, now(), 'node')`
      ).rejects.toMatchObject({ constraint_name: "agent_roles_live_unique" });
      await tx`ROLLBACK TO SAVEPOINT node`;
    });
  });

  it("an org-owned account: owners, admins and a session caller's grant are read from the grant rows; strangers are refused; an unavailable source refuses", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const orgs = createPostgresOrgAccountStore(sql);
      const store = createPostgresAgentGrantsStore(sql);
      const [owner, admin, stranger, agent] = [await user(tx, "owner"), await user(tx, "admin"), await user(tx, "stranger"), await user(tx, "agent")] as [string, string, string, string];
      const org = await createOrg(orgs, { creatorUserId: owner, name: "org" });
      await orgs.setRole({ orgUserId: org.orgUserId, userId: admin, role: "admin", approvedBy: owner });
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
      await orgs.removeRole({ orgUserId: org.orgUserId, userId: admin });
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
