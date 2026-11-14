// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  AgentRolesError,
  type AuthzEvent,
  grantRole,
  guardTools,
  offeredToolIds,
  resolveInternalPrincipal,
  revokeRole,
  ToolAuthorityError,
  type ToolRequires,
} from "../src";
import { memoryStore } from "./memory-store";

const ADMIN = { userId: "admin", admin: {} };

const requiresById: Record<string, ToolRequires> = {
  write_tool: { scope: "knowledge:write", kind: "node", subject: "admin" },
};
const runtimes = () => ({
  read_tool: { id: "read_tool", effect: "read_only", exec: vi.fn(async () => "read-ok") },
  write_tool: { id: "write_tool", effect: "state_change", exec: vi.fn(async () => "write-ok") },
  undeclared: { id: "undeclared", effect: "state_change", exec: vi.fn(async () => "never") },
});
const deps = (store: ReturnType<typeof memoryStore>, events: AuthzEvent[] = []) => ({
  withStore: <T>(fn: (s: typeof store) => Promise<T>) => fn(store),
  adminCheck: async (id: string) => (id === "admin" ? ("allow" as const) : ("denied" as const)),
  onDecision: (e: AuthzEvent) => events.push(e),
});

async function denial(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ToolAuthorityError);
  return (error as ToolAuthorityError).receipt;
}

describe("guardTools", () => {
  it("passes a read_only tool with no requires without a decision", async () => {
    const events: AuthzEvent[] = [];
    const g = guardTools(runtimes(), requiresById, {}, deps(memoryStore(), events));
    await expect(g.read_tool!.exec(undefined as never, undefined as never, undefined as never)).resolves.toBe("read-ok");
    expect(events).toEqual([]);
  });

  it("allows a scoped tool for a principal with a live role and an admin subject", async () => {
    const rt = runtimes();
    const events: AuthzEvent[] = [];
    const store = memoryStore({ roles: [{ principal: "node-ai-user", scope: "knowledge:write" }] });
    const g = guardTools(rt, requiresById, { principalId: "node-ai-user", subjectUserId: "admin", payer: "ba-1" }, deps(store, events));
    await expect(g.write_tool!.exec(1 as never, { runId: "r1" } as never, {} as never)).resolves.toBe("write-ok");
    expect(events).toEqual([{ principal: "node-ai-user", subject: "admin", payer: "ba-1", tool: "write_tool", decision: "allow", code: "allowed", reason: "role", runId: "r1", account: null }]);
  });

  it("denies a non-admin subject with receipt policy_denied", async () => {
    const store = memoryStore({ roles: [{ principal: "node-ai-user", scope: "knowledge:write" }] });
    const rt = runtimes();
    const g = guardTools(rt, requiresById, { principalId: "node-ai-user", subjectUserId: "member" }, deps(store));
    const receipt = await denial(g.write_tool!.exec(1 as never, undefined as never, undefined as never));
    expect(receipt).toEqual({ code: "policy_denied", retryable: false, lookup: { tool: "write_tool", scope: "knowledge:write" } });
    expect(rt.write_tool.exec).not.toHaveBeenCalled();
  });

  it("denies a scoped tool when the run has no principal, even for an admin", async () => {
    const store = memoryStore({ roles: [{ principal: "node-ai-user", scope: "knowledge:write" }] });
    const g = guardTools(runtimes(), requiresById, { subjectUserId: "admin" }, deps(store));
    expect((await denial(g.write_tool!.exec(1 as never, undefined as never, undefined as never))).code).toBe("policy_denied");
  });

  it("denies a non-read_only tool with no requires entry", async () => {
    const g = guardTools(runtimes(), requiresById, { principalId: "p" }, deps(memoryStore()));
    expect((await denial(g.undeclared!.exec(1 as never, undefined as never, undefined as never))).code).toBe("policy_denied");
  });

  it("reports an outage as authz_unavailable", async () => {
    const g = guardTools(runtimes(), requiresById, { principalId: "p", subjectUserId: "admin" }, deps(memoryStore({ failing: true })));
    expect((await denial(g.write_tool!.exec(1 as never, undefined as never, undefined as never))).code).toBe("authz_unavailable");
  });

  it("denies the next call after a role is revoked", async () => {
    const store = memoryStore({ roles: [{ principal: "p", scope: "knowledge:write" }], principals: { "node-ai": "p" } });
    const g = guardTools(runtimes(), requiresById, { principalId: "p", subjectUserId: "admin" }, deps(store));
    await expect(g.write_tool!.exec(1 as never, undefined as never, undefined as never)).resolves.toBe("write-ok");
    await revokeRole(store, { principalSlug: "node-ai", scope: "knowledge:write", me: ADMIN });
    expect((await denial(g.write_tool!.exec(1 as never, undefined as never, undefined as never))).code).toBe("policy_denied");
  });

  it("binds the run identity around every allowed call through runAs", async () => {
    const seen: unknown[] = [];
    const store = memoryStore({ roles: [{ principal: "p", scope: "knowledge:write" }] });
    const g = guardTools(runtimes(), requiresById, { principalId: "p", subjectUserId: "admin" }, {
      ...deps(store),
      runAs: async (identity, fn) => {
        seen.push(identity);
        return fn();
      },
    });
    await g.read_tool!.exec(1 as never, undefined as never, undefined as never);
    await g.write_tool!.exec(1 as never, undefined as never, undefined as never);
    expect(seen).toEqual([{ principalId: "p", subjectUserId: "admin", accountId: undefined }, { principalId: "p", subjectUserId: "admin", accountId: undefined }]);
  });

  it("never discloses the reason in the thrown message", async () => {
    const g = guardTools(runtimes(), requiresById, {}, deps(memoryStore()));
    const error = await g.write_tool!.exec(1 as never, undefined as never, undefined as never).catch((e: Error) => e);
    expect((error as Error).message).toBe("Tool call denied by policy");
  });
});

describe("roles", () => {
  const base = () => memoryStore({ principals: { "node-ai": "u-node-ai" } });
  it("grants once and is idempotent", async () => {
    const store = base();
    const input = { principalSlug: "node-ai", scope: "knowledge:write", me: ADMIN, declaredScopes: ["knowledge:write"] };
    expect(await grantRole(store, input)).toEqual({ principalUserId: "u-node-ai", created: true });
    expect((await grantRole(store, input)).created).toBe(false);
    expect(await store.hasLiveRole("u-node-ai", "knowledge:write")).toBe(true);
  });
  it("rejects an undeclared scope and an unknown principal before any write", async () => {
    const store = base();
    await expect(grantRole(store, { principalSlug: "node-ai", scope: "made:up", me: { userId: "a", admin: {} }, declaredScopes: ["knowledge:write"] })).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(grantRole(store, { principalSlug: "ghost", scope: "knowledge:write", me: { userId: "a", admin: {} }, declaredScopes: ["knowledge:write"] })).rejects.toBeInstanceOf(AgentRolesError);
    expect(store.roles).toHaveLength(0);
  });
  it("resolves a seeded principal and returns null for a missing seed row", async () => {
    expect(await resolveInternalPrincipal(base(), "node-ai")).toBe("u-node-ai");
    expect(await resolveInternalPrincipal(base(), "ghost")).toBeNull();
  });
  it("revoke reports false when no live role exists", async () => {
    expect((await revokeRole(base(), { principalSlug: "node-ai", scope: "knowledge:write", me: ADMIN })).revoked).toBe(false);
  });
});

describe("an account-kind READ tool (task.5465, R6 R13)", () => {
  const credits: ToolRequires = { scope: "account:read", kind: "account", subject: "member" };
  const rt = () => ({ credits_tool: { id: "credits_tool", effect: "read_only", exec: vi.fn(async () => "credits-ok") } });
  const withGrant = () =>
    memoryStore({ roles: [{ principal: "ai", scope: "account:read", resource: "account", accountId: "acct-1" }] });

  it("is offered and runs only when the principal holds a live row for exactly the run's account", async () => {
    const store = withGrant();
    const offer = (accountId: string | undefined) =>
      offeredToolIds([{ id: "credits_tool", effect: "read_only" }], { credits_tool: credits }, { principalId: "ai", subjectUserId: "u", accountId }, { withStore: (fn) => fn(store) });
    expect((await offer("acct-1")).offered).toEqual(["credits_tool"]);
    expect((await offer("acct-2")).offered).toEqual([]); // another account
    expect((await offer(undefined)).excluded[0]).toMatchObject({ reason: "no_account" }); // a run with no account
    const g = guardTools(rt(), { credits_tool: credits }, { principalId: "ai", subjectUserId: "u", accountId: "acct-1" }, deps(store));
    await expect(g.credits_tool!.exec(1 as never, undefined as never, undefined as never)).resolves.toBe("credits-ok");
  });

  it("after Off (revoke) the exec-time check denies, and the denial is terminal", async () => {
    const store = withGrant();
    const seen: string[] = [];
    const g = guardTools(rt(), { credits_tool: credits }, { principalId: "ai", subjectUserId: "u", accountId: "acct-1" }, {
      ...deps(store),
      onTerminalDenial: (d) => seen.push(d.reason),
    });
    store.roles[0]!.revoked = true;
    expect((await denial(g.credits_tool!.exec(1 as never, undefined as never, undefined as never))).code).toBe("policy_denied");
    expect(seen).toEqual(["no_role"]);
  });

  it("a node row for the same scope never opens it", async () => {
    const store = memoryStore({ roles: [{ principal: "ai", scope: "account:read" }] });
    const g = guardTools(rt(), { credits_tool: credits }, { principalId: "ai", subjectUserId: "u", accountId: "acct-1" }, deps(store));
    expect((await denial(g.credits_tool!.exec(1 as never, undefined as never, undefined as never))).code).toBe("policy_denied");
  });

  it("an outage at the run-start filter withholds the tool as authz_unavailable", async () => {
    const out = await offeredToolIds([{ id: "credits_tool", effect: "read_only" }], { credits_tool: credits }, { principalId: "ai", accountId: "acct-1" }, { withStore: (fn) => fn(memoryStore({ failing: true })) });
    expect(out.offered).toEqual([]);
    expect(out.excluded[0]).toMatchObject({ code: "authz_unavailable" });
  });
});
