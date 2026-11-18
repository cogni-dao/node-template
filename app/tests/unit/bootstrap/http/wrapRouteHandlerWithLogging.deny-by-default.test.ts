// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/http/wrapRouteHandlerWithLogging.deny-by-default`
 * Purpose: DENY_BY_DEFAULT (bug.0045) at the wrapper seam. Drives the REAL `wrapRouteHandlerWithLogging`: a bearer on a write route that declares no door,
 *   no `bearerWrite` and no open-by-design entry is 403 `bearer_write_undeclared` before the handler. Deleting the block fails these tests.
 * Scope: bearer, session and unauthenticated callers; write and read methods; each of the three declarations.
 * Invariants: DENY_BY_DEFAULT, a human session is never affected, 401 still answers first.
 * Side-effects: none
 */

import type { SessionUser } from "@cogni/node-shared";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ container: undefined as unknown }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => fake.container }));

import { wrapRouteHandlerWithLogging } from "@/bootstrap/http/wrapRouteHandlerWithLogging";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
log.child.mockReturnValue(log);
const authorizeRoute = vi.fn();
const handler = vi.fn(async () => NextResponse.json({ ran: true }));

const user = (via: "bearer" | "session"): SessionUser => ({ id: "u-1", walletAddress: null, displayName: null, avatarColor: null, via });
const call = (
  extra: { sameDoor?: string; bearerWrite?: string; routeId?: string },
  u: SessionUser | null,
  method = "POST"
) =>
  wrapRouteHandlerWithLogging(
    { routeId: extra.routeId ?? "some.write", ...extra, auth: { mode: "required", getSessionUser: async () => u } },
    handler
  )(new NextRequest("https://node.example/api/v1/x", { method }));

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  authorizeRoute.mockResolvedValue({ decision: "allow", basis: "role" });
  fake.container = {
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => new Date("2026-11-14T00:00:00Z").toISOString() },
    // A bearer on a route whose door does not run passes the service-key gate (it is not a service principal).
    agentAuthority: { authorizeRoute, denyServiceKeyOffDoor: vi.fn(async () => ({ decision: "allow" })) },
  };
});

describe("DENY_BY_DEFAULT (real wrapper)", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("a bearer %s on a route that declares nothing is 403 bearer_write_undeclared, no-store, and the handler never runs", async (method) => {
    const res = await call({}, user("bearer"), method);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bearer_write_undeclared", code: "bearer_write_undeclared" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("logs one agent_tool.authz deny with the route and the principal, and no secret", async () => {
    await call({ routeId: "attribution.finalize" }, user("bearer"));
    const lines = log.warn.mock.calls.map(([fields]) => fields as Record<string, unknown>).filter((f) => f.event === "agent_tool.authz");
    expect(lines).toEqual([
      expect.objectContaining({ route: "attribution.finalize", principal: "u-1", decision: "deny", code: "bearer_write_undeclared", reason: "no_declaration" }),
    ]);
  });

  it("a human session passes on the same route", async () => {
    expect((await call({}, user("session"))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fails closed: an identity with no `via` is treated as a bearer, so an undeclared write is 403 and a declared one passes", async () => {
    const noVia = { id: "u-1", walletAddress: null, displayName: null, avatarColor: null } as SessionUser;
    const res = await call({}, noVia);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bearer_write_undeclared", code: "bearer_write_undeclared" });
    expect(handler).not.toHaveBeenCalled();
    expect((await call({ bearerWrite: "the caller's own data" }, noVia)).status).toBe(200);
    expect((await call({}, noVia, "GET")).status).toBe(200);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("a bearer %s passes: only writes are denied by default", async (method) => {
    expect((await call({}, user("bearer"), method)).status).toBe(200);
  });

  it("an open-by-design route passes a bearer with no door (the ask door)", async () => {
    expect((await call({ routeId: "agent.access.requests.create" }, user("bearer"))).status).toBe(200);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("a bearerWrite reason passes a bearer with no role row and no store read", async () => {
    expect((await call({ bearerWrite: "the caller's own data" }, user("bearer"))).status).toBe(200);
    expect(authorizeRoute).not.toHaveBeenCalled();
  });

  it("a sameDoor route is decided by the door, not by this rule: allow passes, deny is policy_denied", async () => {
    expect((await call({ sameDoor: "core__work_item_update" }, user("bearer"))).status).toBe(200);
    authorizeRoute.mockResolvedValue({ decision: "deny", code: "policy_denied", reason: "no_role" });
    const res = await call({ sameDoor: "core__work_item_update" }, user("bearer"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "policy_denied", code: "policy_denied" });
  });

  it("an optional query door that is not running (no account named) does not satisfy a write: bearer 403; naming the account runs the door", async () => {
    const run = (query: string) =>
      wrapRouteHandlerWithLogging(
        { routeId: "some.write", sameDoor: "core__account_credits_read", sameDoorAccountQuery: "accountId", auth: { mode: "required", getSessionUser: async () => user("bearer") } },
        handler
      )(new NextRequest(`https://node.example/api/v1/x${query}`, { method: "POST" }));
    const refused = await run("");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "bearer_write_undeclared", code: "bearer_write_undeclared" });
    expect((await run("?accountId=acct-1")).status).toBe(200);
    expect(authorizeRoute).toHaveBeenCalledTimes(1);
  });

  it("401 still answers first when no identity resolves", async () => {
    const res = await call({}, null);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
