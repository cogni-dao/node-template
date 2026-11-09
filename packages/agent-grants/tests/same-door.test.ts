// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  type AdminCheck,
  authorizeCaller,
  authorizePrincipalLock,
  guardTools,
  offeredToolIds,
  ROUTE_ONLY_CAPABILITIES,
  type TerminalDenial,
  type ToolRequires,
} from "../src";
import { memoryStore } from "./memory-store";

const node = (subject: "member" | "admin" = "member"): ToolRequires => ({ scope: "work_item:transition", kind: "node", subject });
const own: ToolRequires = { scope: "schedule:manage", kind: "own", subject: "member" };
const allowAdmin: AdminCheck = async () => "allow";
const denyAdmin: AdminCheck = async () => "denied";

describe("authorizePrincipalLock", () => {
  it("opens on a live role and ignores subject and kind-own subject rules", async () => {
    const store = memoryStore({ roles: [{ principal: "p", scope: "schedule:manage" }] });
    expect(await authorizePrincipalLock(store, { principalId: "p", requires: own })).toEqual({ decision: "allow", basis: "role" });
  });
  it("denies with no principal, no role, an account scope, an unknown kind, and reports an outage", async () => {
    const store = memoryStore();
    expect(await authorizePrincipalLock(store, { requires: node() })).toMatchObject({ reason: "no_principal" });
    expect(await authorizePrincipalLock(store, { principalId: "p", requires: node() })).toMatchObject({ reason: "no_role" });
    expect(await authorizePrincipalLock(store, { principalId: "p", requires: { ...node(), kind: "account" } })).toMatchObject({ reason: "account_scope_unsupported" });
    expect(await authorizePrincipalLock(store, { principalId: "p", requires: { ...node(), kind: "weird" as never } })).toMatchObject({ reason: "unknown_contract_value" });
    expect(await authorizePrincipalLock(memoryStore({ failing: true }), { principalId: "p", requires: node() })).toMatchObject({ code: "authz_unavailable" });
  });
});

describe("authorizeCaller (the route door)", () => {
  const withRole = () => memoryStore({ roles: [{ principal: "agent", scope: "work_item:transition" }] });
  it("a bearer without a role row is policy_denied; with one it is allowed; revoked it is denied again", async () => {
    expect(await authorizeCaller(memoryStore(), denyAdmin, { userId: "agent", via: "bearer", requires: node() })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
    const store = withRole();
    expect(await authorizeCaller(store, denyAdmin, { userId: "agent", via: "bearer", requires: node() })).toMatchObject({ decision: "allow" });
    store.roles[0]!.revoked = true;
    expect(await authorizeCaller(store, denyAdmin, { userId: "agent", via: "bearer", requires: node() })).toMatchObject({ decision: "deny" });
  });
  it("a store outage on a bearer is authz_unavailable", async () => {
    expect(await authorizeCaller(memoryStore({ failing: true }), denyAdmin, { userId: "agent", via: "bearer", requires: node() })).toMatchObject({ code: "authz_unavailable" });
  });
  it("a bearer passes an admin-subject scope on the role row alone (an AI admin check arrives with item I2)", async () => {
    expect(await authorizeCaller(withRole(), denyAdmin, { userId: "agent", via: "bearer", requires: node("admin") })).toMatchObject({ decision: "allow" });
  });
  it("a bearer is the subject for own-data scopes", async () => {
    const store = memoryStore({ roles: [{ principal: "agent", scope: "schedule:manage" }] });
    expect(await authorizeCaller(store, denyAdmin, { userId: "agent", via: "bearer", requires: own })).toMatchObject({ decision: "allow" });
  });
  it("a human session needs no role row: member passes, admin needs the admin check", async () => {
    const store = memoryStore();
    expect(await authorizeCaller(store, denyAdmin, { userId: "h", via: "session", requires: node() })).toMatchObject({ decision: "allow", basis: "signed_in" });
    expect(await authorizeCaller(store, denyAdmin, { userId: "h", via: "session", requires: node("admin") })).toMatchObject({ decision: "deny", reason: "subject_not_admin" });
    expect(await authorizeCaller(store, allowAdmin, { userId: "h", via: "session", requires: node("admin") })).toMatchObject({ decision: "allow" });
    expect(await authorizeCaller(store, async () => "unavailable", { userId: "h", via: "session", requires: node("admin") })).toMatchObject({ code: "authz_unavailable" });
  });
  it("knowledge.contribute: a human proposes unchanged, a bearer needs a role row", async () => {
    const requires = ROUTE_ONLY_CAPABILITIES["knowledge.contribute"]!.requires;
    expect(await authorizeCaller(memoryStore(), denyAdmin, { userId: "h", via: "session", requires })).toMatchObject({ decision: "allow" });
    expect(await authorizeCaller(memoryStore(), denyAdmin, { userId: "a", via: "bearer", requires })).toMatchObject({ decision: "deny", reason: "no_role" });
    expect(await authorizeCaller(memoryStore({ roles: [{ principal: "a", scope: "knowledge:contribute" }] }), denyAdmin, { userId: "a", via: "bearer", requires })).toMatchObject({ decision: "allow" });
  });
});

describe("DENIAL_IS_TERMINAL", () => {
  const tools = [
    { id: "read_tool", effect: "read_only" },
    { id: "write_tool", effect: "state_change" },
    { id: "undeclared", effect: "state_change" },
    { id: "mcp_tool", effect: "external_side_effect" },
  ];
  const requiresById = { write_tool: { scope: "knowledge:write", kind: "node", subject: "admin" } } as Record<string, ToolRequires>;
  const deps = (store: ReturnType<typeof memoryStore>, onDecision = vi.fn()) => ({ withStore: <T>(fn: (s: typeof store) => Promise<T>) => fn(store), onDecision });

  it("offers a read tool always and a write tool only when the principal lock opens", async () => {
    const granted = memoryStore({ roles: [{ principal: "p", scope: "knowledge:write" }] });
    expect((await offeredToolIds(tools, requiresById, { principalId: "p" }, deps(granted))).offered).toEqual(["read_tool", "write_tool"]);
    const none = await offeredToolIds(tools, requiresById, { principalId: "p" }, deps(memoryStore()));
    expect(none.offered).toEqual(["read_tool"]);
    expect(none.excluded.map((e) => [e.tool, e.reason])).toEqual([["write_tool", "no_role"], ["undeclared", "no_requires"], ["mcp_tool", "no_requires"]]);
  });
  it("offers no write tool to a run with no principal, and excludes on an outage", async () => {
    expect((await offeredToolIds(tools, requiresById, {}, deps(memoryStore()))).offered).toEqual(["read_tool"]);
    const down = await offeredToolIds(tools, requiresById, { principalId: "p" }, deps(memoryStore({ failing: true })));
    expect(down.offered).toEqual(["read_tool"]);
    expect(down.excluded[0]).toMatchObject({ tool: "write_tool", code: "authz_unavailable" });
  });
  it("logs one not_offered decision per excluded tool", async () => {
    const onDecision = vi.fn();
    await offeredToolIds(tools, requiresById, { principalId: "p", subjectUserId: "s", payer: "b" }, deps(memoryStore(), onDecision));
    expect(onDecision).toHaveBeenCalledTimes(3);
    expect(onDecision.mock.calls[0]![0]).toMatchObject({ principal: "p", subject: "s", payer: "b", tool: "write_tool", decision: "deny", reason: "not_offered:no_role" });
  });
  it("an exec-time denial calls onTerminalDenial once, before it throws", async () => {
    const seen: TerminalDenial[] = [];
    const store = memoryStore({ roles: [{ principal: "p", scope: "knowledge:write" }] });
    const g = guardTools(
      { write_tool: { id: "write_tool", effect: "state_change", exec: vi.fn(async () => "ok") } },
      requiresById,
      { principalId: "p", subjectUserId: "member" },
      { withStore: (fn) => fn(store), adminCheck: denyAdmin, onTerminalDenial: (d) => seen.push(d) }
    );
    await expect(g.write_tool!.exec(1 as never, undefined as never, undefined as never)).rejects.toThrow("Tool call denied by policy");
    expect(seen).toEqual([{ tool: "write_tool", code: "policy_denied", reason: "subject_not_admin" }]);
  });
  it("an allowed call never calls onTerminalDenial", async () => {
    const onTerminalDenial = vi.fn();
    const store = memoryStore({ roles: [{ principal: "p", scope: "knowledge:write" }] });
    const g = guardTools(
      { write_tool: { id: "write_tool", effect: "state_change", exec: vi.fn(async () => "ok") } },
      requiresById,
      { principalId: "p", subjectUserId: "admin" },
      { withStore: (fn) => fn(store), adminCheck: allowAdmin, onTerminalDenial }
    );
    await expect(g.write_tool!.exec(1 as never, undefined as never, undefined as never)).resolves.toBe("ok");
    expect(onTerminalDenial).not.toHaveBeenCalled();
  });
});
