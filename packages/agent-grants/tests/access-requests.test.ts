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
  offeredToolIds,
  requestAccess,
  revokeRole,
  type ToolRequires,
} from "../src";
import { memoryStore } from "./memory-store";

const declaredScopes = ["work_item:transition", "knowledge:contribute", "edo:write"];
const requires: ToolRequires = { scope: "work_item:transition", kind: "node", subject: "member" };
const store = () => memoryStore({ principals: { "node-ai": "internal-1" } });

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
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes });
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(true);
    await revokeRole(s, { principalUserId: "agent", scope: "work_item:transition" });
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(false);
  });
});

describe("requestAccess (the agent asks for itself)", () => {
  it("writes one pending row for the caller, is idempotent, and reports a live row as granted", async () => {
    const s = store();
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes })).toEqual({ state: "pending", created: true });
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes })).toEqual({ state: "pending", created: false });
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0]).toMatchObject({ principal: "agent", approvedBy: null });
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes });
    expect(await requestAccess(s, { principalUserId: "agent", scope: "work_item:transition", declaredScopes })).toEqual({ state: "granted", created: false });
  });
  it("rejects an undeclared scope before any write, and caps open asks", async () => {
    const s = store();
    await expect(requestAccess(s, { principalUserId: "agent", scope: "made:up", declaredScopes })).rejects.toMatchObject({ code: "invalid_scope" });
    expect(s.roles).toHaveLength(0);
    const many = Array.from({ length: MAX_PENDING_PER_AGENT }, (_, i) => `s${i}`);
    for (const scope of many) await requestAccess(s, { principalUserId: "agent", scope, declaredScopes: many });
    await expect(requestAccess(s, { principalUserId: "agent", scope: "s-extra", declaredScopes: [...many, "s-extra"] })).rejects.toMatchObject({ code: "too_many_requests" });
    // another agent is not affected
    expect((await requestAccess(s, { principalUserId: "other", scope: "s0", declaredScopes: many })).created).toBe(true);
  });
  it("lists the caller's own rows by state: pending, granted, denied, revoked", async () => {
    const s = store();
    for (const scope of declaredScopes) await requestAccess(s, { principalUserId: "agent", scope, declaredScopes });
    await grantRole(s, { principalUserId: "agent", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes });
    await grantRole(s, { principalUserId: "agent", scope: "edo:write", approvedBy: "admin-1", declaredScopes });
    await revokeRole(s, { principalUserId: "agent", scope: "edo:write" });
    await denyRequest(s, { principalUserId: "agent", scope: "knowledge:contribute" });
    const own = Object.fromEntries((await listOwnAccess(s, "agent")).map((r) => [r.scope, r.state]));
    expect(own).toEqual({ "work_item:transition": "granted", "edo:write": "revoked", "knowledge:contribute": "denied" });
    await requestAccess(s, { principalUserId: "agent", scope: "knowledge:contribute", declaredScopes }); // a denied ask can be asked again
    expect((await listOwnAccess(s, "agent")).find((r) => r.scope === "knowledge:contribute")?.state).toBe("pending");
    expect(await listOwnAccess(s, "someone-else")).toEqual([]);
  });
});

describe("the admin's yes, no and take-back", () => {
  it("approve needs a pending ask for an outside agent: no ask, no grant", async () => {
    const s = store();
    await expect(grantRole(s, { principalUserId: "ext", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes })).rejects.toMatchObject({ code: "not_pending" });
    expect(s.roles).toHaveLength(0);
  });
  it("an internal AI with no ask is still granted directly, by slug or by user id (existing semantics)", async () => {
    const s = store();
    expect(await grantRole(s, { principalSlug: "node-ai", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes })).toEqual({ principalUserId: "internal-1", created: true });
    expect((await grantRole(s, { principalUserId: "internal-1", scope: "work_item:transition", approvedBy: "admin-1", declaredScopes })).created).toBe(false);
  });
  it("NO_SELF_APPROVAL: an approver cannot approve a row for itself", async () => {
    const s = memoryStore({ roles: [{ principal: "agent", scope: "work_item:transition", pending: true }] });
    await expect(grantRole(s, { principalUserId: "agent", scope: "work_item:transition", approvedBy: "agent", declaredScopes })).rejects.toBeInstanceOf(AgentRolesError);
    expect(await s.hasLiveRole("agent", "work_item:transition")).toBe(false);
  });
  it("revoke touches a live row only; deny touches a pending row only", async () => {
    const s = memoryStore({ roles: [{ principal: "a", scope: "work_item:transition", pending: true }, { principal: "b", scope: "work_item:transition" }] });
    expect((await revokeRole(s, { principalUserId: "a", scope: "work_item:transition" })).revoked).toBe(false);
    expect((await denyRequest(s, { principalUserId: "b", scope: "work_item:transition" })).denied).toBe(false);
    expect((await denyRequest(s, { principalUserId: "a", scope: "work_item:transition" })).denied).toBe(true);
    expect((await revokeRole(s, { principalUserId: "b", scope: "work_item:transition" })).revoked).toBe(true);
  });
});
