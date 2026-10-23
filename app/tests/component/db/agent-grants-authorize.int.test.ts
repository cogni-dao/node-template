// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-grants-authorize.int.test`
 * Purpose: Conformance for `@cogni-dao/agent-grants` against real Postgres +
 *   migration 0034 under the RLS-enforced app role: authorize() for owner,
 *   live grant, expired, revoked, wrong scope, and foreign account; the
 *   request → approve → grant lifecycle; the SQL `agent_has_scope()` agreeing
 *   with authorize(); the billing_accounts delegated-read policy; and
 *   revocable agent credentials.
 * Scope: Package functions + database policies. No HTTP.
 * Invariants:
 *   - MIRRORS_SQL: authorize() !== null exactly when agent_has_scope() is true.
 *   - RLS_BACKSTOP: a grantee can SELECT the granted billing account only while
 *     its grant is live; never a foreign account.
 * Side-effects: IO (database operations via testcontainers)
 * Notes: getAppDb() = app_user (FORCE RLS); getSeedDb() = app_service
 *   (BYPASSRLS) for seed/cleanup and the service-role credential helpers.
 * Links: packages/agent-grants, app/src/adapters/server/db/migrations/0034_agent_grants.sql, story.5115
 * @public
 */

import { randomUUID } from "node:crypto";
import {
  type AgentGrantsDb,
  AgentGrantsError,
  authorize,
  createAccessRequest,
  decideAccessRequest,
  isAgentCredentialLive,
  previewAccessRequest,
  recordAgentCredential,
  revokeAgentCredential,
  revokeOwnedGrant,
} from "@cogni-dao/agent-grants";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import {
  agentAccessRequests,
  agentCapabilityGrants,
  agentCredentials,
  billingAccounts,
  users,
} from "@/shared/db/schema";

const SCOPE = "account:read";
const DECLARED = [SCOPE] as const;

function asUser<T>(userId: string, fn: (tx: AgentGrantsDb) => Promise<T>) {
  return withTenantScope(getAppDb(), userActor(toUserId(userId)), fn);
}

async function sqlHasScope(userId: string, accountId: string, scope: string) {
  return asUser(userId, async (tx) => {
    const rows = await tx.execute(
      sql`SELECT agent_has_scope(${accountId}, ${scope}) AS allowed`
    );
    return (rows as unknown as Array<{ allowed: boolean }>)[0]?.allowed;
  });
}

async function rlsVisibleBalance(userId: string, accountId: string) {
  return asUser(userId, async (tx) => {
    const [row] = await tx
      .select({ balance: billingAccounts.balanceCredits })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId));
    return row?.balance ?? null;
  });
}

describe("agent-grants authorize() + lifecycle (real Postgres, RLS)", () => {
  const owner = { userId: randomUUID(), accountId: randomUUID() };
  const agent = { userId: randomUUID(), accountId: randomUUID() };
  const foreign = { userId: randomUUID(), accountId: randomUUID() };
  const expiredGrantee = { userId: randomUUID(), accountId: randomUUID() };
  const all = [owner, agent, foreign, expiredGrantee];
  let grantId: string;

  beforeAll(async () => {
    const seed = getSeedDb();
    await seed.insert(users).values(
      all.map((p, i) => ({ id: p.userId, name: `agent-grants-${i}` }))
    );
    await seed.insert(billingAccounts).values(
      all.map((p, i) => ({
        id: p.accountId,
        ownerUserId: p.userId,
        balanceCredits: BigInt(100 * (i + 1)),
      }))
    );
    // An expired grant on owner's account (seeded: approval never mints the past).
    await seed.insert(agentCapabilityGrants).values({
      billingAccountId: owner.accountId,
      granteePrincipalId: expiredGrantee.userId,
      scopes: [SCOPE],
      createdAt: new Date(Date.now() - 2 * 3_600_000),
      expiresAt: new Date(Date.now() - 3_600_000),
      createdByUserId: owner.userId,
    });
  });

  afterAll(async () => {
    const seed = getSeedDb();
    const ids = all.map((p) => p.userId);
    await seed
      .delete(agentAccessRequests)
      .where(inArray(agentAccessRequests.requesterPrincipalId, ids));
    await seed
      .delete(agentCapabilityGrants)
      .where(inArray(agentCapabilityGrants.createdByUserId, ids));
    await seed.delete(users).where(inArray(users.id, ids));
  });

  it("rejects an undeclared scope before any write", async () => {
    await expect(
      asUser(agent.userId, (tx) =>
        createAccessRequest(tx, {
          principalId: agent.userId,
          displayName: "agent",
          scopes: ["admin:all"],
          declaredScopes: DECLARED,
        })
      )
    ).rejects.toBeInstanceOf(AgentGrantsError);
  });

  it("denies the agent before any grant exists", async () => {
    expect(
      await asUser(agent.userId, (tx) =>
        authorize(tx, {
          principalId: agent.userId,
          accountId: owner.accountId,
          requiredScope: SCOPE,
        })
      )
    ).toBeNull();
    expect(await sqlHasScope(agent.userId, owner.accountId, SCOPE)).toBe(false);
    expect(await rlsVisibleBalance(agent.userId, owner.accountId)).toBeNull();
  });

  it("request → preview → owner approve writes a live grant", async () => {
    const created = await asUser(agent.userId, (tx) =>
      createAccessRequest(tx, {
        principalId: agent.userId,
        displayName: "agent",
        scopes: [SCOPE],
        declaredScopes: DECLARED,
      })
    );
    const [stored] = await getSeedDb()
      .select({ hash: agentAccessRequests.approvalTokenHash })
      .from(agentAccessRequests)
      .where(eq(agentAccessRequests.id, created.id));
    expect(stored?.hash).not.toBe(created.token);

    const preview = await asUser(owner.userId, (tx) =>
      previewAccessRequest(tx, { token: created.token })
    );
    expect(preview?.requestedScopes).toEqual([SCOPE]);

    const decided = await asUser(owner.userId, (tx) =>
      decideAccessRequest(tx, {
        token: created.token,
        ownerId: owner.userId,
        decision: "approve",
        declaredScopes: DECLARED,
      })
    );
    expect(decided?.status).toBe("approved");
    expect(decided?.billingAccountId).toBe(owner.accountId);
    grantId = decided?.grantId as string;
    expect(grantId).toBeTruthy();

    // ONE_TIME: the token cannot be decided twice.
    expect(
      await asUser(owner.userId, (tx) =>
        decideAccessRequest(tx, {
          token: created.token,
          ownerId: owner.userId,
          decision: "approve",
          declaredScopes: DECLARED,
        })
      )
    ).toBeNull();
  });

  it("owner → owner; live grant → delegated; SQL and RLS agree", async () => {
    expect(
      await asUser(owner.userId, (tx) =>
        authorize(tx, {
          principalId: owner.userId,
          accountId: owner.accountId,
          requiredScope: SCOPE,
        })
      )
    ).toEqual({ accessKind: "owner", grantId: null });
    expect(await sqlHasScope(owner.userId, owner.accountId, SCOPE)).toBe(true);

    expect(
      await asUser(agent.userId, (tx) =>
        authorize(tx, {
          principalId: agent.userId,
          accountId: owner.accountId,
          requiredScope: SCOPE,
        })
      )
    ).toEqual({ accessKind: "delegated", grantId });
    expect(await sqlHasScope(agent.userId, owner.accountId, SCOPE)).toBe(true);
    expect(await rlsVisibleBalance(agent.userId, owner.accountId)).toBe(100n);
  });

  it("wrong scope, foreign account, and expired grant all deny", async () => {
    const cases = [
      { who: agent.userId, account: owner.accountId, scope: "other:read" },
      { who: agent.userId, account: foreign.accountId, scope: SCOPE },
      { who: expiredGrantee.userId, account: owner.accountId, scope: SCOPE },
    ];
    for (const c of cases) {
      expect(
        await asUser(c.who, (tx) =>
          authorize(tx, {
            principalId: c.who,
            accountId: c.account,
            requiredScope: c.scope,
          })
        )
      ).toBeNull();
      expect(await sqlHasScope(c.who, c.account, c.scope)).toBe(false);
    }
    expect(await rlsVisibleBalance(agent.userId, foreign.accountId)).toBeNull();
    expect(
      await rlsVisibleBalance(expiredGrantee.userId, owner.accountId)
    ).toBeNull();
  });

  it("a non-owner cannot revoke; the owner's soft revoke denies again", async () => {
    expect(
      await asUser(agent.userId, (tx) =>
        revokeOwnedGrant(tx, { ownerId: agent.userId, grantId })
      )
    ).toBeNull();

    const revoked = await asUser(owner.userId, (tx) =>
      revokeOwnedGrant(tx, { ownerId: owner.userId, grantId })
    );
    expect(revoked?.revokedAt).toBeTruthy();

    expect(
      await asUser(agent.userId, (tx) =>
        authorize(tx, {
          principalId: agent.userId,
          accountId: owner.accountId,
          requiredScope: SCOPE,
        })
      )
    ).toBeNull();
    expect(await sqlHasScope(agent.userId, owner.accountId, SCOPE)).toBe(false);
    expect(await rlsVisibleBalance(agent.userId, owner.accountId)).toBeNull();
  });

  it("revocable credentials: live until revoked; app role cannot read them", async () => {
    const seed = getSeedDb() as unknown as AgentGrantsDb;
    const key = `cogni_ag_sk_v1_test.${randomUUID()}`;
    await recordAgentCredential(seed, { userId: agent.userId, key });

    const [row] = await getSeedDb()
      .select({ keyHash: agentCredentials.keyHash })
      .from(agentCredentials)
      .where(eq(agentCredentials.userId, agent.userId));
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.keyHash).not.toContain(key);

    expect(
      await isAgentCredentialLive(seed, { userId: agent.userId, key })
    ).toBe(true);
    expect(
      await isAgentCredentialLive(seed, { userId: foreign.userId, key })
    ).toBe(false);
    expect(
      await asUser(agent.userId, (tx) => tx.select().from(agentCredentials))
    ).toEqual([]);

    expect(
      await revokeAgentCredential(seed, { userId: agent.userId, key })
    ).toBeTruthy();
    expect(
      await isAgentCredentialLive(seed, { userId: agent.userId, key })
    ).toBe(false);
  });
});
