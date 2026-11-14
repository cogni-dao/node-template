// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { authorize, type AdminCheck, type ToolRequires } from "../src";
import { memoryStore } from "./memory-store";

const node = (subject: "member" | "admin" = "member"): ToolRequires => ({ scope: "work_item:transition", kind: "node", subject });
const allowAdmin: AdminCheck = async () => "allow";

describe("authorize: node scope", () => {
  it("allows a live role", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", requires: node() })).toEqual({ decision: "allow", basis: "role" });
  });
  it("denies with no role row", async () => {
    expect(await authorize(memoryStore(), allowAdmin, { principalId: "p1", requires: node() })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_role" });
  });
  it("denies a revoked role", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition", revoked: true }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", requires: node() })).toMatchObject({ decision: "deny", code: "policy_denied" });
  });
  it("denies a role for a different scope", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "knowledge:write" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", requires: node() })).toMatchObject({ decision: "deny", reason: "no_role" });
  });
  it("denies a role held by another principal", async () => {
    const store = memoryStore({ roles: [{ principal: "p2", scope: "work_item:transition" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", requires: node() })).toMatchObject({ decision: "deny" });
  });
  it("denies when there is no principal", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition" }] });
    expect(await authorize(store, allowAdmin, { requires: node() })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_principal" });
  });
  it("reports an outage as authz_unavailable, never allow", async () => {
    expect(await authorize(memoryStore({ failing: true }), allowAdmin, { principalId: "p1", requires: node() })).toMatchObject({ decision: "deny", code: "authz_unavailable" });
  });
});

describe("authorize: subject lock only narrows", () => {
  const store = () => memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition" }] });
  it("a member subject does not add or remove access", async () => {
    expect(await authorize(store(), async () => "denied", { principalId: "p1", subjectUserId: "u1", requires: node("member") })).toMatchObject({ decision: "allow" });
  });
  it("an admin tool denies a non-admin subject", async () => {
    expect(await authorize(store(), async () => "denied", { principalId: "p1", subjectUserId: "u1", requires: node("admin") })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "subject_not_admin" });
  });
  it("an admin tool allows an admin subject", async () => {
    expect(await authorize(store(), allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: node("admin") })).toMatchObject({ decision: "allow" });
  });
  it("no configured admins is authz_unavailable", async () => {
    expect(await authorize(store(), async () => "unavailable", { principalId: "p1", subjectUserId: "u1", requires: node("admin") })).toMatchObject({ decision: "deny", code: "authz_unavailable" });
  });
  it("an admin-check throw is authz_unavailable", async () => {
    expect(await authorize(store(), async () => { throw new Error("x"); }, { principalId: "p1", subjectUserId: "u1", requires: node("admin") })).toMatchObject({ decision: "deny", code: "authz_unavailable" });
  });
  it("a subject cannot rescue a missing role", async () => {
    expect(await authorize(memoryStore(), allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: node("admin") })).toMatchObject({ decision: "deny", reason: "no_role" });
  });
});

describe("authorize: own scope", () => {
  const own: ToolRequires = { scope: "schedule:manage", kind: "own", subject: "member" };
  const store = () => memoryStore({ roles: [{ principal: "p1", scope: "schedule:manage" }] });
  it("denies with no subject", async () => {
    expect(await authorize(store(), allowAdmin, { principalId: "p1", requires: own })).toMatchObject({ decision: "deny", reason: "no_subject" });
  });
  it("allows with a role and a subject", async () => {
    expect(await authorize(store(), allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: own })).toMatchObject({ decision: "allow" });
  });
});

describe("authorize: account scope needs the run's account", () => {
  const account: ToolRequires = { scope: "account:read", kind: "account", subject: "member" };
  const day = 86_400_000;
  it("denies an account tool with no account, even with a live node row and a subject", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "account:read" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: account })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "no_account" });
  });
  it("a NODE row for the same scope never opens an account tool, even with an account", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "account:read" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", subjectUserId: "u1", accountId: "acct-1", requires: account })).toMatchObject({ decision: "deny", reason: "no_role" });
  });
  it("allows only a live account row for exactly this account; another account, an ended row and a revoked row deny", async () => {
    const live = memoryStore({ roles: [{ principal: "p1", scope: "account:read", resource: "account", accountId: "acct-1", expiresInMs: day }] });
    expect(await authorize(live, allowAdmin, { principalId: "p1", subjectUserId: "u1", accountId: "acct-1", requires: account })).toEqual({ decision: "allow", basis: "role" });
    expect(await authorize(live, allowAdmin, { principalId: "p1", subjectUserId: "u1", accountId: "acct-2", requires: account })).toMatchObject({ decision: "deny", reason: "no_role" });
    live.clock.now += 2 * day; // the row ended
    expect(await authorize(live, allowAdmin, { principalId: "p1", subjectUserId: "u1", accountId: "acct-1", requires: account })).toMatchObject({ decision: "deny", reason: "no_role" });
    const revoked = memoryStore({ roles: [{ principal: "p1", scope: "account:read", resource: "account", accountId: "acct-1", revoked: true }] });
    expect(await authorize(revoked, allowAdmin, { principalId: "p1", subjectUserId: "u1", accountId: "acct-1", requires: account })).toMatchObject({ decision: "deny" });
  });
  it("an account row never opens a node tool", async () => {
    const store = memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition", resource: "account", accountId: "acct-1" }] });
    expect(await authorize(store, allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: node() })).toMatchObject({ decision: "deny", reason: "no_role" });
  });
});

describe("authorize: every caller is a subject, agents included", () => {
  const store = () => memoryStore({ roles: [{ principal: "p1", scope: "knowledge:write" }, { principal: "p1", scope: "work_item:transition" }] });
  // An agent user has no bound wallet, so the node's admin check denies it.
  const agentAdminCheck: AdminCheck = async () => "denied";
  it("an agent subject fails an admin tool even when the principal holds the role", async () => {
    expect(await authorize(store(), agentAdminCheck, { principalId: "p1", subjectUserId: "agent-1", requires: { scope: "knowledge:write", kind: "node", subject: "admin" } })).toMatchObject({ decision: "deny", reason: "subject_not_admin" });
  });
  it("an agent subject passes a member tool", async () => {
    expect(await authorize(store(), agentAdminCheck, { principalId: "p1", subjectUserId: "agent-1", requires: node("member") })).toMatchObject({ decision: "allow" });
  });
});

describe("authorize: unknown contract values fail closed", () => {
  const store = () => memoryStore({ roles: [{ principal: "p1", scope: "work_item:transition" }] });
  const bad = (over: Partial<Record<"kind" | "subject", string>>) =>
    ({ scope: "work_item:transition", kind: "node", subject: "member", ...over }) as unknown as ToolRequires;
  it("denies an unknown kind even when the principal holds the role", async () => {
    expect(await authorize(store(), allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: bad({ kind: "team" }) })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "unknown_contract_value" });
  });
  it("denies an unknown subject even when the principal holds the role", async () => {
    expect(await authorize(store(), allowAdmin, { principalId: "p1", subjectUserId: "u1", requires: bad({ subject: "owner" }) })).toMatchObject({ decision: "deny", code: "policy_denied", reason: "unknown_contract_value" });
  });
  it("denies missing kind or subject, and never reads the store", async () => {
    const failing = memoryStore({ failing: true });
    expect(await authorize(failing, allowAdmin, { principalId: "p1", requires: { scope: "x" } as unknown as ToolRequires })).toMatchObject({ code: "policy_denied", reason: "unknown_contract_value" });
    expect(await authorize(failing, allowAdmin, { principalId: "p1", requires: bad({ kind: "" }) })).toMatchObject({ code: "policy_denied" });
  });
});
