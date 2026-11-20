// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-org-decisions.int.test`
 * Purpose: Org decisions (story.0038 phase 2, task.0181) against real Postgres: an owner or admin of an org approves, denies and revokes a grant row on the org's account through the
 *   real statements, a human-owned account keeps its own statements, and the generic revoke never ends an org role row.
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: ORG_DECISION_SQL, ONE_GATE (an admin decides on the org's account, only an owner decides an `org:owner` row), ORG_ROWS_ARE_NOT_ASK_ROWS.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import {
  approveAccountAsk,
  authorizeAccount,
  createOrg,
  createPostgresAgentGrantsStore,
  createPostgresOrgAccountStore,
  denyAccountAsk,
  hashLinkToken,
  newLinkToken,
  revokeAccountRow,
  type SqlTag,
} from "@cogni/agent-grants";
import { createGrantsOwnerSource, type OrgOwners, OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SCOPE = "account:read";

describe("org decisions (real Postgres)", () => {
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

  const down: OrgOwners = { owners: async () => Promise.reject(new OwnerSourceUnavailableError("down")) };

  /** A pending ACCOUNT ask by `agent`, with a real one-time link token. */
  const ask = async (store: ReturnType<typeof createPostgresAgentGrantsStore>, agent: string): Promise<string> => {
    const token = newLinkToken();
    const result = await store.requestRole({
      principalUserId: agent,
      scope: SCOPE,
      resource: "account",
      link: { hash: await hashLinkToken(token), expiresAt: new Date(Date.now() + 60_000) },
      maxPending: 3,
      maxPendingTotal: 1000,
    });
    expect(result).toBe("created");
    return token;
  };

  /** An org with an owner and an admin, and the real owner source. */
  const orgWithPeople = async (tx: TransactionSql) => {
    const sql = tx as unknown as SqlTag;
    const orgs = createPostgresOrgAccountStore(sql);
    const [owner, admin] = [await user(tx, "owner"), await user(tx, "admin")] as [string, string];
    const org = await createOrg(orgs, { creatorUserId: owner, name: "org" });
    await orgs.setRole({ orgUserId: org.orgUserId, userId: admin, role: "admin", approvedBy: owner });
    return { sql, org, owner, admin, owners: createGrantsOwnerSource(sql) };
  };

  it("an owner and an admin of the org approve an ask onto the org's account, and the grant authorizes the agent; a stranger and a down source change nothing", async () => {
    await rolledBack(async (tx) => {
      const { sql, org, owner, admin, owners } = await orgWithPeople(tx);
      const store = createPostgresAgentGrantsStore(sql);
      const [stranger, agent, agent2] = [await user(tx, "stranger"), await user(tx, "agent"), await user(tx, "agent2")] as [string, string, string];
      const token = await ask(store, agent);

      await expect(approveAccountAsk(store, { me: { userId: stranger, admin: null }, token, accountId: org.billingAccountId, owners })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      expect(await store.hasLiveAccountGrant(agent, SCOPE, org.billingAccountId)).toBe(false);

      expect((await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners })).approved).toBe(true);
      expect(await store.hasLiveAccountGrant(agent, SCOPE, org.billingAccountId)).toBe(true);
      expect(await authorizeAccount(store, { callerUserId: agent, scope: SCOPE, accountId: org.billingAccountId })).toBe("delegated");
      // The token is single-use.
      expect((await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners })).approved).toBe(false);

      // An admin approves too (the admin exists to approve grants on the org's account).
      const second = await ask(store, agent2);
      expect((await approveAccountAsk(store, { me: { userId: admin, admin: null }, token: second, accountId: org.billingAccountId, owners })).approved).toBe(true);
      expect(await store.hasLiveAccountGrant(agent2, SCOPE, org.billingAccountId)).toBe(true);
    });
  });

  it("an owner or admin denies an ask and revokes a live row by id; a stranger and a down source revoke nothing", async () => {
    await rolledBack(async (tx) => {
      const { sql, org, owner, admin, owners } = await orgWithPeople(tx);
      const store = createPostgresAgentGrantsStore(sql);
      const [stranger, a1, a2] = [await user(tx, "stranger"), await user(tx, "a1"), await user(tx, "a2")] as [string, string, string];

      const denied = await ask(store, a1);
      expect((await denyAccountAsk(store, { me: { userId: admin, admin: null }, token: denied, accountId: org.billingAccountId, owners })).denied).toBe(true);
      expect(await store.hasLiveAccountGrant(a1, SCOPE, org.billingAccountId)).toBe(false);

      const token = await ask(store, a2);
      await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners });
      const row = await tx`SELECT id FROM agent_roles WHERE principal_user_id = ${a2} AND revoked_at IS NULL`;
      const rowId = row[0]?.id as string;
      expect((await revokeAccountRow(store, { me: { userId: stranger, admin: null }, rowId, owners })).revoked).toBe(false);
      await expect(revokeAccountRow(store, { me: { userId: owner, admin: null }, rowId, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      expect(await store.hasLiveAccountGrant(a2, SCOPE, org.billingAccountId)).toBe(true);
      expect((await revokeAccountRow(store, { me: { userId: admin, admin: null }, rowId, owners })).revoked).toBe(true);
      expect(await store.hasLiveAccountGrant(a2, SCOPE, org.billingAccountId)).toBe(false);
    });
  });

  it("the generic revoke never ends an org role row: an admin cannot remove an owner through it, and an owner cannot skip the owner minimum", async () => {
    await rolledBack(async (tx) => {
      const { sql, org, owner, admin, owners } = await orgWithPeople(tx);
      const store = createPostgresAgentGrantsStore(sql);
      const ownerRow = (await tx`SELECT id FROM agent_roles WHERE principal_user_id = ${owner} AND scope = 'org:owner' AND revoked_at IS NULL`)[0]?.id as string;
      expect((await revokeAccountRow(store, { me: { userId: admin, admin: null }, rowId: ownerRow, owners })).revoked).toBe(false);
      expect((await revokeAccountRow(store, { me: { userId: owner, admin: null }, rowId: ownerRow, owners })).revoked).toBe(false);
      expect(await store.accountRoleOf?.(ownerRow)).toBeNull();
      expect(await store.revokeAccountRoleOnOrg?.({ rowId: ownerRow, accountId: org.billingAccountId })).toBe(false);
      expect(await store.hasLiveAccountGrant(owner, "org:owner", org.billingAccountId)).toBe(true);
      // The org's people never show in the account's grant list for AI.
      expect((await store.listAccountRoleRows(org.billingAccountId, 50)).rows).toEqual([]);
    });
  });

  it("a person's account is never written through the org statements; the human statements are unchanged", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresAgentGrantsStore(sql);
      const [human, owner, agent] = [await user(tx, "human"), await user(tx, "owner"), await user(tx, "agent")] as [string, string, string];
      const humanAccount = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${humanAccount}, ${human}, 0)`;
      const token = await ask(store, agent);
      const link = await hashLinkToken(token);
      // Even if a caller skipped the gate, the org statements refuse an account whose owner user is not an org.
      expect(await store.approveAccountByLinkOnOrg?.({ linkHash: link, approvedBy: owner, accountId: humanAccount })).toBe(false);
      expect(await store.denyAccountByLinkOnOrg?.({ linkHash: link, deniedBy: owner, accountId: humanAccount })).toBe(false);
      // The person's own decision, with no owner source at all, is the old path.
      expect((await approveAccountAsk(store, { me: { userId: human, admin: null }, token })).approved).toBe(true);
      expect(await store.hasLiveAccountGrant(agent, SCOPE, humanAccount)).toBe(true);
      const row = (await tx`SELECT id FROM agent_roles WHERE principal_user_id = ${agent} AND revoked_at IS NULL`)[0]?.id as string;
      expect(await store.revokeAccountRoleOnOrg?.({ rowId: row, accountId: humanAccount })).toBe(false);
      expect((await revokeAccountRow(store, { me: { userId: human, admin: null }, rowId: row })).revoked).toBe(true);
    });
  });
});
