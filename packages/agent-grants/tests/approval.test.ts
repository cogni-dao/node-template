// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  APPROVAL_PAGE,
  approvalPath,
  buildAccountAiView,
  buildNodeAiView,
  canApprove,
  hashLinkToken,
  isLinkTokenShape,
  newLinkToken,
  resourceOfKind,
} from "../src";
import { memoryStore } from "./memory-store";

describe("link token", () => {
  it("is 43 base64url characters, never repeats, and hashes to 64 hex characters", async () => {
    const a = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkToken()).not.toBe(a);
    expect(await hashLinkToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashLinkToken(a)).toBe(await hashLinkToken(a));
    expect(isLinkTokenShape(a)).toBe(true);
    expect(isLinkTokenShape("short")).toBe(false);
    expect(isLinkTokenShape(undefined)).toBe(false);
  });
});

describe("approval page by declared kind", () => {
  it("account opens the profile; node and own open the admin page", () => {
    expect(approvalPath("account", "T")).toBe("/profile#agent-request=T");
    expect(approvalPath("node", "T")).toBe("/admin/ai-access#agent-request=T");
    expect(approvalPath("own", "T")).toBe("/admin/ai-access#agent-request=T");
    expect(resourceOfKind("account")).toBe("account");
    expect(resourceOfKind("own")).toBe("node");
    expect(APPROVAL_PAGE).toEqual({ node: "/admin/ai-access", account: "/profile" });
  });
});

describe("canApprove: the one gate", () => {
  const s = memoryStore({ accounts: { alice: "acct-a", bob: "acct-b" } });
  it("a node row needs an admin session, whoever you are", async () => {
    expect(await canApprove(s, { userId: "alice", admin: null }, { resource: "node", principalUserId: "agent" })).toBe(false);
    expect(await canApprove(s, { userId: "alice", admin: {} }, { resource: "node", principalUserId: "agent" })).toBe(true);
  });
  it("an account row needs the owner of that account; an admin session adds nothing", async () => {
    const row = { resource: "account" as const, principalUserId: "agent", accountId: "acct-a" };
    expect(await canApprove(s, { userId: "alice", admin: null }, row)).toBe(true);
    expect(await canApprove(s, { userId: "bob", admin: {} }, row)).toBe(false);
    expect(await canApprove(s, { userId: "carol", admin: {} }, row)).toBe(false);
  });
  it("an account ask with no account yet needs an approver who owns an account", async () => {
    const row = { resource: "account" as const, principalUserId: "agent" };
    expect(await canApprove(s, { userId: "alice", admin: null }, row)).toBe(true);
    expect(await canApprove(s, { userId: "carol", admin: {} }, row)).toBe(false);
  });
  it("never the asking principal, for any row", async () => {
    expect(await canApprove(s, { userId: "alice", admin: {} }, { resource: "node", principalUserId: "alice" })).toBe(false);
    expect(await canApprove(s, { userId: "alice", admin: null }, { resource: "account", principalUserId: "alice", accountId: "acct-a" })).toBe(false);
  });
  it("a store failure throws; it is never a yes", async () => {
    await expect(canApprove(memoryStore({ failing: true }), { userId: "a", admin: null }, { resource: "account", principalUserId: "x", accountId: "y" })).rejects.toBeInstanceOf(Error);
  });
});

describe("the two tables never show each other's rows", () => {
  const declarations = {
    "account:read": { label: "Read your credits", description: "See the balance of your account." },
    "work_item:transition": { label: "Update work items", description: "Change work item status and priority." },
  };
  const row = (over: Record<string, unknown>) => ({
    principalUserId: "u",
    slug: null,
    internal: false,
    name: "agent",
    hint: null,
    scope: "account:read",
    state: "granted" as const,
    at: "",
    rowId: "r1",
    resource: "account" as const,
    accountId: "acct-a",
    expiresAt: "2026-11-20T00:00:00.000Z",
    ...over,
  });
  it("the profile table lists this node's AI Off until On, outside agents On with an end, and a pending ask opened by link", () => {
    const view = buildAccountAiView({
      declarations,
      scopesByPrincipal: { "node-ai": ["account:read"] },
      internal: [{ userId: "ai-1", slug: "node-ai" }],
      rows: [row({ principalUserId: "agent-1", name: "reader" })],
      ask: { principalUserId: "agent-2", slug: null, internal: false, name: "asker", hint: null, scope: "account:read", resource: "account", at: "" },
    });
    expect(view.map((v) => [v.section, v.who, v.on, v.resource, v.viaLink ?? false])).toEqual([
      ["pending", "asker", false, "account", true],
      ["node", "node-ai", false, "account", false],
      ["outside", "reader", true, "account", false],
    ]);
    expect(view.find((v) => v.section === "outside")?.until).toBe("2026-11-20T00:00:00.000Z");
    expect(view.find((v) => v.section === "node")?.rowId).toBeNull();
  });
  it("a live account row for this node's AI shows On with its row id and end", () => {
    const view = buildAccountAiView({
      declarations,
      scopesByPrincipal: { "node-ai": ["account:read"] },
      internal: [{ userId: "ai-1", slug: "node-ai" }],
      rows: [row({ principalUserId: "ai-1", internal: true, slug: "node-ai", name: "node-ai" })],
      ask: null,
    });
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ on: true, rowId: "r1", until: "2026-11-20T00:00:00.000Z" });
  });
  it("the profile builder ignores node rows, and the admin builder carries no account rows from the store", () => {
    const nodeRow = row({ resource: "node", accountId: null, expiresAt: null, scope: "work_item:transition", rowId: "n1" });
    expect(buildAccountAiView({ declarations, scopesByPrincipal: {}, internal: [], rows: [nodeRow], ask: null })).toEqual([]);
    const admin = buildNodeAiView({ declarations, scopesByPrincipal: {}, internal: [], rows: [nodeRow] });
    expect(admin.every((v) => v.resource === "node")).toBe(true);
  });
});
