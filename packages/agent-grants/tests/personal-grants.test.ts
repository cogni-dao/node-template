// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` personal grants (task.5465)
 * Purpose: `account:read`. An owned agent reads its owner's account only after the owner turns a personal grant On; Off, expired, foreign,
 *   node-row and unowned all answer null (the route's one 404). The ask is an Off row owned by the agent's owner; only that owner turns it On.
 * Scope: Pure logic over the in-memory store, which implements the same live predicate as the SQL (and the RLS function `agent_has_scope`).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import {
  AgentRolesError,
  authorizeAccount,
  buildNodeAiView,
  buildYourAisView,
  grantPersonal,
  grantRole,
  listOwnAccess,
  PERSONAL_GRANT_TTL_DAYS,
  requestAccess,
  revokePersonal,
  ROUTE_ONLY_CAPABILITIES,
} from "../src";
import { memoryStore } from "./memory-store";

const SCOPE = "account:read";
const scopeKinds = { [SCOPE]: "account", "work_item:transition": "node" } as const;
const declaredScopes = [SCOPE, "work_item:transition"];
const askableScopes = [SCOPE, "work_item:transition"];

const OWNER = "owner-1";
const OTHER = "owner-2";
const AGENT = "agent-1";
const ACCOUNT = "acct-owner-1";
const ACCOUNT_OTHER = "acct-owner-2";

const world = (extra?: Parameters<typeof memoryStore>[0]) =>
  memoryStore({
    owners: { [AGENT]: OWNER, "agent-2": OTHER },
    accounts: { [ACCOUNT]: OWNER, [ACCOUNT_OTHER]: OTHER },
    names: { [AGENT]: "Helper bot" },
    ...extra,
  });
const ask = (s: ReturnType<typeof world>, principalUserId = AGENT) =>
  requestAccess(s, { principalUserId, scope: SCOPE, declaredScopes, askableScopes, scopeKinds });
const read = (s: ReturnType<typeof world>, userId: string, accountId: string, via: "bearer" | "session" = "bearer") =>
  authorizeAccount(s, { userId, via, accountId, scope: SCOPE });

describe("the declaration", () => {
  it("account:read is declared once as kind account, route-only, with plain words", () => {
    const cap = ROUTE_ONLY_CAPABILITIES["account.read"];
    expect(cap?.requires).toMatchObject({ scope: SCOPE, kind: "account", subject: "member" });
    expect(cap?.routes).toEqual(["accounts.credits.read"]);
    expect(cap?.requires.description).toContain(String(PERSONAL_GRANT_TTL_DAYS));
  });
});

describe("the ask: an owned agent asks, an unowned agent cannot", () => {
  it("writes an Off row owned by the agent's owner, and an Off row opens nothing", async () => {
    const s = world();
    expect(await ask(s)).toEqual({ state: "pending", created: true });
    expect(s.roles[0]).toMatchObject({ principal: AGENT, kind: "account", owner: OWNER, approvedBy: null });
    expect(await read(s, AGENT, ACCOUNT)).toBeNull();
    expect(await ask(s)).toEqual({ state: "pending", created: false });
  });
  it("an unowned agent gets needs_owner and nothing is written", async () => {
    const s = world();
    await expect(ask(s, "ownerless")).rejects.toMatchObject({ code: "needs_owner" });
    expect(s.roles).toHaveLength(0);
  });
  it("an own-kind scope (schedule:manage) is still an admin's node row: an unowned agent can ask it", async () => {
    const s = world();
    const kinds = { "schedule:manage": "own" } as const;
    expect(await requestAccess(s, { principalUserId: "ownerless", scope: "schedule:manage", declaredScopes: ["schedule:manage"], askableScopes: ["schedule:manage"], scopeKinds: kinds })).toEqual({ state: "pending", created: true });
    expect(s.roles[0]).toMatchObject({ kind: "node", owner: null });
    await expect(grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: "schedule:manage", scopeKinds: kinds })).rejects.toMatchObject({ code: "invalid_scope" });
  });
  it("a personal ask does not count toward the node-wide cap", async () => {
    const s = world();
    // the node-wide cap (MAX_PENDING_TOTAL) is full of node asks, yet a personal ask still lands
    for (let i = 0; i < 50; i += 1) s.roles.push({ principal: `flood-${i}`, scope: "work_item:transition", revoked: false, approvedBy: null, kind: "node", owner: null, expiresAt: null });
    expect(await ask(s)).toEqual({ state: "pending", created: true });
    await expect(
      requestAccess(s, { principalUserId: "someone", scope: "work_item:transition", declaredScopes, askableScopes, scopeKinds })
    ).rejects.toMatchObject({ code: "too_many_requests" });
  });
});

describe("the owner turns it On and Off", () => {
  it("On: the agent reads its owner's account; Off: it does not (revoked)", async () => {
    const s = world();
    await ask(s);
    expect(await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds })).toEqual({ principalUserId: AGENT, created: true });
    expect(s.roles[0]).toMatchObject({ approvedBy: OWNER, owner: OWNER });
    expect(await read(s, AGENT, ACCOUNT)).toEqual({ accessKind: "delegated" });
    expect(await revokePersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds })).toEqual({ principalUserId: AGENT, changed: true });
    expect(await read(s, AGENT, ACCOUNT)).toBeNull();
  });
  it("the grant ends after the fixed days and the agent can ask again", async () => {
    const s = world();
    await ask(s);
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    const row = s.roles[0];
    expect(row?.expiresAt).toBe(s.clock.now + PERSONAL_GRANT_TTL_DAYS * 86_400_000);
    s.clock.now += (PERSONAL_GRANT_TTL_DAYS + 1) * 86_400_000;
    expect(await read(s, AGENT, ACCOUNT)).toBeNull(); // expired: 404
    expect((await listOwnAccess(s, AGENT)).find((r) => r.scope === SCOPE)).toMatchObject({ state: "revoked" });
    expect(await ask(s)).toEqual({ state: "pending", created: true }); // a new Off row, not stuck behind the old one
    expect(s.roles.filter((r) => !r.revoked)).toHaveLength(1);
  });
  it("only the owner decides: another person, the agent itself and a scope never asked all fail", async () => {
    const s = world();
    await ask(s);
    await expect(grantPersonal(s, { ownerUserId: OTHER, principalUserId: AGENT, scope: SCOPE, scopeKinds })).rejects.toMatchObject({ code: "principal_not_found" });
    await expect(grantPersonal(s, { ownerUserId: AGENT, principalUserId: AGENT, scope: SCOPE, scopeKinds })).rejects.toMatchObject({ code: "self_approval" });
    await expect(grantPersonal(s, { ownerUserId: OWNER, principalUserId: "agent-2", scope: SCOPE, scopeKinds })).rejects.toMatchObject({ code: "principal_not_found" });
    expect(await read(s, AGENT, ACCOUNT)).toBeNull();
    const none = world();
    await expect(grantPersonal(none, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds })).rejects.toMatchObject({ code: "not_pending" });
    await expect(grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: "work_item:transition", scopeKinds })).rejects.toMatchObject({ code: "invalid_scope" });
  });
  it("another person cannot turn Off or dismiss; the owner can dismiss an ask", async () => {
    const s = world();
    await ask(s);
    await expect(revokePersonal(s, { ownerUserId: OTHER, principalUserId: AGENT, scope: SCOPE, scopeKinds, deny: true })).rejects.toBeInstanceOf(AgentRolesError);
    expect(await revokePersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds, deny: true })).toMatchObject({ changed: true });
    expect((await listOwnAccess(s, AGENT)).find((r) => r.scope === SCOPE)?.state).toBe("denied");
  });
  it("a live grant lists the account the owner opened, and only then", async () => {
    const s = world();
    await ask(s);
    expect((await listOwnAccess(s, AGENT))[0]).toEqual({ scope: SCOPE, state: "pending", at: expect.any(String) });
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    expect((await listOwnAccess(s, AGENT))[0]).toMatchObject({ state: "granted", accountId: ACCOUNT });
  });
});

describe("authorizeAccount: owner | live personal grant | null", () => {
  const granted = async () => {
    const s = world();
    await ask(s);
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    return s;
  };
  it("the owner (a person or an agent that owns it) reads their own account with no grant", async () => {
    const s = world();
    expect(await read(s, OWNER, ACCOUNT, "session")).toEqual({ accessKind: "owner" });
    expect(await read(s, OWNER, ACCOUNT)).toEqual({ accessKind: "owner" });
  });
  it("a foreign account, a missing account and a malformed id are the same null, even with a live grant", async () => {
    const s = await granted();
    expect(await read(s, AGENT, ACCOUNT_OTHER)).toBeNull();
    expect(await read(s, AGENT, "no-such-account")).toBeNull();
    expect(await read(s, AGENT, "../../x")).toBeNull();
    expect(await read(s, OTHER, ACCOUNT, "session")).toBeNull();
  });
  it("a human session never reads another person's account, grant or not", async () => {
    const s = await granted();
    expect(await read(s, AGENT, ACCOUNT, "session")).toBeNull();
  });
  it("a node role row never opens an account, and an unowned agent holds nothing", async () => {
    const s = world({ roles: [{ principal: AGENT, scope: SCOPE }, { principal: "ownerless", scope: SCOPE }] }); // node rows
    expect(await read(s, AGENT, ACCOUNT)).toBeNull();
    expect(await read(s, "ownerless", ACCOUNT)).toBeNull();
  });
  it("a row whose agent no longer belongs to that owner is not live", async () => {
    const s = await granted();
    const moved = world({ owners: { [AGENT]: OTHER }, roles: [{ principal: AGENT, scope: SCOPE, kind: "account", owner: OWNER }] });
    expect(await read(s, AGENT, ACCOUNT)).toEqual({ accessKind: "delegated" });
    expect(await read(moved, AGENT, ACCOUNT)).toBeNull();
  });
  it("a store outage rejects, never allows", async () => {
    await expect(read(world({ failing: true }), AGENT, ACCOUNT)).rejects.toThrow();
  });
});

describe("one row, two planes: node and personal never mix", () => {
  it("the admin path refuses a personal scope, for an outside agent and for this node's own AI", async () => {
    const s = world({ principals: { "node-ai": "internal-1" } });
    await ask(s);
    const input = { scope: SCOPE, approvedBy: "admin-1", declaredScopes, personalScopes: [SCOPE] };
    await expect(grantRole(s, { principalUserId: AGENT, ...input })).rejects.toMatchObject({ code: "personal_scope" });
    await expect(grantRole(s, { principalSlug: "node-ai", ...input })).rejects.toMatchObject({ code: "personal_scope" });
    expect(s.roles.filter((r) => r.approvedBy)).toHaveLength(0);
  });
  it("a personal row does not open a node lock and never reaches the admin view", async () => {
    const s = world();
    await ask(s);
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    expect(await s.hasLiveRole(AGENT, SCOPE)).toBe(false);
    expect(await s.liveScopes(AGENT, [SCOPE])).toEqual([]);
    const listed = await s.listRoleRows(100);
    expect(listed.rows).toEqual([]);
    const admin = buildNodeAiView({ declarations: { [SCOPE]: { label: "Read", description: "Read" } }, scopesByPrincipal: {}, internal: [], rows: listed.rows });
    expect(admin).toEqual([]);
  });
  it("a node row does not satisfy the personal predicate", async () => {
    const s = world({ roles: [{ principal: AGENT, scope: "work_item:transition" }] });
    expect(await s.hasLiveRole(AGENT, "work_item:transition")).toBe(true);
    expect(await s.hasLiveRole(AGENT, "work_item:transition", { kind: "account", ownerUserId: OWNER })).toBe(false);
  });
});

describe("Your AIs rows", () => {
  const declarations = { [SCOPE]: { label: "Read your account balance", description: "See the credit balance of your account." } };
  it("shows an ask as Off and a live grant as On with its end; each person sees only their own AIs", async () => {
    const s = world();
    await ask(s);
    await ask(s, "agent-2");
    const off = buildYourAisView({ declarations, rows: await s.listPersonalRows(OWNER) });
    expect(off).toEqual([expect.objectContaining({ principalUserId: AGENT, who: "Helper bot", scope: SCOPE, on: false, until: null })]);
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    const on = buildYourAisView({ declarations, rows: await s.listPersonalRows(OWNER) });
    expect(on).toEqual([expect.objectContaining({ on: true, until: expect.stringMatching(/^2026-12-12T/) })]);
    expect((await s.listPersonalRows(OTHER)).map((r) => r.principalUserId)).toEqual(["agent-2"]);
  });
  it("leaves out a scope with no declaration and an ended grant", async () => {
    const s = world();
    await ask(s);
    await grantPersonal(s, { ownerUserId: OWNER, principalUserId: AGENT, scope: SCOPE, scopeKinds });
    expect(buildYourAisView({ declarations: {}, rows: await s.listPersonalRows(OWNER) })).toEqual([]);
    s.clock.now += 40 * 86_400_000;
    expect(await s.listPersonalRows(OWNER)).toEqual([]);
  });
});
