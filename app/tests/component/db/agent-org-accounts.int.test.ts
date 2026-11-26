// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-org-accounts.int.test`
 * Purpose: Org accounts (task.0181) against real Postgres as the service role: the history cannot be rewritten, an older statement cannot replace a newer one, an admin change is
 *   logged with the old and new list, a spend grant for a wallet that has not signed in is held and then claimed, suspension needs a reason and is logged, and a person who is no
 *   admin and holds no row has no role.
 * Scope: Every test runs in one transaction that is rolled back, so no row leaks to other tests.
 * Invariants: EVERY_ACT_LOGGED, APPEND_ONLY_HISTORY, VERSION_ONLY_RISES, SPEND_HELD_BY_WALLET, SUSPEND_NEEDS_A_REASON.
 * Side-effects: IO (testcontainers Postgres, rolled back)
 */

import { randomUUID } from "node:crypto";
import type { SqlTag } from "@cogni/agent-grants";
import {
  applyStatement,
  assertOrgChargeable,
  claimHolds,
  createPostgresBillToLookups,
  createPostgresReplayStore,
  disconnectOrg,
  grantOrgSpend,
  listMyOrgs,
  recordOrgFunded,
  orgAccountView,
  listOrgAccountsForAdmin,
  listOrgEvents,
  orgByOrigin,
  orgRoleOf,
  removeOrgSpend,
  restoreOrg,
  suspendOrg,
} from "@cogni/agent-grants/org-accounts";
import { listOrgConnections } from "@cogni/agent-grants/org-connect";
import { servicePrincipalId } from "@cogni/agent-grants/service-auth";
import type { OrgStatement } from "@cogni/agent-grants/org-statement";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROLLBACK = new Error("rollback");
const ORIGIN = "https://toks5.example.com";
const A1 = "0x00000000000000000000000000000000000000a1";
const A2 = "0x00000000000000000000000000000000000000a2";

const statement = (over: Partial<OrgStatement> = {}): OrgStatement => ({
  origin: ORIGIN,
  nodeId: "toks5",
  dao: null,
  admins: [A1],
  services: ["node-ai"],
  version: 1_800_000_000,
  commit: null,
  iat: 1_800_000_000,
  exp: 1_800_000_300,
  ...over,
});

describe("org accounts (real Postgres, service role)", () => {
  let service: Sql;

  beforeAll(() => {
    if (!process.env.DATABASE_SERVICE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 2 });
  });
  afterAll(async () => {
    await service?.end({ timeout: 1 });
  });

  const rolledBack = async (fn: (tx: TransactionSql, sql: SqlTag) => Promise<void>) => {
    await service
      .begin(async (tx) => {
        await fn(tx, tx as unknown as SqlTag);
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  };

  const person = async (tx: TransactionSql, wallet?: string): Promise<string> => {
    const id = randomUUID();
    await tx`INSERT INTO users (id, name) VALUES (${id}, 'person')`;
    if (wallet) await tx`INSERT INTO user_bindings (id, user_id, provider, external_id) VALUES (${randomUUID()}, ${id}, 'wallet', ${wallet})`;
    return id;
  };

  it("connect creates the account once with its one billing account and logs org.connected; a second connect logs again and creates nothing", async () => {
    await rolledBack(async (tx, sql) => {
      const first = await applyStatement(sql, statement(), "connect");
      const again = await applyStatement(sql, statement({ version: 1_800_000_100 }), "connect");
      expect(again?.orgUserId).toBe(first?.orgUserId);
      expect(await tx`SELECT 1 FROM billing_accounts WHERE owner_user_id = ${first?.orgUserId as string}`).toHaveLength(1);
      const { events } = await listOrgEvents(sql, first?.orgUserId as string);
      expect(events.filter((e) => e.act === "org.connected")).toHaveLength(2);
    });
  });

  it("an older statement than the one held changes nothing and is not a failure, so a replayed list cannot take admin back and a skewed read does not lapse the org", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement({ version: 1_800_000_200 }), "connect");
      await expect(applyStatement(sql, statement({ version: 1_800_000_100, admins: [A1, A2] }), "refresh")).resolves.toMatchObject({ applied: false, status: "connected" });
      const org = await orgByOrigin(sql, ORIGIN);
      expect(org?.admins).toEqual([A1]);
      expect(org?.version).toBe(1_800_000_200);
      expect(await tx`SELECT 1 FROM org_events WHERE act = 'org.admins_changed'`).toHaveLength(0);
    });
  });

  it("a statement at the SAME version with other facts is stale (facts are constant per build), and the answer carries the version this node holds", async () => {
    await rolledBack(async (_tx, sql) => {
      await applyStatement(sql, statement({ version: 1_800_000_200 }), "connect");
      const result = await applyStatement(sql, statement({ version: 1_800_000_200, admins: [A1, A2] }), "refresh");
      expect(result).toMatchObject({ applied: false, version: 1_800_000_200 });
      expect((await orgByOrigin(sql, ORIGIN))?.admins).toEqual([A1]);
      // The same facts at the same version are applied as a no-op.
      expect(await applyStatement(sql, statement({ version: 1_800_000_200 }), "refresh")).toMatchObject({ applied: true, version: 1_800_000_200 });
    });
  });

  it("a spender's view of the org carries no billing account id (only an admin may fund, so only an admin is given it)", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      const spender = await person(tx, A2);
      await grantOrgSpend(sql, { org, by: admin, wallet: A2 });
      await claimHolds(sql, spender);
      const owners = { owners: async () => [admin] };
      const spends = await orgAccountView(sql, { owners, userId: spender, orgUserId: org.orgUserId });
      expect(spends).toMatchObject({ role: "spend", canManage: false });
      expect(spends && "billingAccountId" in spends).toBe(false);
      expect((await orgAccountView(sql, { owners, userId: admin, orgUserId: org.orgUserId }))?.billingAccountId).toBe(org.billingAccountId);
    });
  });

  it("a payment funds the org once: the same payment ref twice writes one row (the unique index), another ref writes another, and the row is read back with its amount", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      const fund = (paymentRef: string) => recordOrgFunded(sql, { orgBillingAccountId: org.billingAccountId, actorUserId: admin, amountCredits: 2500, paymentRef });
      expect(await fund("pay_123")).toMatchObject({ recorded: true });
      expect(await fund("pay_123")).toMatchObject({ recorded: false });
      expect(await fund("pay_456")).toMatchObject({ recorded: true });
      const rows = await tx`SELECT actor, detail FROM org_events WHERE org_user_id = ${org.orgUserId} AND act = 'org.funded' ORDER BY detail->>'paymentRef'`;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.actor).toBe(admin);
      expect(rows[0]?.detail).toMatchObject({ amountCredits: 2500, paymentRef: "pay_123" });
    });
  });

  it("funding refuses a person's own account, an unknown actor and a bad payment ref, and writes nothing", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const admin = await person(tx, A1);
      const own = await tx`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${randomUUID()}, ${admin}, 0) RETURNING id`;
      await expect(recordOrgFunded(sql, { orgBillingAccountId: String(own[0]?.id), actorUserId: admin, amountCredits: 1, paymentRef: "p" })).rejects.toMatchObject({ code: "not_allowed" });
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      await expect(recordOrgFunded(sql, { orgBillingAccountId: org.billingAccountId, actorUserId: randomUUID(), amountCredits: 1, paymentRef: "p" })).rejects.toMatchObject({ code: "not_allowed" });
      await expect(recordOrgFunded(sql, { orgBillingAccountId: org.billingAccountId, actorUserId: admin, amountCredits: 1, paymentRef: "" })).rejects.toMatchObject({ code: "invalid_payment_ref" });
      expect(await tx`SELECT 1 FROM org_events WHERE act = 'org.funded'`).toHaveLength(0);
    });
  });

  it("the connection's last operation is only connect or disconnect (the database refuses anything else)", async () => {
    await rolledBack(async (tx) => {
      const admin = await person(tx);
      await tx`INSERT INTO org_connections (origin, node_id, status, updated_by, last_op) VALUES ('https://ok.example.com', 'n', 'connected', ${admin}, 'disconnect')`;
      await expect(tx`INSERT INTO org_connections (origin, node_id, status, updated_by, last_op) VALUES ('https://bad.example.com', 'n', 'connected', ${admin}, 'other')`).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("lists connections by status, by acknowledged version below the build's, and an unreachable one only when the org's last operation was a connect", async () => {
    await rolledBack(async (tx, sql) => {
      const admin = await person(tx);
      const rows: Array<[string, string, number | null, string]> = [
        ["https://a.example.com", "connected", null, "connect"],
        ["https://b.example.com", "connected", 100, "connect"],
        ["https://c.example.com", "unreachable", 50, "connect"],
        ["https://d.example.com", "unreachable", null, "disconnect"],
        ["https://e.example.com", "disconnected", null, "disconnect"],
        ["https://f.example.com", "connected", 99, "connect"],
      ];
      for (const [origin, status, version, lastOp] of rows)
        await tx`INSERT INTO org_connections (origin, node_id, status, updated_by, statement_version, last_op) VALUES (${origin}, ${origin.slice(8, 9)}, ${status}, ${admin}, ${version}::bigint, ${lastOp})`;
      const origins = async (filter?: Parameters<typeof listOrgConnections>[2]) => (await listOrgConnections(sql, null, filter)).connections.map((c) => c.origin.slice(8, 9));
      expect(await origins()).toEqual(["a", "b", "c", "d", "e", "f"]);
      expect(await origins({ statuses: ["connected"] })).toEqual(["a", "b", "f"]);
      expect(await origins({ statuses: ["connected", "unreachable"], below: 100, connectsOnly: true })).toEqual(["a", "c", "f"]);
      // Without `connectsOnly` the unreachable disconnect (d) would be asked too.
      expect(await origins({ statuses: ["connected", "unreachable"], below: 100 })).toEqual(["a", "c", "d", "f"]);
    });
  });

  it("a statement another replica signed a moment earlier with the same facts is applied as a no-op and the stored version never goes down", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement({ version: 1_800_000_200 }), "connect");
      await expect(applyStatement(sql, statement({ version: 1_800_000_100 }), "refresh")).resolves.toMatchObject({ applied: true, status: "connected" });
      expect((await orgByOrigin(sql, ORIGIN))?.version).toBe(1_800_000_200);
      // A reconnect carrying the earlier replica's version still reconnects, and still keeps the higher version.
      await tx`UPDATE org_accounts SET disconnected_at = now() WHERE origin = ${ORIGIN}`;
      await expect(applyStatement(sql, statement({ version: 1_800_000_100 }), "connect")).resolves.toMatchObject({ applied: true, status: "connected" });
      expect((await orgByOrigin(sql, ORIGIN))?.version).toBe(1_800_000_200);
    });
  });

  it("a refresh that names another node id is refused and never overwrites the connected node id", async () => {
    await rolledBack(async (_tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      await expect(applyStatement(sql, statement({ version: 1_800_000_100, nodeId: "someone-else" }), "refresh")).rejects.toMatchObject({ code: "wrong_node" });
      expect((await orgByOrigin(sql, ORIGIN))?.nodeId).toBe("toks5");
    });
  });

  it("logs an admin change with the old and the new list", async () => {
    await rolledBack(async (tx, sql) => {
      const org = await applyStatement(sql, statement(), "connect");
      await applyStatement(sql, statement({ version: 1_800_000_100, admins: [A2] }), "refresh");
      const rows = await tx`SELECT detail, actor FROM org_events WHERE org_user_id = ${org?.orgUserId as string} AND act = 'org.admins_changed'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toMatchObject({ old: [A1], new: [A2] });
      // The actor is the org's `org-connect` service principal (a real user row), and the origin is in the detail.
      expect(rows[0]?.actor).toBe(await servicePrincipalId({ issuer: ORIGIN, service: "org-connect" }));
      expect(rows[0]?.detail).toMatchObject({ origin: ORIGIN });
    });
  });

  it("the history cannot be rewritten: UPDATE and DELETE on org_events are refused even for the service role", async () => {
    await rolledBack(async (tx, sql) => {
      const org = await applyStatement(sql, statement(), "connect");
      await expect(tx`UPDATE org_events SET reason = 'x' WHERE org_user_id = ${org?.orgUserId as string}`.execute()).rejects.toThrow();
    });
    await rolledBack(async (tx, sql) => {
      const org = await applyStatement(sql, statement(), "connect");
      await expect(tx`DELETE FROM org_events WHERE org_user_id = ${org?.orgUserId as string}`.execute()).rejects.toThrow();
    });
  });

  it("holds a spend grant for a wallet that has not signed in, claims it at the wallet's first read after sign-in, and a removal ends it", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      const held = await grantOrgSpend(sql, { org, by: admin, wallet: A2.toUpperCase().replace("0X", "0x") });
      expect(held).toEqual({ changed: true, held: true });
      expect(await grantOrgSpend(sql, { org, by: admin, wallet: A2 })).toEqual({ changed: false, held: true });

      const spender = await person(tx, A2);
      expect((await orgRoleOf(sql, undefined, { userId: spender, org })).role).toBeNull();
      expect(await claimHolds(sql, spender)).toBe(1);
      expect((await orgRoleOf(sql, undefined, { userId: spender, org })).role).toBe("spend");
      expect(await claimHolds(sql, spender)).toBe(0);

      expect(await removeOrgSpend(sql, { org, by: admin, wallet: A2 })).toEqual({ changed: true });
      expect((await orgRoleOf(sql, undefined, { userId: spender, org })).role).toBeNull();
      const acts = (await listOrgEvents(sql, org.orgUserId)).events.map((e) => e.act);
      expect(acts).toEqual(expect.arrayContaining(["org.spend_granted", "org.spend_claimed", "org.spend_removed"]));
    });
  });

  it("an admin is not granted spend by hand (admin already includes it), and a person with no row and no admin listing has no role", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      expect(await grantOrgSpend(sql, { org, by: admin, wallet: A1 })).toEqual({ changed: false, held: false });
      const owners = { owners: async () => [admin] };
      expect((await orgRoleOf(sql, owners, { userId: admin, org })).role).toBe("admin");
      expect((await orgRoleOf(sql, owners, { userId: await person(tx), org })).role).toBeNull();
    });
  });

  it("suspend needs a reason, is logged with it, shows in the status and restore clears it; a disconnect is logged once", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const nodeAdmin = await person(tx, A1);
      await expect(suspendOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "  " })).rejects.toMatchObject({ code: "invalid_reason" });
      await suspendOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "chargeback" });
      expect(await orgByOrigin(sql, ORIGIN)).toMatchObject({ status: "suspended", suspendReason: "chargeback" });
      await expect(suspendOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "again" })).rejects.toMatchObject({ code: "already_suspended" });
      await restoreOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "resolved" });
      expect(await orgByOrigin(sql, ORIGIN)).toMatchObject({ status: "connected", suspendReason: null });
      await disconnectOrg(sql, ORIGIN);
      await disconnectOrg(sql, ORIGIN);
      const { events } = await listOrgEvents(sql, org.orgUserId);
      expect(events.filter((e) => e.act === "org.disconnected")).toHaveLength(1);
      expect(events.find((e) => e.act === "org.suspended")).toMatchObject({ reason: "chargeback" });
    });
  });

  it("one node id belongs to one origin: a second origin claiming it is refused and creates nothing", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      await expect(applyStatement(sql, statement({ origin: "https://impostor.example.com" }), "connect")).rejects.toMatchObject({ code: "node_id_taken" });
      expect(await orgByOrigin(sql, "https://impostor.example.com")).toBeNull();
      expect(await tx`SELECT 1 FROM org_accounts WHERE node_id = 'toks5'`).toHaveLength(1);
    });
  });

  it("finds a calling service's org by one indexed read, and a service the statement dropped no longer maps", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement({ services: ["node-ai", "other"] }), "connect");
      const lookups = createPostgresBillToLookups(sql, undefined, undefined);
      const ai = await servicePrincipalId({ issuer: ORIGIN, service: "node-ai" });
      expect(await lookups.orgOfServicePrincipal(ai)).toMatchObject({ service: "node-ai", org: { origin: ORIGIN } });
      expect(await lookups.orgOfServicePrincipal(await person(tx))).toBeNull();
      await applyStatement(sql, statement({ version: 1_800_000_100, services: ["other"] }), "refresh");
      expect(await lookups.orgOfServicePrincipal(ai)).toBeNull();
      expect(await lookups.orgOfServicePrincipal(await servicePrincipalId({ issuer: ORIGIN, service: "other" }))).not.toBeNull();
    });
  });

  it("a connect assertion's jti is single-use in the database, so another replica cannot replay it, and an expired one does not pile up", async () => {
    await rolledBack(async (tx, sql) => {
      const replay = createPostgresReplayStore(sql);
      const soon = new Date(Date.now() + 60_000);
      expect(await replay.seen("a#j1", soon)).toBe(false);
      expect(await replay.seen("a#j1", soon)).toBe(true);
      expect(await replay.seen("a#old", new Date(Date.now() - 1000))).toBe(false);
      expect(await replay.seen("a#j1", soon)).toBe(true);
      expect(await tx`SELECT 1 FROM org_connect_jtis WHERE jti = 'a#old'`).toHaveLength(0);
    });
  });

  it("the same person can spend for two orgs (release B) and removing one keeps the other", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      await applyStatement(sql, statement({ origin: "https://other.example.com", nodeId: "other" }), "connect");
      const one = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const two = (await orgByOrigin(sql, "https://other.example.com")) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      const spender = await person(tx, A2);
      await grantOrgSpend(sql, { org: one, by: admin, wallet: A2 });
      await grantOrgSpend(sql, { org: two, by: admin, wallet: A2 });
      expect(await removeOrgSpend(sql, { org: one, by: admin, wallet: A2 })).toEqual({ changed: true });
      expect((await orgRoleOf(sql, undefined, { userId: spender, org: two })).role).toBe("spend");
    });
  });

  it("a person's org list is one read with the balance joined, and a spender-only org is listed without a statement", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      await tx`UPDATE billing_accounts SET balance_credits = 4200 WHERE id = ${org.billingAccountId}`;
      const admin = await person(tx, A1);
      const spender = await person(tx, A2);
      await grantOrgSpend(sql, { org, by: admin, wallet: A2 });
      await claimHolds(sql, spender);
      const mine = await listMyOrgs(sql, undefined, spender);
      expect(mine.orgs).toEqual([expect.objectContaining({ orgUserId: org.orgUserId, role: "spend", balance: 4200, status: "connected" })]);
      expect(mine.next).toBeNull();
    });
  });

  it("a hold for a person who already spends for that org is closed without a second row or a claim event", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      await grantOrgSpend(sql, { org, by: admin, wallet: A2 });
      const spender = await person(tx, A2);
      await tx`INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id) VALUES (${spender}, 'org:spend', ${admin}, now(), 'account', ${org.billingAccountId})`;
      expect(await claimHolds(sql, spender)).toBe(0);
      expect(await tx`SELECT 1 FROM org_wallet_holds WHERE claimed_at IS NOT NULL`).toHaveLength(1);
      expect(await tx`SELECT 1 FROM agent_roles WHERE principal_user_id = ${spender} AND scope = 'org:spend' AND revoked_at IS NULL`).toHaveLength(1);
      expect(await tx`SELECT 1 FROM org_events WHERE act = 'org.spend_claimed'`).toHaveLength(0);
    });
  });

  it("the history pages by cursor: every event is reachable, in order, with none skipped or repeated", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const nodeAdmin = await person(tx, A1);
      for (let i = 0; i < 5; i++) {
        await suspendOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: `r${i}` });
        await restoreOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: `u${i}` });
      }
      const seen: string[] = [];
      let before: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const page: { events: Array<{ act: string; reason: string | null }>; next: string | null } = await listOrgEvents(sql, org.orgUserId, { before, limit: 4 });
        seen.push(...page.events.map((e) => `${e.act}:${e.reason ?? ""}`));
        before = page.next;
        if (!before) break;
      }
      expect(seen).toHaveLength(11);
      expect(new Set(seen).size).toBe(11);
    });
  });

  it("claims several holds in one batch: one row and one event per org, a hold for an org the person already spends for is closed quietly", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      await applyStatement(sql, statement({ origin: "https://other.example.com", nodeId: "other" }), "connect");
      const one = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const two = (await orgByOrigin(sql, "https://other.example.com")) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      await grantOrgSpend(sql, { org: one, by: admin, wallet: A2 });
      await grantOrgSpend(sql, { org: two, by: admin, wallet: A2 });
      const spender = await person(tx, A2);
      expect(await claimHolds(sql, spender)).toBe(2);
      expect(await tx`SELECT 1 FROM org_events WHERE act = 'org.spend_claimed'`).toHaveLength(2);
      expect((await orgRoleOf(sql, undefined, { userId: spender, org: one })).role).toBe("spend");
      expect((await orgRoleOf(sql, undefined, { userId: spender, org: two })).role).toBe("spend");
    });
  });

  it("the org page lists grants and waiting holds by keyset and a cursor reaches the rest, with the admins and services on the first page only", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement({ services: ["node-ai"] }), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const admin = await person(tx, A1);
      await tx`INSERT INTO org_wallet_holds (org_user_id, wallet, scope, granted_by) SELECT ${org.orgUserId}, '0x' || lpad(to_hex(g), 40, '0'), 'org:spend', ${admin} FROM generate_series(1, 101) g`;
      const owners = { owners: async () => [admin] };
      const first = await orgAccountView(sql, { owners, userId: admin, orgUserId: org.orgUserId });
      expect(first?.canManage).toBe(true);
      expect(first?.billingAccountId).toBe(org.billingAccountId);
      expect(first?.people.filter((p) => p.held)).toHaveLength(100);
      expect(first?.people.some((p) => p.role === "admin")).toBe(true);
      expect(first?.people.some((p) => p.kind === "service")).toBe(true);
      expect(first?.peopleNext).not.toBeNull();
      const rest = await orgAccountView(sql, { owners, userId: admin, orgUserId: org.orgUserId, peopleAfter: first?.peopleNext ?? null });
      expect(rest?.people).toHaveLength(1);
      expect(rest?.people[0]?.held).toBe(true);
      expect(rest?.peopleNext).toBeNull();
      expect(rest?.history).toEqual([]);
      const wallets = new Set([...(first?.people ?? []), ...(rest?.people ?? [])].filter((p) => p.held).map((p) => p.who));
      expect(wallets.size).toBe(101);
    });
  });

  it("a refresh that read the same content writes nothing, and a changed list is written together with its history row", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const before = await tx`SELECT fetched_at, statement_version FROM org_accounts WHERE origin = ${ORIGIN}`;
      expect(await applyStatement(sql, statement({ version: 1_800_000_050 }), "refresh")).toMatchObject({ applied: true, changed: { admins: false, services: false } });
      const same = await tx`SELECT fetched_at, statement_version FROM org_accounts WHERE origin = ${ORIGIN}`;
      expect(same[0]).toEqual(before[0]);
      // The host logs these flags as `org.admins_changed` / `org.services_changed` lines.
      expect(await applyStatement(sql, statement({ version: 1_800_000_100, admins: [A1, A2] }), "refresh")).toMatchObject({ applied: true, changed: { admins: true, services: false } });
      expect((await orgByOrigin(sql, ORIGIN))?.admins).toEqual([A1, A2]);
      expect(await tx`SELECT 1 FROM org_events WHERE act = 'org.admins_changed'`).toHaveLength(1);
    });
  });

  it("the admin list pages by origin without skipping or repeating an account", async () => {
    await rolledBack(async (_tx, sql) => {
      for (const [i, host] of ["a", "b", "c"].entries()) await applyStatement(sql, statement({ origin: `https://${host}.example.com`, nodeId: `n${i}` }), "connect");
      const all = await listOrgAccountsForAdmin(sql);
      expect(all.orgs.map((o) => o.name).filter((n) => /^[abc]\.example\.com$/.test(n))).toEqual(["a.example.com", "b.example.com", "c.example.com"]);
      const rest = await listOrgAccountsForAdmin(sql, { after: "https://a.example.com" });
      expect(rest.orgs.map((o) => o.name)).not.toContain("a.example.com");
      expect(rest.orgs.map((o) => o.name)).toContain("b.example.com");
    });
  });

  it("a suspended org account is not chargeable, a restored one is, and an account that is no org's always is", async () => {
    await rolledBack(async (tx, sql) => {
      await applyStatement(sql, statement(), "connect");
      const org = (await orgByOrigin(sql, ORIGIN)) as NonNullable<Awaited<ReturnType<typeof orgByOrigin>>>;
      const nodeAdmin = await person(tx, A1);
      await suspendOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "chargeback" });
      await expect(assertOrgChargeable(sql, org.billingAccountId)).rejects.toMatchObject({ code: "org_suspended", message: "chargeback" });
      await restoreOrg(sql, { orgUserId: org.orgUserId, by: nodeAdmin, reason: "resolved" });
      await expect(assertOrgChargeable(sql, org.billingAccountId)).resolves.toBeUndefined();
      await expect(assertOrgChargeable(sql, randomUUID())).resolves.toBeUndefined();
    });
  });
});
