// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/http/wrapRouteHandlerWithLogging.same-door`
 * Purpose: SAME_DOOR at the wrapper seam. Drives the REAL `wrapRouteHandlerWithLogging` `sameDoor` block and the REAL
 *   `createAgentToolAuthority.authorizeRoute` (only the SQL tag and the logger are fakes). Deleting the block or
 *   `authorizeRoute` fails these tests.
 * Scope: bearer, session and unknown identity; role present, absent, store outage; the logged route id.
 * Invariants: SAME_DOOR, FAIL_CLOSED_NON_DISCLOSING, a bearer is its own principal and a human needs no role row.
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { SessionUser } from "@cogni/node-shared";
import type { SqlTag } from "@cogni/agent-grants";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentAuthoritySql,
  createAgentToolAuthority,
} from "@/bootstrap/agent-authority";

const fake = vi.hoisted(() => ({
  container: undefined as unknown,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => fake.container,
}));

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http/wrapRouteHandlerWithLogging";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
log.child.mockReturnValue(log);

/** A tagged template that answers the role queries from a set. `begin` hands back the same tag. */
function fakeSql(state: {
  roles: Set<string>;
  /** Principals made by a service enrollment (`agent_principals.service_key` set). */
  services?: Set<string>;
  down: boolean;
  queries: number;
  /** `principal|scope|account` rows that are live account grants. */
  grants?: Set<string>;
  /** `account|user` pairs: who owns which account. */
  owners?: Set<string>;
}): AgentAuthoritySql {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.queries += 1;
    if (state.down) throw new Error("db down");
    const text = strings.join("?");
    if (text.includes("INSERT INTO agent_roles")) return [{ id: "row-1" }]; // an ask's insert lands
    if (text.includes("FROM billing_accounts") && text.includes("owner_user_id"))
      return state.owners?.has(`${values[0]}|${values[1]}`) ? [{ ok: 1 }] : [];
    if (text.includes("FROM agent_roles") && text.includes("resource = 'account'"))
      return state.grants?.has(`${values[0]}|${values[1]}|${values[2]}`) ? [{ ok: 1 }] : [];
    if (text.includes("FROM agent_roles"))
      return state.roles.has(`${values[0]}|${values[1]}`) ? [{ ok: 1 }] : [];
    if (text.includes("FROM agent_principals") && text.includes("service_key IS NOT NULL")) return state.services?.has(String(values[0])) ? [{ ok: 1 }] : [];
    return [];
  }) as unknown as AgentAuthoritySql;
  (tag as unknown as { begin: unknown }).begin = async (fn: (t: unknown) => Promise<unknown>) => fn(tag);
  return tag;
}

const handler = vi.fn(async () => NextResponse.json({ ran: true }));
const AGENT = "agent-user-1";
const state = { roles: new Set<string>(), services: new Set<string>(), down: false, queries: 0, grants: new Set<string>(), owners: new Set<string>() };

function route(sameDoor: string, user: SessionUser | null, routeId = "work.items.patch") {
  return wrapRouteHandlerWithLogging(
    {
      routeId,
      sameDoor,
      auth: { mode: "required", getSessionUser: async () => user },
    },
    handler
  );
}
const call = (sameDoor: string, user: SessionUser | null, routeId?: string) =>
  route(sameDoor, user, routeId)(new NextRequest("https://node.example/api/v1/x", { method: "PATCH" }));
/** The route-door denial lines: one per denied call, carrying routeId and errorCode (task.0122). */
const denialLines = () =>
  log.warn.mock.calls
    .map(([fields]) => fields as Record<string, unknown>)
    .filter((f) => f.event === "agent.route_denied");
const user = (via: SessionUser["via"], id = AGENT): SessionUser => ({
  id, walletAddress: null, displayName: null, avatarColor: null, ...(via ? { via } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  state.roles = new Set();
  state.services = new Set();
  state.grants = new Set();
  state.owners = new Set();
  state.down = false;
  state.queries = 0;
  fake.container = {
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => new Date("2026-11-09T00:00:00Z").toISOString() },
    agentAuthority: createAgentToolAuthority({
      sql: fakeSql(state),
      nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) },
      log: log as never,
      toolBundle: CORE_TOOL_BUNDLE as never,
    }),
  };
});

describe("the route door (real wrapper, real authorizeRoute)", () => {
  it("uses the reserved transaction for both live-role and DAO-admin reads", async () => {
    const roles = new Set(["dao-admin", "not-admin"]);
    const reads: string[] = [];
    const tx: SqlTag = async (strings, ...values) => {
      const text = strings.join("?");
      if (text.includes("FROM agent_roles")) {
        reads.push("role");
        return roles.has(String(values[0])) ? [{ ok: 1 }] : [];
      }
      if (text.includes("FROM user_bindings")) { reads.push("admin"); return values[0] === "dao-admin" ? [{ external_id: "0xadmin" }] : []; }
      throw new Error("unexpected authority read");
    };
    const sql = Object.assign(async () => { throw new Error("root pool must not be reacquired"); }, {
      begin: async <T,>(fn: (connection: SqlTag) => Promise<T>) => fn(tx),
    });
    const authority = createAgentToolAuthority({ sql, toolBundle: [], log: log as never,
      nodeAdmin: { check: async ({ walletAddress }) => walletAddress === "0xadmin" ? { ok: true } : { ok: false, errorCode: "authz_denied" } },
    });
    const decide = (userId: string) => authority.authorizeRoute({ toolId: "service-link.manage", routeId: "service.links.create", userId, via: "bearer" });
    expect(await Promise.all([decide("dao-admin"), decide("not-admin")])).toEqual([
      { decision: "allow", basis: "role" }, { decision: "deny", code: "policy_denied", reason: "subject_not_admin" },
    ]);
    expect(reads.filter((r) => r === "admin")).toHaveLength(2);
    roles.delete("dao-admin");
    expect(await decide("dao-admin")).toMatchObject({ decision: "deny", reason: "no_role" });
    expect(reads.filter((r) => r === "admin")).toHaveLength(2);
  });

  it("a bearer with no role row gets 403 policy_denied and the handler never runs", async () => {
    const res = await call("core__work_item_update", user("bearer"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["work.items.patch", "core__work_item_update"],
    ["work.items.artifacts.create", "core__work_item_artifact_record"],
  ])("a grant-denied call to %s ends in one agent.route_denied line with routeId and errorCode policy_denied", async (routeId, tool) => {
    const res = await call(tool, user("bearer"), routeId);
    expect(res.status).toBe(403);
    expect(denialLines()).toEqual([
      { event: "agent.route_denied", routeId, outcome: "refused", errorCode: "policy_denied", tool, status: 403 },
    ]);
    expect(handler).not.toHaveBeenCalled();
    // The grant opens the door and the line is gone: an allowed call logs no denial.
    log.warn.mockClear();
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call(tool, user("bearer"), routeId)).status).toBe(200);
    expect(denialLines()).toEqual([]);
  });

  it("a grant store outage ends in one agent.route_denied line with errorCode authz_unavailable", async () => {
    state.down = true;
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(503);
    expect(denialLines()).toEqual([
      expect.objectContaining({ routeId: "work.items.patch", errorCode: "authz_unavailable", status: 503 }),
    ]);
  });

  it("a bearer with a live role row for the scope reaches the handler", async () => {
    state.roles.add(`${AGENT}|work_item:transition`);
    const res = await call("core__work_item_update", user("bearer"));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a role for one scope opens no other route", async () => {
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call("core__edo_decide", user("bearer"))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a store outage is 503 authz_unavailable, never an allow", async () => {
    state.down = true;
    const res = await call("core__work_item_update", user("bearer"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable", code: "authz_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a human session reaches the handler with no role row and no store read (subjects, not principals)", async () => {
    const res = await call("core__work_item_update", user("session", "human-1"));
    expect(res.status).toBe(200);
    expect(state.queries).toBe(0);
  });

  it("an identity with no `via` takes the strict bearer branch (fail closed)", async () => {
    const res = await call("core__work_item_update", user(undefined));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call("core__work_item_update", user(undefined))).status).toBe(200); // strict means "needs a role", not "denied"
  });

  it("a route that names an unknown capability is denied for a bearer, and so is a missing door dependency", async () => {
    expect((await call("core__no_such_tool", user("bearer"))).status).toBe(403);
    fake.container = { ...(fake.container as object), agentAuthority: undefined };
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(500); // never an allow
    expect(handler).not.toHaveBeenCalled();
  });

  it("the route-only knowledge.contribute scope: a human passes, a bearer needs the knowledge:contribute row", async () => {
    expect((await call("knowledge.contribute", user("session", "human-1"))).status).toBe(200);
    expect((await call("knowledge.contribute", user("bearer"))).status).toBe(403);
    state.roles.add(`${AGENT}|knowledge:contribute`);
    expect((await call("knowledge.contribute", user("bearer"))).status).toBe(200);
  });

  it("the route-only knowledge.read scope: a human reads, a bearer needs the knowledge:read row, and the ask for it is accepted", async () => {
    expect((await call("knowledge.read", user("session", "human-1"))).status).toBe(200);
    const denied = await call("knowledge.read", user("bearer"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    state.roles.add(`${AGENT}|knowledge:contribute`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(403); // another scope opens nothing here
    state.roles.add(`${AGENT}|knowledge:read`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(200);
    const authority = (fake.container as { agentAuthority: ReturnType<typeof createAgentToolAuthority> }).agentAuthority;
    expect(authority.declaredScopes).toContain("knowledge:read");
    await expect(authority.requestAccess({ principalUserId: "asker", scope: "knowledge:read" })).resolves.toMatchObject({ state: "pending" });
  });

  it("logs agent_tool.authz with the route id, the principal (bearer) or the subject (human), and no secret", async () => {
    await call("core__work_item_update", user("bearer"));
    await call("core__work_item_update", user("session", "human-1"));
    const lines = [...log.warn.mock.calls, ...log.info.mock.calls]
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((f) => f.event === "agent_tool.authz");
    expect(lines).toEqual([
      expect.objectContaining({ route: "work.items.patch", tool: "core__work_item_update", principal: AGENT, subject: null, decision: "deny", code: "policy_denied", reason: "no_role" }),
      expect.objectContaining({ route: "work.items.patch", principal: null, subject: "human-1", decision: "allow", reason: "signed_in" }),
    ]);
  });

  it("a read route with no sameDoor option is untouched for a human and reads one row for a bearer (writes are deny-by-default, see the deny-by-default test)", async () => {
    const plain = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "plain", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/x", { method: "GET" }));
    expect((await plain(user("session", "human-1"))).status).toBe(200);
    expect(state.queries).toBe(0);
    expect((await plain(user("bearer"))).status).toBe(200);
    expect(state.queries).toBe(1);
  });

  it("SERVICE_KEY_DENY_BY_DEFAULT: a service key is 403 on a route with no door (ai.agents.list), 200 on a knowledge.read door route while On, and an ordinary agent key still reaches ai.agents.list", async () => {
    const chat = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "ai.agents.list", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/ai/agents", { method: "GET" }));
    state.services.add(AGENT);
    const refused = await chat(user("bearer"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "service_key_route_denied", code: "service_key_route_denied" });
    expect(handler).not.toHaveBeenCalled();
    // A declared capability uses the same grant decision for a service and an ordinary outside agent.
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(403);
    state.roles.add(`${AGENT}|work_item:transition`);
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(200);
    state.services.delete(AGENT);
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(200);
    state.roles.delete(`${AGENT}|work_item:transition`);
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(403);
    state.services.add(AGENT);
    expect((await call("core__work_item_update", user("bearer"))).status).toBe(403);
    // The knowledge.read door route: 200 once its role row is On.
    state.roles.add(`${AGENT}|knowledge:read`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(200);
    // An agent key without service_key and a human reach ai.agents.list as before.
    expect((await chat(user("bearer", "other-agent"))).status).toBe(200);
    expect((await chat(user("session", "human-1"))).status).toBe(200);
    const denied = log.warn.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.code === "service_key_route_denied");
    expect(denied[0]).toEqual({ event: "agent.knowledge_read.denied", principal: AGENT, routeId: "ai.agents.list", code: "service_key_route_denied", reason: "route_has_no_capability_door" });
  });

  it("the service-key gate is 503 on a store outage, never an allow", async () => {
    state.down = true;
    const res = await wrapRouteHandlerWithLogging(
      { routeId: "ai.agents.list", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
      handler
    )(new NextRequest("https://node.example/api/v1/ai/agents", { method: "GET" }));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    // The outage is logged once as a store failure with its class (never a message), like every other store failure.
    const logged = log.error.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.event === "agent.roles.unavailable");
    expect(logged).toEqual([expect.objectContaining({ routeId: "ai.agents.list" })]);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });

  it("fail closed like the door: an identity with no `via` is a bearer for the service-key gate", async () => {
    state.services.add(AGENT);
    const chat = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "ai.agents.list", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/ai/agents", { method: "GET" }));
    expect((await chat(user(undefined))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await chat(user(undefined, "other-agent"))).status).toBe(200);
  });

  it("log budget: a refused door call logs at most 4 lines (start, decision, route_denied, end) and a refused service-key call at most 3 (start, one warn, end)", async () => {
    const lines = () => log.info.mock.calls.length + log.warn.mock.calls.length + log.error.mock.calls.length + log.debug.mock.calls.length;
    state.services.add(AGENT);
    await call("knowledge.read", user("bearer"));
    expect(lines()).toBeLessThanOrEqual(4);
    vi.clearAllMocks();
    log.child.mockReturnValue(log);
    await wrapRouteHandlerWithLogging(
      { routeId: "ai.agents.list", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
      handler
    )(new NextRequest("https://node.example/api/v1/ai/agents", { method: "GET" }));
    expect(lines()).toBeLessThanOrEqual(3);
  });
});


describe("the ACCOUNT door (real wrapper, real authorizeRoute): owner, delegated, or one 404", () => {
  const OWNER = "owner-1";
  const ACCOUNT = "acct-1";
  const accountRoute = (u: SessionUser | null, accountId = ACCOUNT) =>
    wrapRouteHandlerWithLogging(
      {
        routeId: "accounts.credits.read",
        sameDoor: "core__account_credits_read",
        sameDoorAccountParam: "accountId",
        auth: { mode: "required", getSessionUser: async () => u },
      },
      handler
    )(new NextRequest(`https://node.example/api/v1/accounts/${accountId}/credits`), { params: Promise.resolve({ accountId }) });

  it("the owner by session reaches the handler; a stranger by session gets the 404", async () => {
    state.owners.add(`${ACCOUNT}|${OWNER}`);
    expect((await accountRoute(user("session", OWNER))).status).toBe(200);
    handler.mockClear();
    const res = await accountRoute(user("session", "stranger"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a bearer agent needs a live grant for exactly this account: another account, no grant and a node-only role are the SAME 404", async () => {
    state.grants.add(`${AGENT}|account:read|${ACCOUNT}`);
    expect((await accountRoute(user("bearer"))).status).toBe(200);
    handler.mockClear();
    const foreign = await accountRoute(user("bearer"), "acct-2");
    const nothing = await accountRoute(user("bearer", "agent-2"));
    state.roles.add(`agent-3|account:read`);
    const nodeOnly = await accountRoute(user("bearer", "agent-3"));
    for (const res of [foreign, nothing, nodeOnly]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("a store outage is 503 authz_unavailable (not a 404, not an allow)", async () => {
    state.down = true;
    const res = await accountRoute(user("bearer"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable", code: "authz_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("logs the route and the account (an id, never data) for the decision", async () => {
    state.grants.add(`${AGENT}|account:read|${ACCOUNT}`);
    await accountRoute(user("bearer"));
    const authz = log.info.mock.calls.map((c) => c[0] as Record<string, unknown>).find((f) => f.route === "accounts.credits.read");
    expect(authz).toMatchObject({ tool: "core__account_credits_read", decision: "allow", code: "allowed", account: ACCOUNT, principal: AGENT });
  });
});

describe("the OPTIONAL query account door (payments.credits_summary?accountId=)", () => {
  const OWNER = "owner-1";
  const ACCOUNT = "acct-1";
  const queryRoute = (u: SessionUser | null, query: string) =>
    wrapRouteHandlerWithLogging(
      {
        routeId: "payments.credits_summary",
        sameDoor: "core__account_credits_read",
        sameDoorAccountQuery: "accountId",
        auth: { mode: "required", getSessionUser: async () => u },
      },
      handler
    )(new NextRequest(`https://node.example/api/v1/payments/credits/summary${query}`));

  it("with no accountId the route reads the caller's own account and no door runs: a human reads nothing, a bearer pays only the one service-key read", async () => {
    expect((await queryRoute(user("session", "human-1"), "?limit=5")).status).toBe(200);
    expect(state.queries).toBe(0);
    expect((await queryRoute(user("bearer"), "")).status).toBe(200);
    expect(state.queries).toBe(1);
  });

  it("with an accountId the account door runs: the owner passes by session; a stranger, an empty id and an agent with no grant get the one 404", async () => {
    state.owners.add(`${ACCOUNT}|${OWNER}`);
    expect((await queryRoute(user("session", OWNER), `?accountId=${ACCOUNT}`)).status).toBe(200);
    handler.mockClear();
    for (const [u, q] of [
      [user("session", "stranger"), `?accountId=${ACCOUNT}`],
      [user("session", OWNER), "?accountId="],
      [user("bearer"), `?accountId=${ACCOUNT}`],
    ] as const) {
      const res = await queryRoute(u, q);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("an agent holding a live account:read grant for exactly that account passes; another account does not", async () => {
    state.grants.add(`${AGENT}|account:read|${ACCOUNT}`);
    expect((await queryRoute(user("bearer"), `?accountId=${ACCOUNT}`)).status).toBe(200);
    expect((await queryRoute(user("bearer"), "?accountId=acct-2")).status).toBe(404);
  });
});
