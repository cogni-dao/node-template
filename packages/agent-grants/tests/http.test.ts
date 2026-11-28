// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tests/http`
 * Purpose: The route cores answer every status the access routes promise, from the package entry alone (task.0175): self-only asks, bad input, a quiet no,
 *   the admin refusal map, a non-disclosing preview and an outage that is reported once.
 * Scope: Fake authority objects. No framework, no database.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  accessRequestCreateHttp,
  accessRequestListHttp,
  accountCreditsHttp,
  adminAiAccessHttp,
  agentMeHttp,
  type AdminAiAccessCalls,
  type AgentAccessAuthority,
  mineHttp,
} from "../src/http";
import { AgentRolesError } from "../src/roles";

const onUnavailable = vi.fn();
const deps = { onUnavailable };
const me = { userId: "person-1", admin: null };

describe("access requests (AI plane)", () => {
  const authority = (fn: AgentAccessAuthority["requestAccess"]) => ({ requestAccess: fn });
  const base = { principalUserId: "agent-1", origin: "https://node.test" };

  it.each(["session", "bearer"] as const)("%s asks and lists only as the authenticated principal", async (via) => {
    const ask = vi.fn().mockResolvedValue({ state: "pending", created: true });
    const listOwnAccess = vi.fn().mockResolvedValue([]);
    const created = await accessRequestCreateHttp(deps, { ...base, via, body: { scope: "s", principalUserId: "other" }, authority: authority(ask) });
    expect(created.status).toBe(201);
    expect(ask).toHaveBeenCalledWith({ principalUserId: "agent-1", scope: "s" });
    const listed = await accessRequestListHttp(deps, { via, principalUserId: "agent-1", authority: { listOwnAccess } });
    expect(listed).toMatchObject({ status: 200, body: { requests: [] }, headers: { "cache-control": "no-store" } });
    expect(listOwnAccess).toHaveBeenCalledWith("agent-1");
  });

  it("a new ask is 201 with the link on this node's origin; a repeat is 200", async () => {
    const ask = vi.fn().mockResolvedValue({ scope: "s", state: "pending", created: true, approvalPath: "/admin/ai-access#agent-request=tok" });
    const res = await accessRequestCreateHttp(deps, { ...base, via: "bearer", body: { scope: "s" }, authority: authority(ask) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ scope: "s", approvalUrl: "https://node.test/admin/ai-access#agent-request=tok" });
    ask.mockResolvedValue({ state: "pending", created: false });
    expect((await accessRequestCreateHttp(deps, { ...base, via: "bearer", body: { scope: "s" }, authority: authority(ask) })).status).toBe(200);
  });

  it("unreadable JSON and a missing scope are 400; a bad scope, no door and too many asks map to their codes", async () => {
    const call = (body: unknown, fn = vi.fn()) => accessRequestCreateHttp(deps, { ...base, via: "bearer", body, authority: authority(fn) });
    expect((await call(undefined)).status).toBe(400);
    expect((await call({})).status).toBe(400);
    const refuse = (code: ConstructorParameters<typeof AgentRolesError>[0]) => vi.fn().mockRejectedValue(new AgentRolesError(code, code));
    expect((await call({ scope: "s" }, refuse("invalid_scope"))).status).toBe(400);
    expect((await call({ scope: "s" }, refuse("no_external_door"))).body).toEqual({ error: "no_external_door" });
    expect((await call({ scope: "s" }, refuse("too_many_requests"))).status).toBe(429);
  });

  it("a store outage is 503 and is reported once with the route id", async () => {
    onUnavailable.mockClear();
    const res = await accessRequestListHttp(deps, {
      via: "bearer",
      principalUserId: "agent-1",
      authority: { listOwnAccess: vi.fn().mockRejectedValue(new Error("db down")) },
    });
    expect(res).toMatchObject({ status: 503, body: { error: "authz_unavailable" } });
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable.mock.calls[0]?.[0]).toBe("agent.access.requests.list");
  });
});

describe("the person's own table", () => {
  const authority = (over: Partial<AgentAccessAuthority>) => ({ scopeKinds: { "account:read": "account", "work_item:transition": "node" }, ...over }) as AgentAccessAuthority;

  it("a node scope from the profile is 400 invalid_scope before anything is written", async () => {
    const turnMineOn = vi.fn();
    const res = await mineHttp(deps, "on", { me, via: "session", body: { principalUserId: "ai", scope: "work_item:transition" }, authority: authority({ turnMineOn }) });
    expect(res).toMatchObject({ status: 400, body: { error: "invalid_scope" } });
    expect(turnMineOn).not.toHaveBeenCalled();
  });

  it("a person who owns no account gets the same quiet changed:false", async () => {
    const turnMineOff = vi.fn().mockRejectedValue(new AgentRolesError("not_allowed", "no"));
    const res = await mineHttp(deps, "off", { me, via: "session", body: { rowId: "0b6c9a4e-6f55-4d0c-9a3b-1d2f3a4b5c6d" }, authority: authority({ turnMineOff }) });
    expect(res).toMatchObject({ status: 200, body: { changed: false } });
  });

  it("a preview with a token of the wrong shape, or an unknown token, is one 404", async () => {
    const previewAsk = vi.fn().mockResolvedValue(null);
    expect((await mineHttp(deps, "preview", { me, via: "session", body: { token: "short" }, authority: authority({ previewAsk }) })).status).toBe(404);
    expect(previewAsk).not.toHaveBeenCalled();
    const token = "A".repeat(43);
    expect((await mineHttp(deps, "preview", { me, via: "session", body: { token }, authority: authority({ previewAsk }) })).status).toBe(404);
  });
});

describe("the admin table", () => {
  const calls = (over: Partial<AdminAiAccessCalls>) => ({ list: vi.fn(), on: vi.fn(), off: vi.fn(), dismiss: vi.fn(), preview: vi.fn(), ...over }) as AdminAiAccessCalls;
  const body = { principal: "node-ai", scope: "work_item:transition" };

  it("turns a permission on by slug and echoes the principal", async () => {
    const on = vi.fn().mockResolvedValue({ principalUserId: "u-ai", changed: true });
    const res = await adminAiAccessHttp(deps, "on", { body, calls: calls({ on }) });
    expect(on).toHaveBeenCalledWith({ ref: { principalSlug: "node-ai" }, scope: "work_item:transition" });
    expect(res).toMatchObject({ status: 200, body: { principal: "node-ai", scope: "work_item:transition", principalUserId: "u-ai", changed: true } });
  });

  it("maps the refusals: unknown principal 404, not pending 409, self approval 403", async () => {
    const refuse = (code: ConstructorParameters<typeof AgentRolesError>[0]) => adminAiAccessHttp(deps, "on", { body, calls: calls({ on: vi.fn().mockRejectedValue(new AgentRolesError(code, code)) }) });
    expect((await refuse("principal_not_found")).status).toBe(404);
    expect((await refuse("not_pending")).status).toBe(409);
    expect((await refuse("self_approval")).status).toBe(403);
  });

  it("deny on DELETE dismisses the ask instead of turning it off", async () => {
    const dismiss = vi.fn().mockResolvedValue({ principalUserId: "u", changed: true });
    const off = vi.fn();
    await adminAiAccessHttp(deps, "off", { body: { ...body, deny: true }, calls: calls({ dismiss, off }) });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(off).not.toHaveBeenCalled();
  });

  it("an admin list always says canManage:true", async () => {
    const res = await adminAiAccessHttp(deps, "list", { calls: calls({ list: vi.fn().mockResolvedValue({ permissions: [], more: 0 }) }) });
    expect(res.body).toEqual({ canManage: true, permissions: [], more: 0 });
  });
});

describe("agent/me", () => {
  const authority = (admin: "allow" | "denied" | "unavailable") => ({
    boundWallets: async () => ["0xa"],
    adminCheck: async () => admin,
    listOwnAccess: async () => [
      { scope: "a", state: "granted" as const, at: "t", accountId: null },
      { scope: "b", state: "revoked" as const, at: "t", accountId: null },
    ],
    principalKind: async () => "agent" as const,
  });

  it("reports kind, wallets, admin and only the live grants", async () => {
    const res = await agentMeHttp(deps, { userId: "u", via: "bearer", authority: authority("allow") });
    expect(res.body).toEqual({ userId: "u", via: "bearer", kind: "agent", wallets: ["0xa"], isAdmin: true, grants: [{ scope: "a", accountId: null, since: "t" }] });
  });

  it("is 503 when the admin roster is unavailable", async () => {
    expect((await agentMeHttp(deps, { userId: "u", via: "session", authority: authority("unavailable") })).status).toBe(503);
  });
});

describe("account credits", () => {
  const contract = {
    input: z.object({ limit: z.number().int().positive().max(50).optional() }),
    output: z.object({ balance: z.number() }),
  };
  it("reads with the parsed limit and sends the contract-parsed body", async () => {
    const read = vi.fn().mockResolvedValue({ balance: 7, extra: "dropped" });
    const res = await accountCreditsHttp({ limitParam: "5", contract, read });
    expect(read).toHaveBeenCalledWith(5);
    expect(res).toMatchObject({ status: 200, body: { balance: 7 }, headers: { "cache-control": "no-store" } });
  });
  it("a bad limit is 400 and reads nothing", async () => {
    const read = vi.fn();
    expect((await accountCreditsHttp({ limitParam: "nope", contract, read })).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("a foreign, expired, revoked or missing account is one 404", async () => {
    expect(await accountCreditsHttp({ limitParam: null, contract, read: async () => null })).toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});

describe("success paths", () => {
  it("mine on turns an own-AI row on with the person as approver", async () => {
    const turnMineOn = vi.fn().mockResolvedValue({ changed: true });
    const authority = { scopeKinds: { "account:read": "account" }, turnMineOn } as unknown as AgentAccessAuthority;
    const res = await mineHttp(deps, "on", { me, via: "session", body: { principalUserId: "ai", scope: "account:read" }, authority });
    expect(turnMineOn).toHaveBeenCalledWith(me, { principalUserId: "ai", scope: "account:read" });
    expect(res).toMatchObject({ status: 200, body: { changed: true } });
  });
  it("admin preview returns the waiting row", async () => {
    const permission = { section: "pending", principalUserId: "u", who: "agent", outside: true, hint: null, scope: "s", label: "L", description: "D", on: false, until: null, resource: "node", rowId: null };
    const res = await adminAiAccessHttp(deps, "preview", { body: { token: "A".repeat(43) }, calls: { preview: async () => permission } as unknown as AdminAiAccessCalls });
    expect(res).toMatchObject({ status: 200, body: { permission } });
  });
});
