// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  AgentRolesError,
  authorize,
  authorizeCaller,
  denyRequest,
  grantRole,
  listOwnAccess,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_TOTAL,
  offeredToolIds,
  requestAccess,
  revokeRole,
  type ToolRequires,
} from "../src";
import { memoryStore } from "./memory-store";

const declaredScopes = ["work_item:transition", "knowledge:contribute", "edo:write", "vcs:merge_pr"];
// vcs:merge_pr is declared but has no route an outside agent can call.
const askableScopes = ["work_item:transition", "knowledge:contribute", "edo:write"];
const requires: ToolRequires = { scope: "work_item:transition", kind: "node", subject: "member" };
const store = () => memoryStore({ principals: { "node-ai": "internal-1" } });
const ADMIN = { userId: "admin-1", admin: {} };

describe("pending vs live: a pending ask opens no lock", () => {
  it("hasLiveRole, liveScopes, authorize, authorizeCaller and the run-start filter all ignore a pending row", async () => {
    const s = memoryStore({ roles: [{ principal: "agent", scope: "work_item:transition", pending: true }] });
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(false);
    expect(await s.liveScopes("agent", ["work_item:transition"])).toEqual([]);
    expect(await authorize(s, async () => "denied", { principalId: "agent", requires })).toMatchObject({ decision: "deny", reason: "no_role" });
    expect(await authorizeCaller(s, async () => "denied", { userId: "agent", via: "bearer", requires })).toMatchObject({ decision: "deny" });
    const { offered } = await offeredToolIds([{ id: "t", effect: "state_change" }], { t: requires }, { principalId: "agent" }, { withStore: (fn) => fn(s) });
    expect(offered).toEqual([]);
  });
  it("approval turns the same row on; a denied or revoked row stays off", async () => {
    const s = memoryStore({ roles: [{ principal: "agent", scope: "work_item:transition", pending: true }] });
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", me: ADMIN, declaredScopes });
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(true);
    await revokeRole(s, { principalUserId: "agent", scope: "work_item:transition", me: ADMIN });
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(false);
  });
});

describe("requestAccess (the agent asks for itself)", () => {
  it("writes one pending row for the caller, is idempotent, and reports a live row as granted", async () => {
    const s = store();
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes, askableScopes })).toMatchObject({ state: "pending", created: true, approvalPath: expect.stringMatching(/^\/admin\/ai-access#agent-request=[\w-]{43}$/) });
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes, askableScopes })).toMatchObject({ state: "pending", created: false });
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0]).toMatchObject({ principal: "agent", approvedBy: null });
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", me: ADMIN, declaredScopes });
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes, askableScopes })).toEqual({ state: "granted", created: false });
  });
  it("rejects an undeclared scope before any write, and caps open asks", async () => {
    const s = store();
    await expect(requestAccess(s, { principalUserId: "agent", scope: "made:up", declaredScopes, askableScopes })).rejects.toMatchObject({ code: "invalid_scope" });
    expect(s.roles).toHaveLength(0);
    const many = Array.from({ length: MAX_PENDING_PER_AGENT }, (_, i) => `s${i}`);
    for (const scope of many) await requestAccess(s, { principalUserId: "agent", scope, declaredScopes: many, askableScopes: many });
    await expect(requestAccess(s, { principalUserId: "agent", scope: "s-extra", declaredScopes: [...many, "s-extra"], askableScopes: [...many, "s-extra"] })).rejects.toMatchObject({ code: "too_many_requests" });
    // another agent is not affected
    expect((await requestAccess(s, { principalUserId: "other", scope: "s0", declaredScopes: many, askableScopes: many })).created).toBe(true);
  });
  it("lists the caller's own rows by state: pending, granted, denied, revoked", async () => {
    const s = store();
    for (const scope of askableScopes) await requestAccess(s, { principalUserId: "agent", scope, declaredScopes, askableScopes });
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", me: ADMIN, declaredScopes });
    await grantRole(s, { principalUserId: "agent", scope: "edo:write", me: ADMIN, declaredScopes });
    await revokeRole(s, { principalUserId: "agent", scope: "edo:write", me: ADMIN });
    await denyRequest(s, { principalUserId: "agent", scope: "knowledge:contribute", me: ADMIN });
    const own = Object.fromEntries((await listOwnAccess(s, "agent")).map((r) => [r.scope, r.state]));
    expect(own).toEqual({ "work_item:transition": "granted", "edo:write": "revoked", "knowledge:contribute": "denied" });
    await requestAccess(s, { principalUserId: "agent", scope: "knowledge:contribute", declaredScopes, askableScopes }); // a denied ask can be asked again
    expect((await listOwnAccess(s, "agent")).find((r) => r.scope === "knowledge:contribute")?.state).toBe("pending");
    expect(await listOwnAccess(s, "someone-else")).toEqual([]);
  });
});

describe("flood bounds and honest asks", () => {
  it("the per-agent cap is below the number of askable scopes, so it can fire through the real scope list", () => {
    expect(MAX_PENDING_PER_AGENT).toBeLessThanOrEqual(askableScopes.length);
    expect(MAX_PENDING_PER_AGENT).toBeGreaterThan(0);
  });
  it("a global cap across all agents refuses a new ask with too_many_requests, and an existing pending ask is still reported", async () => {
    const roles = Array.from({ length: MAX_PENDING_TOTAL }, (_, i) => ({ principal: `bot-${i}`, scope: "edo:write", pending: true }));
    const s = memoryStore({ roles });
    await expect(requestAccess(s, { principalUserId: "late-bot", scope: "edo:write", declaredScopes, askableScopes })).rejects.toMatchObject({ code: "too_many_requests" });
    expect(await requestAccess(s, { principalUserId: "bot-0", scope: "edo:write", declaredScopes, askableScopes })).toMatchObject({ state: "pending", created: false });
    // an admin clearing one makes room
    await denyRequest(s, { principalUserId: "bot-1", scope: "edo:write", me: ADMIN });
    expect((await requestAccess(s, { principalUserId: "late-bot", scope: "edo:write", declaredScopes, askableScopes })).created).toBe(true);
  });
  it("an ask for a declared scope with no external door is refused with no_external_door; an undeclared scope is invalid_scope", async () => {
    const s = store();
    await expect(requestAccess(s, { principalUserId: "agent", scope: "vcs:merge_pr", declaredScopes, askableScopes })).rejects.toMatchObject({ code: "no_external_door" });
    await expect(requestAccess(s, { principalUserId: "agent", scope: "made:up", declaredScopes, askableScopes })).rejects.toMatchObject({ code: "invalid_scope" });
    expect(s.roles).toHaveLength(0);
  });
  it("the admin read bounds outside rows (pending first), always returns this node's AI in full, and counts what it cut", async () => {
    const outside = Array.from({ length: 12 }, (_, i) => ({ principal: `ext-${i}`, scope: "edo:write", pending: i >= 8 }));
    const s = memoryStore({ principals: { "node-ai": "internal-1" }, roles: [{ principal: "internal-1", scope: "knowledge:write" }, ...outside] });
    const { rows, more } = await s.listRoleRows(5);
    expect(more).toBe(7);
    expect(rows.filter((r) => r.internal)).toHaveLength(1);
    const ext = rows.filter((r) => !r.internal);
    expect(ext).toHaveLength(5);
    expect(ext.slice(0, 4).every((r) => r.state === "pending")).toBe(true); // all four asks survive the cut
  });
});

describe("the admin's yes, no and take-back", () => {
  it("approve needs a pending ask for an outside agent: no ask, no grant", async () => {
    const s = store();
    await expect(grantRole(s, { principalUserId: "ext", scope: "work_item:transition", me: ADMIN, declaredScopes })).rejects.toMatchObject({ code: "not_pending" });
    expect(s.roles).toHaveLength(0);
  });
  it("an internal AI with no ask is still granted directly, by slug or by user id (existing semantics)", async () => {
    const s = store();
    expect(await grantRole(s, { principalSlug: "node-ai", scope: "work_item:transition", me: ADMIN, declaredScopes })).toEqual({ principalUserId: "internal-1", created: true });
    expect((await grantRole(s, { principalUserId: "internal-1", scope: "work_item:transition", me: ADMIN, declaredScopes })).created).toBe(false);
  });
  it("NO_SELF_APPROVAL: an approver cannot approve a row for itself", async () => {
    const s = memoryStore({ roles: [{ principal: "agent", scope: "work_item:transition", pending: true }] });
    await expect(grantRole(s, { principalUserId: "agent", scope: "work_item:transition", me: { userId: "agent", admin: {} }, declaredScopes })).rejects.toBeInstanceOf(AgentRolesError);
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(false);
  });
  it("revoke touches a live row only; deny touches a pending row only", async () => {
    const s = memoryStore({ roles: [{ principal: "a", scope: "work_item:transition", pending: true }, { principal: "b", scope: "work_item:transition" }] });
    expect((await revokeRole(s, { principalUserId: "a", scope: "work_item:transition", me: ADMIN })).revoked).toBe(false);
    expect((await denyRequest(s, { principalUserId: "b", scope: "work_item:transition", me: ADMIN })).denied).toBe(false);
    expect((await denyRequest(s, { principalUserId: "a", scope: "work_item:transition", me: ADMIN })).denied).toBe(true);
    expect((await revokeRole(s, { principalUserId: "b", scope: "work_item:transition", me: ADMIN })).revoked).toBe(true);
  });
});
