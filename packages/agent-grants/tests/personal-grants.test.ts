// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` personal grants (task.5465, revision 5)
 * Purpose: An owner delegates `knowledge:read` and `knowledge:contribute` to an agent they own, on their profile. The ask is an Off row owned by the agent's owner and returns the
 *   path of its own approval page; only that owner turns it On (30 days). A bearer passes the lock on a live node row OR a live owner-approved personal row for a delegable scope, never for
 *   an admin-subject scope, a non-delegable scope or after Off, an end or a change of owner. Admin sees personal rows read-only apart from Revoke.
 * Scope: Pure logic over the in-memory store, which implements the same live predicate as the SQL.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  AgentRolesError,
  authorize,
  authorizeCaller,
  buildNodeAiView,
  buildYourAisView,
  decideAsOwner,
  DELEGABLE_SCOPES,
  grantPersonal,
  grantRole,
  listOwnAccess,
  MAX_PENDING_PER_OWNER,
  PERSONAL_GRANT_TTL_DAYS,
  personalKindFor,
  requestAccess,
  requestViewForAdmin,
  requestViewForOwner,
  revokePersonal,
  revokeRole,
  type ScopeDeclaration,
  type ToolRequires,
} from "../src";
import { memoryStore } from "./memory-store";

const CONTRIBUTE = "knowledge:contribute";
const READ = "knowledge:read";
const scopes: Record<string, ScopeDeclaration> = {
  [CONTRIBUTE]: { kind: "node", subject: "member" },
  [READ]: { kind: "node", subject: "member" },
  "work_item:transition": { kind: "node", subject: "member" },
  "vcs:merge_pr": { kind: "node", subject: "admin" },
};
const declaredScopes = Object.keys(scopes);
const askableScopes = declaredScopes;
const declarations = {
  [CONTRIBUTE]: { label: "Propose changes to the knowledge base", description: "Suggest new or changed notes." },
  [READ]: { label: "Read the knowledge base", description: "Read this node's notes." },
};
const member = (scope: string): ToolRequires => ({ scope, kind: "node", subject: "member" });

const OWNER = "owner-1";
const OTHER = "owner-2";
const AGENT = "agent-1";
const LOOSE = "ownerless";

const world = (extra?: Parameters<typeof memoryStore>[0]) =>
  memoryStore({
    owners: { [AGENT]: OWNER, "agent-2": OTHER },
    names: { [AGENT]: "Helper bot", [OWNER]: "Olive Owner", [OTHER]: "Pat Person" },
    principals: { "node-ai": "internal-1" },
    ...extra,
  });
type World = ReturnType<typeof world>;
const ask = (s: World, principalUserId = AGENT, scope = CONTRIBUTE) =>
  requestAccess(s, { principalUserId, scope, declaredScopes, askableScopes, scopes });
const on = (s: World, scope = CONTRIBUTE, ownerUserId = OWNER, principalUserId = AGENT) =>
  grantPersonal(s, { ownerUserId, principalUserId, scope, scopes });
const lock = (s: World, scope = CONTRIBUTE, who = AGENT) => authorize(s, async () => "denied", { principalId: who, requires: member(scope) });
const door = (s: World, requires: ToolRequires, who = AGENT) => authorizeCaller(s, async () => "denied", { userId: who, via: "bearer", requires });

describe("the delegable list", () => {
  it("is exactly knowledge:read and knowledge:contribute; only a declared member node scope on it is personal", () => {
    expect(DELEGABLE_SCOPES).toEqual([READ, CONTRIBUTE]);
    expect(personalKindFor(CONTRIBUTE, scopes[CONTRIBUTE])).toBe("delegated");
    expect(personalKindFor("work_item:transition", scopes["work_item:transition"])).toBeNull(); // a member scope, but not on the list
    expect(personalKindFor(CONTRIBUTE, { kind: "node", subject: "admin" })).toBeNull(); // declared admin: never personal
    expect(personalKindFor(CONTRIBUTE, { kind: "account", subject: "member" })).toBeNull();
    expect(personalKindFor(CONTRIBUTE, undefined)).toBeNull();
  });
});

describe("the ask returns its own approval page", () => {
  it("an owned agent asking a delegable scope gets a personal Off row and the owner's page for THAT request", async () => {
    const s = world();
    const res = await ask(s);
    expect(res).toEqual({ state: "pending", created: true, approvalPath: `/profile/ai/requests/${s.roles[0]?.id}` });
    expect(s.roles[0]).toMatchObject({ kind: "delegated", owner: OWNER, approvedBy: null });
    expect((await ask(s)).approvalPath).toBe(res.approvalPath); // the same ask, the same page
  });
  it("an ownerless agent, and an owned agent asking a scope off the list, get a node row and the Admin page", async () => {
    const s = world();
    const loose = await ask(s, LOOSE);
    expect(loose.approvalPath).toBe(`/admin/ai-access/requests/${s.roles[0]?.id}`);
    expect(s.roles[0]).toMatchObject({ kind: "node", owner: null });
    const off = await ask(s, AGENT, "work_item:transition");
    expect(off.approvalPath).toBe(`/admin/ai-access/requests/${s.roles[1]?.id}`);
    expect(s.roles[1]).toMatchObject({ kind: "node" });
    const admin = await ask(s, AGENT, "vcs:merge_pr");
    expect(admin.approvalPath).toMatch(/^\/admin\//);
  });
  it("two asks never share a page", async () => {
    const s = world();
    const a = await ask(s, AGENT, CONTRIBUTE);
    const b = await ask(s, AGENT, READ);
    expect(a.approvalPath).not.toBe(b.approvalPath);
  });
  it("an ask made before the agent had an owner is retired when the owner's row is asked, and a live admin row is not asked again", async () => {
    const s = world();
    s.roles.push({ principal: AGENT, scope: CONTRIBUTE, revoked: false, approvedBy: null, kind: "node", id: "old", owner: null, expiresAt: null });
    expect((await ask(s)).created).toBe(true);
    expect(s.roles.find((r) => r.id === "old")?.revoked).toBe(true);
    const admin = world({ roles: [{ principal: AGENT, scope: READ }] }); // a live node row
    expect(await ask(admin, AGENT, READ)).toMatchObject({ state: "granted", created: false });
  });
  it("caps: 3 open asks per agent and 5 per owner", async () => {
    const s = world({ owners: { a1: OWNER, a2: OWNER, a3: OWNER } });
    const lots = [READ, CONTRIBUTE];
    await ask(s, "a1", READ);
    await ask(s, "a1", CONTRIBUTE);
    await ask(s, "a2", READ);
    await ask(s, "a2", CONTRIBUTE);
    await ask(s, "a3", READ);
    expect(s.roles.filter((r) => r.kind === "delegated")).toHaveLength(MAX_PENDING_PER_OWNER);
    await expect(ask(s, "a3", CONTRIBUTE)).rejects.toMatchObject({ code: "too_many_requests" });
    expect(lots.length).toBe(2);
  });
});

describe("the owner turns it On and Off; the lock follows", () => {
  it("On: the bearer passes; the allow names the owner; Off: it fails", async () => {
    const s = world();
    await ask(s);
    expect(await lock(s)).toMatchObject({ decision: "deny", reason: "no_role" }); // an Off row opens nothing
    expect(await on(s)).toEqual({ principalUserId: AGENT, created: true });
    expect(s.roles[0]).toMatchObject({ approvedBy: OWNER, owner: OWNER, expiresAt: s.clock.now + PERSONAL_GRANT_TTL_DAYS * 86_400_000 });
    expect(await lock(s)).toEqual({ decision: "allow", basis: "personal_grant", owner: OWNER });
    expect(await door(s, member(CONTRIBUTE))).toMatchObject({ decision: "allow", owner: OWNER });
    await revokePersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: CONTRIBUTE, scopes });
    expect(await lock(s)).toMatchObject({ decision: "deny" });
  });
  it("it ends after the fixed days, and the agent can ask again", async () => {
    const s = world();
    await ask(s);
    await on(s);
    s.clock.now += (PERSONAL_GRANT_TTL_DAYS + 1) * 86_400_000;
    expect(await lock(s)).toMatchObject({ decision: "deny" });
    expect((await listOwnAccess(s, AGENT))[0]).toMatchObject({ scope: CONTRIBUTE, state: "revoked" });
    expect((await ask(s)).created).toBe(true);
  });
  it("a live NODE row still opens the lock, with no owner in the allow", async () => {
    const s = world({ roles: [{ principal: LOOSE, scope: CONTRIBUTE }] });
    expect(await lock(s, CONTRIBUTE, LOOSE)).toEqual({ decision: "allow", basis: "role" });
  });
  it("a change of owner closes the lock though the row is untouched", async () => {
    const moved = world({ owners: { [AGENT]: OTHER }, roles: [{ principal: AGENT, scope: CONTRIBUTE, kind: "delegated", owner: OWNER }] });
    expect(await lock(moved)).toMatchObject({ decision: "deny" });
  });
  it("only the owner decides; a scope off the list is refused on every personal path, even when a row is forced into the store", async () => {
    const s = world();
    await ask(s);
    await expect(on(s, CONTRIBUTE, OTHER)).rejects.toMatchObject({ code: "principal_not_found" });
    await expect(on(s, CONTRIBUTE, AGENT)).rejects.toMatchObject({ code: "self_approval" });
    await expect(on(s, "work_item:transition")).rejects.toMatchObject({ code: "invalid_scope" });
    // forced rows: a personal row for a scope off the list never opens a lock, and the by-id approve refuses it
    const forced = world({
      roles: [
        { principal: AGENT, scope: "work_item:transition", kind: "delegated", owner: OWNER },
        { principal: AGENT, scope: "vcs:merge_pr", kind: "delegated", owner: OWNER },
      ],
    });
    expect(await lock(forced, "work_item:transition")).toMatchObject({ decision: "deny" });
    expect(await door(forced, { scope: "vcs:merge_pr", kind: "node", subject: "admin" })).toMatchObject({ decision: "deny" }); // never satisfies an admin-subject scope
    const pending = world();
    pending.roles.push({ principal: AGENT, scope: "work_item:transition", revoked: false, approvedBy: null, kind: "delegated", id: "p1", owner: OWNER, expiresAt: null });
    await expect(decideAsOwner(pending, { ownerUserId: OWNER, requestId: "p1", decision: "approve" })).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("the approval page: one request, one approver, one atomic decision", () => {
  it("Approve by id turns it On once; a second click is not_pending; Deny ends the ask; another person and an unknown id are 404", async () => {
    const s = world();
    const { approvalPath } = await ask(s);
    const id = approvalPath?.split("/").pop() as string;
    await expect(decideAsOwner(s, { ownerUserId: OTHER, requestId: id, decision: "approve" })).rejects.toMatchObject({ code: "principal_not_found" });
    await expect(decideAsOwner(s, { ownerUserId: OWNER, requestId: "nope", decision: "approve" })).rejects.toMatchObject({ code: "principal_not_found" });
    expect(await decideAsOwner(s, { ownerUserId: OWNER, requestId: id, decision: "approve" })).toMatchObject({ changed: true, scope: CONTRIBUTE });
    expect(await lock(s)).toMatchObject({ decision: "allow" });
    await expect(decideAsOwner(s, { ownerUserId: OWNER, requestId: id, decision: "approve" })).rejects.toMatchObject({ code: "not_pending" });
    const second = (await ask(s, AGENT, READ)).approvalPath?.split("/").pop() as string;
    expect(await decideAsOwner(s, { ownerUserId: OWNER, requestId: second, decision: "deny" })).toMatchObject({ changed: true });
    expect((await listOwnAccess(s, AGENT)).find((r) => r.scope === READ)?.state).toBe("denied");
  });
  it("the owner's view is theirs only; the admin's view is a node row an admin may decide, never a personal row or an owner's ask", async () => {
    const s = world();
    const personal = (await ask(s)).approvalPath?.split("/").pop() as string;
    const node = (await ask(s, LOOSE)).approvalPath?.split("/").pop() as string;
    const offList = (await ask(s, AGENT, "work_item:transition")).approvalPath?.split("/").pop() as string;
    const view = (id: string, who = OWNER) => requestViewForOwner(s, { ownerUserId: who, requestId: id, declarations });
    expect(await view(personal)).toMatchObject({ who: "Helper bot", owner: "Olive Owner", label: "Propose changes to the knowledge base", state: "pending" });
    expect(await view(personal, OTHER)).toBeNull();
    expect(await view(node)).toBeNull(); // a node row is an admin's
    const admin = (id: string) => requestViewForAdmin(s, { requestId: id, declarations: { ...declarations, "work_item:transition": { label: "Move work items", description: "Change a work item's state." } }, scopes });
    expect(await admin(node)).toMatchObject({ who: "Unnamed agent", owner: null, state: "pending" });
    expect(await admin(offList)).toMatchObject({ owner: "Olive Owner" }); // an owned agent's ask off the list is the admin's
    expect(await admin(personal)).toBeNull(); // an owner's ask is not
    expect(await admin("unknown")).toBeNull();
  });
});

describe("one grant row, two approvers: node and personal never mix", () => {
  it("the admin path refuses a delegable scope for an owned agent, and still grants it to an ownerless agent and this node's AI", async () => {
    const s = world();
    await ask(s);
    const input = { scope: CONTRIBUTE, approvedBy: "admin-1", declaredScopes, scopes };
    await expect(grantRole(s, { principalUserId: AGENT, ...input })).rejects.toMatchObject({ code: "personal_scope" });
    expect(s.roles.filter((r) => r.approvedBy)).toHaveLength(0);
    await ask(s, LOOSE);
    expect(await grantRole(s, { principalUserId: LOOSE, ...input })).toMatchObject({ created: true });
    expect(await grantRole(s, { principalSlug: "node-ai", ...input })).toMatchObject({ created: true });
  });
  it("a personal row does not open a node lock; a node row does not satisfy the personal predicate", async () => {
    const s = world();
    await ask(s);
    await on(s);
    expect(await s.hasLiveRole(AGENT, CONTRIBUTE)).toBe(false);
    expect(await s.liveScopes(AGENT, [CONTRIBUTE])).toEqual([]);
    const node = world({ roles: [{ principal: AGENT, scope: CONTRIBUTE }] });
    expect(await node.hasLiveRole(AGENT, CONTRIBUTE, { kind: "delegated", ownerUserId: OWNER })).toBe(false);
  });
  it("the admin table lists a live personal row read-only, never an owner's pending ask, and the admin may revoke it (kill switch)", async () => {
    const s = world();
    await ask(s);
    const view = async () => buildNodeAiView({ declarations, scopesByPrincipal: {}, internal: [], rows: (await s.listRoleRows(100)).rows });
    expect(await view()).toEqual([]); // an owner's pending ask is not the admin's
    await on(s);
    expect(await view()).toEqual([expect.objectContaining({ section: "personal", who: "Helper bot", on: true, scope: CONTRIBUTE, until: expect.stringMatching(/^2026-12-12T/) })]);
    expect(await revokeRole(s, { principalUserId: AGENT, scope: CONTRIBUTE })).toEqual({ principalUserId: AGENT, revoked: true });
    expect(await lock(s)).toMatchObject({ decision: "deny" });
    expect(await view()).toEqual([]);
  });
  it("an own-AI view row set never reads a personal row as a node row", async () => {
    const s = world();
    await ask(s);
    await on(s);
    expect((await s.listLiveRoles()).length).toBe(0);
  });
});

describe("Your AIs rows", () => {
  it("shows an ask as Off and a live grant as On with its end; each person sees only their own AIs", async () => {
    const s = world();
    await ask(s);
    await ask(s, "agent-2");
    const off = buildYourAisView({ declarations, rows: await s.listPersonalRows(OWNER) });
    expect(off).toEqual([expect.objectContaining({ principalUserId: AGENT, who: "Helper bot", scope: CONTRIBUTE, on: false, until: null })]);
    await on(s);
    expect(buildYourAisView({ declarations, rows: await s.listPersonalRows(OWNER) })).toEqual([expect.objectContaining({ on: true, until: expect.stringMatching(/^2026-12-12T/) })]);
    expect((await s.listPersonalRows(OTHER)).map((r) => r.principalUserId)).toEqual(["agent-2"]);
  });
  it("leaves out a scope with no declaration and an ended grant", async () => {
    const s = world();
    await ask(s);
    await on(s);
    expect(buildYourAisView({ declarations: {}, rows: await s.listPersonalRows(OWNER) })).toEqual([]);
    s.clock.now += 40 * 86_400_000;
    expect(await s.listPersonalRows(OWNER)).toEqual([]);
  });
  it("AgentRolesError is what refusals throw", async () => {
    await expect(on(world())).rejects.toBeInstanceOf(AgentRolesError);
  });
});
