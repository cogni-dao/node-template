// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-org-decisions.int.test`
 * Purpose: Story.0038 phase 2 against real Postgres: an owner of an org approves, denies and revokes a grant row on the org's account through the real statements, a
 *   human-owned account keeps its own statements, and the payer row (migration 0046) keeps its real constraints (the one open row per subject, no self-approval, paired approval).
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: ORG_DECISION_SQL, PAYER_IS_AUTHORIZED, ONE_OPEN_BINDING_PER_SUBJECT, NO_SELF_APPROVAL, NEVER_CACHED (Off is read on the next call). The request/decide/revoke payer functions were removed in 0.9.0; a payer row is written only by a signed connect (connections.int.test.ts).
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import {
  approveAccountAsk,
  authorizeAccount,
  createPostgresAgentGrantsStore,
  createPostgresPayerBindingStore,
  denyAccountAsk,
  hashLinkToken,
  newLinkToken,
  payerFor,
  revokeAccountRow,
  type SqlTag,
} from "@cogni/agent-grants";
import { ensureOrg, type OrgOwners, OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SRC = { kind: "repo-spec", ref: "https://github.com/cogni-dao/test-org-decisions" } as const;
const SCOPE = "account:read";

describe("org decisions and the payer row (real Postgres)", () => {
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

  it("an owner of the org approves an ask onto the org's account, and the grant authorizes the agent; a stranger and a down source change nothing", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresAgentGrantsStore(sql);
      const org = await ensureOrg(sql, SRC);
      const [owner, stranger, agent] = [await user(tx, "owner"), await user(tx, "stranger"), await user(tx, "agent")] as [string, string, string];
      const owners: OrgOwners = { owners: async () => [owner] };
      const token = await ask(store, agent);

      await expect(approveAccountAsk(store, { me: { userId: stranger, admin: null }, token, accountId: org.billingAccountId, owners })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      expect(await store.hasLiveAccountGrant(agent, SCOPE, org.billingAccountId)).toBe(false);

      expect((await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners })).approved).toBe(true);
      expect(await store.hasLiveAccountGrant(agent, SCOPE, org.billingAccountId)).toBe(true);
      expect(await authorizeAccount(store, { via: "bearer", callerUserId: agent, scope: SCOPE, accountId: org.billingAccountId })).toBe("delegated");
      // The token is single-use.
      expect((await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners })).approved).toBe(false);
    });
  });

  it("an owner of the org denies an ask and revokes a live row by id; a stranger and a down source revoke nothing", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const store = createPostgresAgentGrantsStore(sql);
      const org = await ensureOrg(sql, SRC);
      const [owner, stranger, a1, a2] = [await user(tx, "owner"), await user(tx, "stranger"), await user(tx, "a1"), await user(tx, "a2")] as [string, string, string, string];
      const owners: OrgOwners = { owners: async () => [owner] };

      const denied = await ask(store, a1);
      expect((await denyAccountAsk(store, { me: { userId: owner, admin: null }, token: denied, accountId: org.billingAccountId, owners })).denied).toBe(true);
      expect(await store.hasLiveAccountGrant(a1, SCOPE, org.billingAccountId)).toBe(false);

      const token = await ask(store, a2);
      await approveAccountAsk(store, { me: { userId: owner, admin: null }, token, accountId: org.billingAccountId, owners });
      const row = await tx`SELECT id FROM agent_roles WHERE principal_user_id = ${a2} AND revoked_at IS NULL`;
      const rowId = row[0]?.id as string;
      expect((await revokeAccountRow(store, { me: { userId: stranger, admin: null }, rowId, owners })).revoked).toBe(false);
      await expect(revokeAccountRow(store, { me: { userId: owner, admin: null }, rowId, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      expect(await store.hasLiveAccountGrant(a2, SCOPE, org.billingAccountId)).toBe(true);
      expect((await revokeAccountRow(store, { me: { userId: owner, admin: null }, rowId, owners })).revoked).toBe(true);
      expect(await store.hasLiveAccountGrant(a2, SCOPE, org.billingAccountId)).toBe(false);
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

  it("the database refuses a second open payer row per subject, a self-approved row and an unpaired approval", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const org = await ensureOrg(sql, SRC);
      const svc = await user(tx, "svc");
      const approver = await user(tx, "approver");
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id) VALUES (${svc}, ${org.billingAccountId})`;
      await tx`SAVEPOINT a`;
      await expect(tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id) VALUES (${svc}, ${org.billingAccountId})`).rejects.toMatchObject({ constraint_name: "payer_bindings_open_per_subject" });
      await tx`ROLLBACK TO SAVEPOINT a`;
      await tx`SAVEPOINT b`;
      await expect(tx`UPDATE payer_bindings SET approved_by = ${svc}, approved_at = now() WHERE subject_user_id = ${svc}`).rejects.toMatchObject({ constraint_name: "payer_bindings_no_self_approval" });
      await tx`ROLLBACK TO SAVEPOINT b`;
      await tx`SAVEPOINT c`;
      await expect(tx`UPDATE payer_bindings SET approved_by = ${approver} WHERE subject_user_id = ${svc}`).rejects.toMatchObject({ constraint_name: "payer_bindings_approval_is_paired" });
      await tx`ROLLBACK TO SAVEPOINT c`;
      // An approved, unrevoked row is what `payerFor` reads; closing it ends the payer on the very next read (NEVER_CACHED).
      await tx`UPDATE payer_bindings SET approved_by = ${approver}, approved_at = now() WHERE subject_user_id = ${svc}`;
      const payer = createPostgresPayerBindingStore(sql);
      expect(await payerFor(payer, svc)).toBe(org.billingAccountId);
      await tx`UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${approver} WHERE subject_user_id = ${svc}`;
      expect(await payerFor(payer, svc)).toBeNull();
    });
  });
});
