// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/agent-personal-grants.int.test`
 * Purpose: PERSONAL GRANTS, `account:read` (task.5465), against real Postgres through the real route handlers and the real RLS policies.
 *   The owner click loop: an owned agent asks (an Off row), the owner turns it On on their profile, the agent reads the owner's balance (200), the owner turns it Off,
 *   the agent gets 404. Another person's account, an expired grant, a revoked grant, a node row and an unowned agent are all 404 / 0 rows.
 *   PARITY: in one test the database (RLS, app role, context user = the agent) and `authorizeAccount` agree on every state (live, revoked, expired, owner changed).
 * Scope: Real `agent.access.requests`, `agent-access/mine` and `accounts/{id}/credits` handlers, real wrapper, real `agent-authority`, real migrations (0042) and
 *   the production app role (FORCE RLS). Only the NextAuth/bearer identity decode is replaced (`getSessionUser`).
 * Invariants: ACCOUNT_SCOPE_NEEDS_OWNER_GRANT, NO_SELF_APPROVAL, APPROVER_FOLLOWS_RESOURCE, RLS_BACKSTOP, FAIL_CLOSED_NON_DISCLOSING, HUMAN_ROUTES_SESSION_ONLY.
 * Side-effects: IO (testcontainers or local Postgres)
 */

import { randomUUID } from "node:crypto";
import { authorizeAccount, createPostgresAgentGrantsStore } from "@cogni/agent-grants";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { toUserId } from "@cogni/ids";
import { NextRequest } from "next/server";
import pino from "pino";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(async () => session.user),
}));
const holder = vi.hoisted(() => ({ container: null as unknown }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => holder.container,
}));

import { UserDrizzleAccountService } from "@/adapters/server/accounts/drizzle.adapter";
import { getAppDb } from "@/adapters/server/db/client";
import { GET as creditsGet } from "@/app/api/v1/accounts/[accountId]/credits/route";
import { GET as askList, POST as askCreate } from "@/app/api/v1/agent/access-requests/route";
import { DELETE as mineDelete, GET as mineGet, POST as minePost } from "@/app/api/v1/agent-access/mine/route";
import { type AgentAuthoritySql, createAgentToolAuthority } from "@/bootstrap/agent-authority";
import { createNodeAdminPort } from "@/bootstrap/node-admin-port";

const SCOPE = "account:read";

describe("personal grants: account:read (real Postgres, real RLS)", () => {
  let service: Sql;
  let app: Sql;
  const users: string[] = [];
  let owner: string;
  let other: string;
  let agent: string;
  let otherAgent: string;
  let unowned: string;
  const account = { owner: `acct-${randomUUID()}`, other: `acct-${randomUUID()}`, agent: `acct-${randomUUID()}` };
  let authority: ReturnType<typeof createAgentToolAuthority>;
  const lines: Array<Record<string, unknown>> = [];

  const mkUser = async (name: string) => {
    const id = randomUUID();
    await service`INSERT INTO users (id, name) VALUES (${id}, ${name})`;
    users.push(id);
    return id;
  };
  const mkAgent = async (name: string, ownerId: string | null) => {
    const id = await mkUser(name);
    await service`INSERT INTO agent_principals (kind, slug, user_id, owner_user_id) VALUES ('external', NULL, ${id}, ${ownerId})`;
    return id;
  };
  const mkAccount = (id: string, ownerId: string, balance: number) =>
    service`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${id}, ${ownerId}, ${balance})`;

  const as = (id: string | null, via: "bearer" | "session") =>
    (session.user = id ? { id, walletAddress: null, displayName: null, avatarColor: null, via } : null);
  const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new NextRequest(url, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const ask = () => askCreate(req("http://localhost/api/v1/agent/access-requests", { method: "POST", body: { scope: SCOPE } }), undefined as never);
  const myAccess = async () =>
    (await (await askList(req("http://localhost/api/v1/agent/access-requests"), undefined as never)).json()) as {
      requests: Array<{ scope: string; state: string; accountId?: string }>;
    };
  const readCredits = (accountId: string) =>
    creditsGet(req(`http://localhost/api/v1/accounts/${accountId}/credits`), { params: Promise.resolve({ accountId }) } as never);
  const mine = async () =>
    (await (await mineGet(req("http://localhost/api/v1/agent-access/mine"), undefined as never)).json()) as {
      permissions: Array<{ principalUserId: string; who: string; scope: string; label: string; on: boolean; until: string | null }>;
    };
  const turn = (handler: typeof minePost, body: unknown, headers: Record<string, string> = {}) =>
    handler(req("http://localhost/api/v1/agent-access/mine", { method: handler === minePost ? "POST" : "DELETE", body, headers }), undefined as never);
  const authz = (userId: string, via: "bearer" | "session", accountId: string) =>
    authorizeAccount(createPostgresAgentGrantsStore(service as never), { userId, via, accountId, scope: SCOPE });
  /** The database's answer: the app role, the context user set the way the adapter sets it (SET LOCAL app.current_user_id). */
  const dbSees = async (contextUser: string | null, accountId: string) =>
    app.begin(async (tx) => {
      if (contextUser) await tx`SELECT set_config('app.current_user_id', ${contextUser}, true)`;
      return (await tx`SELECT id FROM billing_accounts WHERE id = ${accountId}`).length;
    });
  const rowOf = async (principal: string) =>
    (await service`SELECT resource_kind, owner_user_id, approved_by, requested_by, revoked_at, expires_at,
        (expires_at > now() + interval '29 days' AND expires_at < now() + interval '31 days') AS thirty_days
      FROM agent_roles WHERE principal_user_id = ${principal} AND scope = ${SCOPE} ORDER BY created_at DESC LIMIT 1`)[0];

  beforeAll(async () => {
    if (!process.env.DATABASE_SERVICE_URL || !process.env.DATABASE_URL) throw new Error("component PostgreSQL required");
    service = postgres(process.env.DATABASE_SERVICE_URL, { max: 4 });
    app = postgres(process.env.DATABASE_URL, { max: 2 });
    owner = await mkUser("Olive Owner");
    other = await mkUser("Pat Person");
    agent = await mkAgent("Helper bot", owner);
    otherAgent = await mkAgent("Pat's bot", other);
    unowned = await mkAgent("Loose bot", null);
    await mkAccount(account.owner, owner, 1234);
    await mkAccount(account.other, other, 777);
    await mkAccount(account.agent, agent, 5); // an agent has an account of its own; it is not the account it is asking about
    const logger = pino({ level: "info", timestamp: false }, { write: (c: string) => void lines.push(JSON.parse(c)) });
    const nodeAdmin = { check: async () => ({ ok: false as const, errorCode: "authz_denied" as const }) };
    authority = createAgentToolAuthority({
      sql: service as unknown as AgentAuthoritySql,
      nodeAdmin,
      log: logger,
      toolBundle: [...CORE_TOOL_BUNDLE],
    });
    holder.container = {
      log: logger,
      config: { unhandledErrorPolicy: "rethrow" },
      agentAuthority: authority,
      nodeAdmin,
      nodeAdminPort: createNodeAdminPort(authority),
      accountsForUser: (userId: string) => new UserDrizzleAccountService(getAppDb(), toUserId(userId)),
    };
  });
  afterAll(async () => {
    await service?.unsafe("DELETE FROM agent_roles WHERE principal_user_id = ANY($1) OR approved_by = ANY($1) OR owner_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM billing_accounts WHERE owner_user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM agent_principals WHERE user_id = ANY($1)", [users]);
    await service?.unsafe("DELETE FROM users WHERE id = ANY($1)", [users]);
    await service?.end({ timeout: 1 });
    await app?.end({ timeout: 1 });
  });

  it("the owner click test: ask -> Off row -> owner On -> agent reads the owner's balance (200) -> owner Off -> 404; another person's account is 404 throughout", async () => {
    // BEFORE: no ask, no grant. The agent cannot read its owner's account.
    as(agent, "bearer");
    expect((await readCredits(account.owner)).status).toBe(404);

    // The agent asks. The row is OFF, owned by the agent's owner, kind account.
    const first = await ask();
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ scope: SCOPE, state: "pending", created: true });
    expect(await rowOf(agent)).toMatchObject({ resource_kind: "account", owner_user_id: owner, approved_by: null, requested_by: agent });
    expect((await readCredits(account.owner)).status).toBe(404); // an Off row opens nothing
    expect((await myAccess()).requests).toEqual([{ scope: SCOPE, state: "pending", at: expect.any(String) }]);

    // The owner sees the ask as Off on their profile; the other person sees nothing of it.
    as(owner, "session");
    expect((await mine()).permissions).toEqual([
      expect.objectContaining({ principalUserId: agent, who: "Helper bot", scope: SCOPE, label: "Read your account balance", on: false, until: null }),
    ]);
    as(other, "session");
    expect((await mine()).permissions).toEqual([]);

    // Another person cannot turn it On (404, the same as an unknown agent). The AI cannot turn itself On (the route is session only).
    expect((await turn(minePost, { principalUserId: agent, scope: SCOPE })).status).toBe(404);
    as(agent, "bearer");
    expect((await turn(minePost, { principalUserId: agent, scope: SCOPE })).status).toBe(401);
    expect((await readCredits(account.owner)).status).toBe(404);

    // The owner turns it On. The row ends in 30 days and the OWNER is the approver.
    as(owner, "session");
    const on = await turn(minePost, { principalUserId: agent, scope: SCOPE });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ principalUserId: agent, scope: SCOPE, changed: true });
    expect(await rowOf(agent)).toMatchObject({ approved_by: owner, owner_user_id: owner, thirty_days: true });
    expect((await mine()).permissions[0]).toMatchObject({ on: true, until: expect.any(String) });

    // The agent learns the account from its own access list, and reads it: 200.
    as(agent, "bearer");
    const granted = (await myAccess()).requests[0];
    expect(granted).toMatchObject({ scope: SCOPE, state: "granted", accountId: account.owner });
    const ok = await readCredits(account.owner);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accountId: account.owner, balanceCredits: 1234 });
    // Not the agent's own account named as if it were the owner's, and not another person's account.
    expect((await readCredits(account.other)).status).toBe(404);
    expect((await readCredits(`acct-${randomUUID()}`)).status).toBe(404);
    expect((await readCredits("../../etc/passwd")).status).toBe(404);
    // A human signed in as someone else never reads this account, and the owner always reads their own.
    as(other, "session");
    expect((await readCredits(account.owner)).status).toBe(404);
    as(owner, "session");
    expect((await readCredits(account.owner)).status).toBe(200);

    // The owner turns it Off. The agent's very next read is 404.
    const off = await turn(mineDelete, { principalUserId: agent, scope: SCOPE });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ principalUserId: agent, scope: SCOPE, changed: true });
    as(agent, "bearer");
    expect((await readCredits(account.owner)).status).toBe(404);
    expect((await myAccess()).requests[0]).toMatchObject({ scope: SCOPE, state: "revoked" });
    expect((await rowOf(agent))?.revoked_at).not.toBeNull();

    // The log shows the agent as principal and the decision at each step.
    const decisions = lines.filter((l) => l.event === "agent_tool.authz" && l.route === "accounts.credits.read" && l.principal === agent);
    expect(decisions.some((l) => l.decision === "allow" && l.reason === "personal_grant")).toBe(true);
    expect(decisions.some((l) => l.decision === "deny" && l.reason === "no_access")).toBe(true);
  });

  it("PARITY: the database (RLS, app role, context user = the agent) and authorizeAccount answer the same in every state", async () => {
    const grant = async () => {
      as(agent, "bearer");
      await ask();
      as(owner, "session");
      expect((await turn(minePost, { principalUserId: agent, scope: SCOPE })).status).toBe(200);
    };
    const both = async (expected: boolean) => {
      expect(await dbSees(agent, account.owner), "RLS").toBe(expected ? 1 : 0);
      expect(!!(await authz(agent, "bearer", account.owner)), "authorizeAccount").toBe(expected);
    };

    await both(false); // no row yet (the previous test ended Off)
    await grant();
    await both(true);
    // Never more than that one row of someone else's: another person's account and no context user stay hidden.
    expect(await dbSees(agent, account.other)).toBe(0);
    expect(await dbSees(null, account.owner)).toBe(0);
    expect(await dbSees(otherAgent, account.owner)).toBe(0);
    expect(await dbSees(agent, account.agent)).toBe(1); // its own account is still its own
    expect(await authz(agent, "bearer", account.other)).toBeNull();
    // The grant is read-only: the agent cannot write the owner's account.
    const wrote = await app.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${agent}, true)`;
      return await tx`UPDATE billing_accounts SET balance_credits = 0 WHERE id = ${account.owner} RETURNING id`;
    });
    expect(wrote).toHaveLength(0);
    expect(Number((await service`SELECT balance_credits FROM billing_accounts WHERE id = ${account.owner}`)[0]?.balance_credits)).toBe(1234);

    // Revoked by the service role: both deny.
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = ${SCOPE} AND revoked_at IS NULL`;
    await both(false);

    // Expired (database clock), not revoked: both deny.
    await grant();
    await both(true);
    await service`UPDATE agent_roles SET expires_at = now() - interval '1 second' WHERE principal_user_id = ${agent} AND scope = ${SCOPE} AND revoked_at IS NULL`;
    await both(false);
    as(agent, "bearer");
    expect((await myAccess()).requests[0]).toMatchObject({ scope: SCOPE, state: "revoked" }); // an ended grant reads as ended

    // The expired row no longer blocks a new ask: a fresh Off row, the old one ended, then On again.
    as(agent, "bearer");
    expect((await ask()).status).toBe(201);
    as(owner, "session");
    expect((await turn(minePost, { principalUserId: agent, scope: SCOPE })).status).toBe(200);
    await both(true);

    // The agent no longer belongs to that owner: both deny, though the row is untouched.
    await service`UPDATE agent_principals SET owner_user_id = ${other} WHERE user_id = ${agent}`;
    await both(false);
    await service`UPDATE agent_principals SET owner_user_id = ${owner} WHERE user_id = ${agent}`;
    await both(true);

    // Leave the agent Off for the tests below.
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = ${SCOPE} AND revoked_at IS NULL`;
    await both(false);
  });

  it("an unowned agent cannot ask (needs_owner) and holds nothing; another person's AI is that person's to decide", async () => {
    as(unowned, "bearer");
    const res = await ask();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "needs_owner" });
    expect(await rowOf(unowned)).toBeUndefined();
    expect((await readCredits(account.owner)).status).toBe(404);

    as(otherAgent, "bearer");
    expect((await ask()).status).toBe(201);
    // Olive sees none of Pat's AI, and cannot turn it On or dismiss its ask.
    as(owner, "session");
    expect((await mine()).permissions.map((p) => p.principalUserId)).not.toContain(otherAgent);
    expect((await turn(minePost, { principalUserId: otherAgent, scope: SCOPE })).status).toBe(404);
    expect((await turn(mineDelete, { principalUserId: otherAgent, scope: SCOPE, deny: true })).status).toBe(404);
    expect(await rowOf(otherAgent)).toMatchObject({ approved_by: null, revoked_at: null });
    // Pat can dismiss it; the agent then sees `denied`.
    as(other, "session");
    expect((await mine()).permissions.map((p) => p.principalUserId)).toEqual([otherAgent]);
    expect((await turn(mineDelete, { principalUserId: otherAgent, scope: SCOPE, deny: true })).status).toBe(200);
    as(otherAgent, "bearer");
    expect((await myAccess()).requests[0]).toMatchObject({ scope: SCOPE, state: "denied" });
  });

  it("the planes hold: a bearer on the owner route is 403 human_session_required, signed out is 401, a bad body is 400, a node scope is 400", async () => {
    const headers = { authorization: "Bearer cogni_ag_sk_v1_x" };
    for (const handler of [mineGet as typeof minePost, minePost, mineDelete]) {
      as(owner, "session");
      const res = await turn(handler, { principalUserId: agent, scope: SCOPE }, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "human_session_required" });
    }
    as(null, "session");
    expect((await mineGet(req("http://localhost/api/v1/agent-access/mine"), undefined as never)).status).toBe(401);
    as(owner, "session");
    expect((await turn(minePost, { nope: true })).status).toBe(400);
    expect((await turn(minePost, { principalUserId: agent, scope: "work_item:transition" })).status).toBe(400);
    expect((await turn(minePost, { principalUserId: agent, scope: SCOPE })).status).toBe(409); // never asked: not pending
  });

  it("node and personal never mix: the admin sees no personal row, the admin path refuses the scope, and a node row never opens an account", async () => {
    as(agent, "bearer");
    expect((await ask()).status).toBe(201);
    const admin = await authority.listNodeAi();
    expect(admin.permissions.filter((p) => p.principalUserId === agent)).toEqual([]);
    await expect(authority.grantRole({ principalUserId: agent, scope: SCOPE, approvedBy: owner })).rejects.toMatchObject({ code: "personal_scope" });
    await expect(authority.grantRole({ principalSlug: "node-ai", scope: SCOPE, approvedBy: owner })).rejects.toMatchObject({ code: "personal_scope" });
    expect((await rowOf(agent))?.approved_by).toBeNull();
    // A NODE row for the same scope (written by the service role, as an admin grant would be) opens no account.
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = ${SCOPE} AND revoked_at IS NULL`;
    await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${agent}, ${SCOPE}, ${other})`;
    expect(await dbSees(agent, account.owner)).toBe(0);
    expect(await authz(agent, "bearer", account.owner)).toBeNull();
    as(agent, "bearer");
    expect((await readCredits(account.owner)).status).toBe(404);
    await service`UPDATE agent_roles SET revoked_at = now() WHERE principal_user_id = ${agent} AND scope = ${SCOPE} AND revoked_at IS NULL`;
  });

  it("the database refuses a personal row the code would never write (CHECK constraints), and a node row keeps its old shape", async () => {
    const insert = (cols: { kind: string; owner: string | null; approvedBy: string | null; expires: boolean; principal?: string }) =>
      service`INSERT INTO agent_roles (principal_user_id, scope, approved_by, resource_kind, owner_user_id, expires_at)
        VALUES (${cols.principal ?? otherAgent}, ${`check:${randomUUID()}`}, ${cols.approvedBy}, ${cols.kind}, ${cols.owner},
          ${cols.expires ? service`now() + interval '1 day'` : null})`;
    // The agent approving its own row, a stranger approving it, and an approved row that never ends.
    await expect(insert({ kind: "account", owner: other, approvedBy: otherAgent, expires: true })).rejects.toThrow(/agent_roles_personal_approver/);
    await expect(insert({ kind: "account", owner: other, approvedBy: owner, expires: true })).rejects.toThrow(/agent_roles_personal_approver/);
    await expect(insert({ kind: "account", owner: other, approvedBy: other, expires: false })).rejects.toThrow(/agent_roles_personal_approver/);
    // A personal row needs an owner, a node row has none, and the kind is a known one.
    await expect(insert({ kind: "account", owner: null, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_owner_shape/);
    await expect(insert({ kind: "node", owner: other, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_owner_shape/);
    await expect(insert({ kind: "galaxy", owner: other, approvedBy: null, expires: false })).rejects.toThrow(/agent_roles_resource_kind_canonical/);
    // The owner approving their own agent's row, with an end, is the one valid personal approval. A node row with no kind named defaults to `node`.
    await expect(insert({ kind: "account", owner: other, approvedBy: other, expires: true })).resolves.toBeDefined();
    const node = (await service`INSERT INTO agent_roles (principal_user_id, scope, approved_by) VALUES (${otherAgent}, ${`node:${randomUUID()}`}, ${owner}) RETURNING resource_kind, owner_user_id, expires_at`)[0];
    expect(node).toEqual({ resource_kind: "node", owner_user_id: null, expires_at: null });
  });
});
