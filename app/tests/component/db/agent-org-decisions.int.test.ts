// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-org-decisions.int.test`
 * Purpose: Story.0038 phase 2 against real Postgres: an owner of an org approves, denies and revokes a grant row on the org's account through the real statements, a
 *   human-owned account keeps its own statements, and payer bindings (migration 0046) run their whole lifecycle with the real constraints.
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: ORG_DECISION_SQL, PAYER_IS_AUTHORIZED, ONE_OPEN_BINDING_PER_SUBJECT, NO_SELF_APPROVAL, NEVER_CACHED (Off is read on the next call).
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import {
  approveAccountAsk,
  authorizeAccount,
  createPostgresAgentGrantsStore,
  createPostgresPayerBindingStore,
  decidePayerBinding,
  denyAccountAsk,
  MAX_PENDING_PER_ACCOUNT,
  ownersForBinding,
  hashLinkToken,
  newLinkToken,
  payerFor,
  requestPayerBinding,
  revokeAccountRow,
  revokePayerBinding,
  type SqlTag,
} from "@cogni/agent-grants";
import { ensureOrg, type OrgOwners, OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const SRC = { kind: "repo-spec", ref: "https://github.com/cogni-dao/test-org-decisions" } as const;
const SCOPE = "account:read";

describe("org decisions and payer bindings (real Postgres)", () => {
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

  it("payer binding: an ask for an org's account is refused, an old live one is turned Off by the org's owners, and a person's account is decided by that person", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const grants = createPostgresAgentGrantsStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const org = await ensureOrg(sql, SRC);
      const [owner, stranger, svc, svc2] = [await user(tx, "owner"), await user(tx, "stranger"), await user(tx, "svc"), await user(tx, "svc2")] as [string, string, string, string];
      const owners: OrgOwners = { owners: async () => [owner] };

      // An ask for an org's account is refused and writes nothing (an org is billed with org:spend).
      await expect(requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: org.billingAccountId })).rejects.toMatchObject({ code: "not_allowed" });
      expect(await tx`SELECT 1 FROM payer_bindings WHERE subject_user_id = ${svc}`).toHaveLength(0);

      // An OLD live binding (written before the refusal) still names the org account until its owners turn it Off.
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id, approved_by, approved_at) VALUES (${svc}, ${org.billingAccountId}, ${owner}, now())`;
      expect(await payerFor(payer, svc)).toBe(org.billingAccountId);
      const id = (await tx`SELECT id FROM payer_bindings WHERE subject_user_id = ${svc}`)[0]?.id as string;
      await expect(revokePayerBinding(payer, grants, { me: { userId: stranger, admin: null }, id, owners })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(revokePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id, owners: down })).rejects.toBeInstanceOf(OwnerSourceUnavailableError);
      expect(await payerFor(payer, svc)).toBe(org.billingAccountId);
      expect((await revokePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id, owners })).revoked).toBe(true);
      expect(await payerFor(payer, svc)).toBeNull();
      expect(await tx`SELECT approved_by, revoked_by FROM payer_bindings WHERE id = ${id}`).toEqual([{ approved_by: owner, revoked_by: owner }]);

      // An old PENDING ask for an org's account can be dismissed, never approved.
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id) VALUES (${svc2}, ${org.billingAccountId})`;
      const old = (await tx`SELECT id FROM payer_bindings WHERE subject_user_id = ${svc2}`)[0]?.id as string;
      await expect(decidePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id: old, approve: true, owners })).rejects.toMatchObject({ code: "not_allowed" });
      expect((await decidePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id: old, approve: false, owners })).decided).toBe(true);

      // A person's account: ask, the owner approves, Off.
      const personal = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${personal}, ${stranger}, 0)`;
      const asked = await requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: personal });
      expect(asked).toMatchObject({ state: "pending", created: true });
      expect(await payerFor(payer, svc)).toBeNull();
      expect((await decidePayerBinding(payer, grants, { me: { userId: stranger, admin: null }, id: asked.id, approve: true })).decided).toBe(true);
      expect(await payerFor(payer, svc)).toBe(personal);
      // A live binding must be turned Off before the subject asks for another account.
      const other = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${other}, ${owner}, 0)`;
      await expect(requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: other })).rejects.toMatchObject({ code: "not_allowed" });
      expect((await revokePayerBinding(payer, grants, { me: { userId: stranger, admin: null }, id: asked.id })).revoked).toBe(true);
      expect((await requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: other })).created).toBe(true);
    });
  });

  it("the database refuses a second open binding per subject, a self-approved binding and an unpaired approval", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const payer = createPostgresPayerBindingStore(sql);
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
      // The statement itself refuses the subject as approver and a foreign person's account.
      const id = (await tx`SELECT id FROM payer_bindings WHERE subject_user_id = ${svc}`)[0]?.id as string;
      expect(await payer.approve({ id, approvedBy: svc })).toBe(false);
      const personal = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${personal}, ${approver}, 0)`;
      const other = await user(tx, "other");
      const second = await payer.request({ subjectUserId: other, billingAccountId: personal, maxPendingPerAccount: 20 });
      expect(second.result).toBe("created");
      expect(await payer.approve({ id: second.id as string, approvedBy: svc })).toBe(false);
      expect(await payer.approve({ id: second.id as string, approvedBy: approver })).toBe(true);
    });
  });
  it("an account holds at most MAX_PENDING_PER_ACCOUNT unexpired pending asks (counted in the insert), an expired ask is neither counted nor decidable, and an unknown account writes nothing", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const grants = createPostgresAgentGrantsStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const owner = await user(tx, "owner");
      const target = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${target}, ${owner}, 0)`;
      const owners: OrgOwners = { owners: async () => [owner] };
      const subjects: string[] = [];
      for (let i = 0; i < MAX_PENDING_PER_ACCOUNT; i++) {
        const subject = await user(tx, `s${i}`);
        subjects.push(subject);
        await requestPayerBinding(payer, { subjectUserId: subject, billingAccountId: target });
      }
      const extra = await user(tx, "extra");
      await tx`SAVEPOINT cap`;
      await expect(requestPayerBinding(payer, { subjectUserId: extra, billingAccountId: target })).rejects.toMatchObject({ code: "too_many_requests" });
      await tx`ROLLBACK TO SAVEPOINT cap`;
      expect(await tx`SELECT 1 FROM payer_bindings WHERE billing_account_id = ${target}`).toHaveLength(MAX_PENDING_PER_ACCOUNT);

      // Eight days later the first ask has expired: it is not counted, cannot be decided, and its subject's next ask replaces it.
      const first = (await tx`SELECT id FROM payer_bindings WHERE subject_user_id = ${subjects[0] as string}`)[0]?.id as string;
      await tx`UPDATE payer_bindings SET created_at = now() - interval '8 days' WHERE id = ${first}`;
      expect((await decidePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id: first, approve: true, owners })).decided).toBe(false);
      expect(await payer.get(first)).toBeNull();
      expect((await requestPayerBinding(payer, { subjectUserId: extra, billingAccountId: target })).created).toBe(true);
      const again = await requestPayerBinding(payer, { subjectUserId: subjects[0] as string, billingAccountId: target }).catch((e: unknown) => e);
      // The account is full again with `extra`, so the replacement is refused; the expired row was closed either way (one open row per subject).
      expect(again).toMatchObject({ code: "too_many_requests" });

      // An unknown account answers like a known one and writes no row.
      const stranger = await user(tx, "stranger");
      const decoy = await requestPayerBinding(payer, { subjectUserId: stranger, billingAccountId: randomUUID() });
      expect(decoy).toMatchObject({ state: "pending", created: true });
      expect(await tx`SELECT 1 FROM payer_bindings WHERE subject_user_id = ${stranger}`).toHaveLength(0);
    });
  });

  it("an ask for an unknown account closes nothing: the subject's pending ask for a real account stays open", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const payer = createPostgresPayerBindingStore(sql);
      const svc = await user(tx, "svc");
      const target = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${target}, ${await user(tx, "holder")}, 0)`;
      const kept = await requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: target });
      const decoy = await requestPayerBinding(payer, { subjectUserId: svc, billingAccountId: randomUUID() });
      expect(decoy.id).not.toBe(kept.id);
      expect(await tx`SELECT id, revoked_at FROM payer_bindings WHERE subject_user_id = ${svc}`).toEqual([{ id: kept.id, revoked_at: null }]);
    });
  });

  it("ownersForBinding reads an org's owners before the decision, and is undefined for a person's account", async () => {
    await rolledBack(async (tx) => {
      const sql = tx as unknown as SqlTag;
      const grants = createPostgresAgentGrantsStore(sql);
      const payer = createPostgresPayerBindingStore(sql);
      const org = await ensureOrg(sql, SRC);
      const [owner, svc, human] = [await user(tx, "owner"), await user(tx, "svc"), await user(tx, "human")] as [string, string, string];
      // An old ask for the org's account (nothing can make one now).
      await tx`INSERT INTO payer_bindings (subject_user_id, billing_account_id) VALUES (${svc}, ${org.billingAccountId})`;
      const askedId = (await tx`SELECT id FROM payer_bindings WHERE subject_user_id = ${svc}`)[0]?.id as string;
      const pre = await ownersForBinding(payer, grants, { owners: async () => [owner] }, askedId);
      expect(await pre?.owners(SRC)).toEqual([owner]);
      expect((await decidePayerBinding(payer, grants, { me: { userId: owner, admin: null }, id: askedId, approve: false, owners: pre })).decided).toBe(true);
      const personal = randomUUID();
      await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${personal}, ${human}, 0)`;
      const other = await requestPayerBinding(payer, { subjectUserId: await user(tx, "other"), billingAccountId: personal });
      expect(await ownersForBinding(payer, grants, { owners: async () => [owner] }, other.id)).toBeUndefined();
    });
  });
});
