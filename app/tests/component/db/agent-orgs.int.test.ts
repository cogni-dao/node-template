// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-orgs.int.test`
 * Purpose: Orgs and service principals (story.0038) against real Postgres: migration 0045's constraints, `ensureOrg` idempotency and one ordinary billing account,
 *   `principalKindOf` answering `org`, `canApprove` and `authorizeAccount` for an org-owned account over the real store, and one principal per (issuer, service).
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: ONE_ORG_PER_SOURCE, ORG_ACCOUNT_IS_ORDINARY, KIND_IS_THE_ROW, ONE_PRINCIPAL_PER_SERVICE.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import {
  authorizeAccount,
  canApprove,
  createPostgresAgentGrantsStore,
  principalKindOf,
  type SqlTag,
} from "@cogni/agent-grants";
import { ensureOrg, type OrgOwners, OwnerSourceUnavailableError, readOrgSource } from "@cogni/agent-grants/orgs";
import { ensureServicePrincipal, findServicePrincipal } from "@cogni/agent-grants/service-auth";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SRC = { kind: "repo-spec", ref: "https://github.com/cogni-dao/test-org" } as const;

describe("orgs and service principals (real Postgres)", () => {
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

  it("ensureOrg is idempotent per source: one user, one org principal, one ordinary account with its default key", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const first = await ensureOrg(sql, SRC);
      const again = await ensureOrg(sql, { kind: "repo-spec", ref: "https://github.com/Cogni-DAO/Test-Org" });
      expect(again).toEqual(first);
      expect(await readOrgSource(sql, first.userId)).toEqual(SRC);
      expect(await principalKindOf(sql, first.userId)).toBe("org");
      const accounts = await tx`SELECT id, is_system_tenant, balance_credits FROM billing_accounts WHERE owner_user_id = ${first.userId}`;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ id: first.billingAccountId, is_system_tenant: false });
      expect(await tx`SELECT 1 FROM virtual_keys WHERE billing_account_id = ${first.billingAccountId} AND is_default`).toHaveLength(1);
      expect(await tx`SELECT 1 FROM agent_principals WHERE kind = 'org' AND owner_source_ref = ${SRC.ref}`).toHaveLength(1);
    });
  });

  it("the database refuses an org with no owner source, a second org for one source, and an unknown kind", async () => {
    await rolledBack(async (tx) => {
      const mk = async () => {
        const id = randomUUID();
        await tx`INSERT INTO users (id, name) VALUES (${id}, 'u')`;
        return id;
      };
      await tx`SAVEPOINT a`;
      await expect(tx`INSERT INTO agent_principals (kind, user_id) VALUES ('org', ${await mk()})`).rejects.toMatchObject({ constraint_name: "agent_principals_org_has_owner_source" });
      await tx`ROLLBACK TO SAVEPOINT a`;
      await tx`INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref) VALUES ('org', ${await mk()}, 'repo-spec', 'https://github.com/x/y')`;
      await tx`SAVEPOINT b`;
      await expect(
        tx`INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref) VALUES ('org', ${await mk()}, 'repo-spec', 'https://github.com/x/y')`
      ).rejects.toMatchObject({ constraint_name: "agent_principals_org_source_unique" });
      await tx`ROLLBACK TO SAVEPOINT b`;
      await tx`SAVEPOINT c`;
      await expect(tx`INSERT INTO agent_principals (kind, user_id) VALUES ('wizard', ${await mk()})`).rejects.toMatchObject({ constraint_name: "agent_principals_kind_canonical" });
      await tx`ROLLBACK TO SAVEPOINT c`;
    });
  });

  it("an org-owned account: the org's owners approve and read it, everyone else is refused, and an unavailable source refuses", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresAgentGrantsStore(sql);
      const org = await ensureOrg(sql, SRC);
      expect(await store.orgSourceOfAccount?.(org.billingAccountId)).toEqual(SRC);
      const owner = randomUUID();
      const stranger = randomUUID();
      const agent = randomUUID();
      const owners: OrgOwners = { owners: async () => [owner] };
      const row = { resource: "account" as const, principalUserId: agent, accountId: org.billingAccountId };
      expect(await canApprove(store, { userId: owner, admin: null }, row, owners)).toBe(true);
      expect(await canApprove(store, { userId: stranger, admin: {} }, row, owners)).toBe(false);
      expect(await canApprove(store, { userId: agent, admin: null }, row, { owners: async () => [agent] })).toBe(false);
      const input = { via: "session" as const, scope: "account:read", accountId: org.billingAccountId };
      expect(await authorizeAccount(store, { ...input, callerUserId: owner, owners })).toBe("owner");
      expect(await authorizeAccount(store, { ...input, callerUserId: stranger, owners })).toBeNull();
      const down: OrgOwners = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };
      await expect(canApprove(store, { userId: owner, admin: null }, row, down)).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      // A human-owned account is unchanged by the owner sources.
      const human = randomUUID();
      const humanAccount = randomUUID();
      await tx`INSERT INTO users (id, name) VALUES (${human}, 'h')`;
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${humanAccount}, ${human}, 0)`;
      expect(await store.orgSourceOfAccount?.(humanAccount)).toBeNull();
      expect(await authorizeAccount(store, { ...input, accountId: humanAccount, callerUserId: owner, owners })).toBeNull();
      expect(await authorizeAccount(store, { ...input, accountId: humanAccount, callerUserId: human, owners })).toBe("owner");
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
