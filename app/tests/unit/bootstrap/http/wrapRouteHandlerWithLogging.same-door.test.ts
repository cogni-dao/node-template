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
function fakeSql(state: { roles: Set<string>; services: Set<string>; down: boolean; queries: number }): AgentAuthoritySql {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.queries += 1;
    if (state.down) throw new Error("db down");
    const text = strings.join("?");
    if (text.includes("FROM agent_roles"))
      return state.roles.has(`${values[0]}|${values[1]}`) ? [{ ok: 1 }] : [];
    if (text.includes("FROM agent_principals") && text.includes("service_key IS NOT NULL")) return state.services.has(String(values[0])) ? [{ ok: 1 }] : [];
    return [];
  }) as unknown as AgentAuthoritySql;
  (tag as unknown as { begin: unknown }).begin = async (fn: (t: unknown) => Promise<unknown>) => fn(tag);
  return tag;
}

const handler = vi.fn(async () => NextResponse.json({ ran: true }));
const AGENT = "agent-user-1";
const state = { roles: new Set<string>(), services: new Set<string>(), down: false, queries: 0 };

function route(sameDoor: string, user: SessionUser | null) {
  return wrapRouteHandlerWithLogging(
    {
      routeId: "work.items.patch",
      sameDoor,
      auth: { mode: "required", getSessionUser: async () => user },
    },
    handler
  );
}
const call = (sameDoor: string, user: SessionUser | null) =>
  route(sameDoor, user)(new NextRequest("https://node.example/api/v1/x", { method: "PATCH" }));
const user = (via: SessionUser["via"], id = AGENT): SessionUser => ({
  id, walletAddress: null, displayName: null, avatarColor: null, ...(via ? { via } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  state.roles = new Set();
  state.services = new Set();
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
  it("a bearer with no role row gets 403 policy_denied and the handler never runs", async () => {
    const res = await call("core__work_item_update", user("bearer"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    expect(handler).not.toHaveBeenCalled();
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

  it("the knowledge.read door (story.0038): an existing agent and a human read with no role row; an enrolled service is 403, then 200 on its role row, then 403 when Off", async () => {
    // An existing agent key (no service_key) keeps reading exactly as before, and so does a signed-in human: no store read for the human.
    expect((await call("knowledge.read", user("bearer"))).status).toBe(200);
    expect((await call("knowledge.read", user("session", "human-1"))).status).toBe(200);
    // An enrolled service principal is gated by its approved knowledge:read row.
    state.services.add(AGENT);
    const refused = await call("knowledge.read", user("bearer"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
    state.roles.add(`${AGENT}|knowledge:read`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(200);
    state.roles.delete(`${AGENT}|knowledge:read`);
    expect((await call("knowledge.read", user("bearer"))).status).toBe(403);
    // The refusal is named on its own, with a fixed code and no secret; allowed reads of humans and existing agents are not logged one by one.
    const denied = log.warn.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.event === "agent.knowledge_read.denied");
    expect(denied).toHaveLength(2);
    expect(denied[0]).toEqual({ event: "agent.knowledge_read.denied", principal: AGENT, routeId: "work.items.patch", code: "policy_denied", reason: "no_role" });
    const authz = [...log.info.mock.calls].map(([f]) => f as Record<string, unknown>).filter((f) => f.event === "agent_tool.authz" && f.tool === "knowledge.read");
    expect(authz).toEqual([expect.objectContaining({ decision: "allow", reason: "role", principal: AGENT })]);
  });

  it("the knowledge.read door treats a store outage as 503, for an unknown principal kind as well", async () => {
    state.down = true;
    expect((await call("knowledge.read", user("bearer"))).status).toBe(503);
    expect((await call("knowledge.read", user("session", "human-1"))).status).toBe(200); // a human never reads the role store
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

  it("a route with no sameDoor option is untouched for a human and reads one row for a bearer", async () => {
    const plain = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "plain", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/x", { method: "PATCH" }));
    expect((await plain(user("session", "human-1"))).status).toBe(200);
    expect(state.queries).toBe(0);
    expect((await plain(user("bearer"))).status).toBe(200);
    expect(state.queries).toBe(1);
  });

  it("SERVICE_KEY_DENY_BY_DEFAULT: a service key is 403 on a route with no door (ai.chat), 200 on a knowledge.read door route while On, and an ordinary agent key still reaches ai.chat", async () => {
    const chat = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "ai.chat", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/ai/chat", { method: "POST" }));
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
    // An agent key without service_key and a human reach ai.chat as before.
    expect((await chat(user("bearer", "other-agent"))).status).toBe(200);
    expect((await chat(user("session", "human-1"))).status).toBe(200);
    const denied = log.warn.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.code === "service_key_route_denied");
    expect(denied[0]).toEqual({ event: "agent.knowledge_read.denied", principal: AGENT, routeId: "ai.chat", code: "service_key_route_denied", reason: "route_has_no_capability_door" });
  });

  it("the service-key gate is 503 on a store outage, never an allow", async () => {
    state.down = true;
    const res = await wrapRouteHandlerWithLogging(
      { routeId: "ai.chat", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
      handler
    )(new NextRequest("https://node.example/api/v1/ai/chat", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    // The outage is logged once, with the route, the code and the reason.
    const warned = log.warn.mock.calls.map(([f]) => f as Record<string, unknown>).filter((f) => f.event === "agent.knowledge_read.denied");
    expect(warned).toEqual([{ event: "agent.knowledge_read.denied", principal: AGENT, routeId: "ai.chat", code: "authz_unavailable", reason: "store_unavailable" }]);
  });

  it("fail closed like the door: an identity with no `via` is a bearer for the service-key gate", async () => {
    state.services.add(AGENT);
    const chat = (u: SessionUser) =>
      wrapRouteHandlerWithLogging(
        { routeId: "ai.chat", auth: { mode: "required", getSessionUser: async () => u } },
        handler
      )(new NextRequest("https://node.example/api/v1/ai/chat", { method: "POST" }));
    expect((await chat(user(undefined))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await chat(user(undefined, "other-agent"))).status).toBe(200);
  });

  it("log budget: a refused door call and a refused service-key call each log at most 3 lines (start, one decision, end)", async () => {
    const lines = () => log.info.mock.calls.length + log.warn.mock.calls.length + log.error.mock.calls.length + log.debug.mock.calls.length;
    state.services.add(AGENT);
    await call("knowledge.read", user("bearer"));
    expect(lines()).toBeLessThanOrEqual(3);
    vi.clearAllMocks();
    log.child.mockReturnValue(log);
    await wrapRouteHandlerWithLogging(
      { routeId: "ai.chat", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
      handler
    )(new NextRequest("https://node.example/api/v1/ai/chat", { method: "POST" }));
    expect(lines()).toBeLessThanOrEqual(3);
  });
});
