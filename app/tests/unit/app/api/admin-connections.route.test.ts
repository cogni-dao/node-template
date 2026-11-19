// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/admin-connections.route`
 * Purpose: Connect from home (story.0038): the four admin routes behind `/admin/connected-orgs` (provider) and `/admin/connections` (customer) are ONE admin check for any credential.
 *   A non-admin session and a non-admin bearer are 403 with NOTHING called on the port (no allowance written, no suspension, nothing signed or sent); no caller is 401; the check down is 503.
 *   An admin reaches the port with the minted session; the allowance route validates its body and passes an idempotency key; unknown org is 404; a node with no signer cannot connect (503).
 * Scope: The real route handlers and the real mint with a fake container and session; no database, no network.
 * Invariants: ONE_ADMIN_CHECK; ADMIN_ACTS_IN_ADMIN (every write goes through the port); FAIL_CLOSED_WITH_DISTINCTION; NO_NEW_AUTHORITY (the port is called, the route decides nothing).
 * Side-effects: none
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  adminCheck: vi.fn(),
  listConnectedOrgs: vi.fn(),
  setConnectedOrgSuspended: vi.fn(),
  grantConnectionAllowance: vi.fn(),
  listOutboundConnections: vi.fn(),
  actOutboundConnection: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown, context: unknown) => Promise<NextResponse>) =>
    (request: Request, context?: unknown) =>
      handler({ log: fake.log }, request, null, context),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    log: fake.log,
    agentAuthority: { adminCheck: fake.adminCheck },
    nodeAdminPort: {
      listConnectedOrgs: fake.listConnectedOrgs,
      setConnectedOrgSuspended: fake.setConnectedOrgSuspended,
      grantConnectionAllowance: fake.grantConnectionAllowance,
      listOutboundConnections: fake.listOutboundConnections,
      actOutboundConnection: fake.actOutboundConnection,
    },
  }),
}));

import { POST as allowance } from "@/app/api/v1/admin/connected-orgs/[orgUserId]/allowance/route";
import { POST as suspension } from "@/app/api/v1/admin/connected-orgs/[orgUserId]/suspension/route";
import { GET as listOrgs } from "@/app/api/v1/admin/connected-orgs/route";
import { GET as listConnections, POST as act } from "@/app/api/v1/admin/connections/route";

const ORG = "org-user-1";
const ctx = (orgUserId = ORG) => ({ params: Promise.resolve({ orgUserId }) });
const sessionUser = (id: string, via: "session" | "bearer" = "session") => ({ id, walletAddress: `0x${id}`, displayName: null, avatarColor: null, via });
const post = (handler: (request: NextRequest, context?: never) => Promise<NextResponse>, body: unknown, headers: Record<string, string> = {}, context?: unknown) =>
  handler(new NextRequest("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), context as never);
const get = (handler: (request: NextRequest) => Promise<NextResponse>, query = "") => handler(new NextRequest(`http://localhost/api/x${query}`));

const orgsPage = { orgs: [{ orgUserId: ORG, issuer: "https://toks5-test.cognidao.org", nodeId: "n1", status: "connected", allowance: 500, debits: 15, cap: 1000, lastCallAt: null }], nextAfter: null };
const targets = { signer: true, targets: [{ alias: "prov", origin: "https://prov.example.org", offer: "Shared AI", status: "not_connected", cap: null }] };

beforeEach(() => {
  vi.clearAllMocks();
  fake.user = sessionUser("admin-1");
  fake.adminCheck.mockResolvedValue("allow");
  fake.listConnectedOrgs.mockResolvedValue(orgsPage);
  fake.setConnectedOrgSuspended.mockResolvedValue(true);
  fake.grantConnectionAllowance.mockResolvedValue({ allowance: 750, applied: true });
  fake.listOutboundConnections.mockResolvedValue(targets);
  fake.actOutboundConnection.mockResolvedValue({
    ok: true,
    alias: "prov",
    act: "connect",
    httpStatus: 200,
    status: "connected",
    error: null,
    target: { alias: "prov", origin: "https://prov.example.org", status: "connected", cap: 1000 },
  });
});

/** Every admin route in this file, called as a given caller, with what each one must never touch for a non-admin. */
const calls: Array<{ name: string; run: () => Promise<NextResponse>; ports: Array<ReturnType<typeof vi.fn>> }> = [
  { name: "GET /connected-orgs", run: () => get(listOrgs), ports: [fake.listConnectedOrgs] },
  { name: "POST /connected-orgs/{id}/allowance", run: () => post(allowance, { credits: 100 }, {}, ctx()), ports: [fake.grantConnectionAllowance] },
  { name: "POST /connected-orgs/{id}/suspension", run: () => post(suspension, { suspended: true }, {}, ctx()), ports: [fake.setConnectedOrgSuspended] },
  { name: "GET /connections", run: () => get(listConnections), ports: [fake.listOutboundConnections] },
  { name: "POST /connections", run: () => post(act, { act: "connect", alias: "prov", cap: 100 }), ports: [fake.actOutboundConnection] },
];

describe("the one admin check guards all five connection admin routes (any credential)", () => {
  it.each(calls)("$name: a non-admin session is 403 authz_denied and nothing is called", async ({ run, ports }) => {
    fake.adminCheck.mockResolvedValue("denied");
    const res = await run();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    for (const port of ports) expect(port).not.toHaveBeenCalled();
    expect(fake.log.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: "admin.action" }), "admin.action");
  });

  it.each(calls)("$name: a bearer with no admin wallet is 403, no caller is 401, the check down is 503, a throwing check is 503", async ({ run, ports }) => {
    fake.user = sessionUser("agent-1", "bearer");
    fake.adminCheck.mockResolvedValue("denied");
    expect((await run()).status).toBe(403);
    fake.user = null;
    expect((await run()).status).toBe(401);
    fake.user = sessionUser("admin-1");
    fake.adminCheck.mockResolvedValue("unavailable");
    expect((await run()).status).toBe(503);
    fake.adminCheck.mockRejectedValue(new Error("down"));
    expect((await run()).status).toBe(503);
    for (const port of ports) expect(port).not.toHaveBeenCalled();
  });

  it.each(calls)("$name: an admin bearer passes the same check, and one admin.action is logged with via bearer", async ({ run }) => {
    fake.user = sessionUser("agent-admin", "bearer");
    expect((await run()).status).toBe(200);
    expect(fake.adminCheck).toHaveBeenCalledWith("agent-admin");
    expect(fake.log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "admin.action", adminUserId: "agent-admin", via: "bearer" }), "admin.action");
  });
});

describe("provider: /api/v1/admin/connected-orgs", () => {
  it("GET lists the page and no-store; limit and after reach the port; a bad limit is 400", async () => {
    const res = await get(listOrgs, "?limit=10&after=https%3A%2F%2Fa.example.org");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(orgsPage);
    expect(fake.listConnectedOrgs).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin-1" }), { limit: 10, after: "https://a.example.org" });
    for (const bad of ["?limit=0", "?limit=101", "?limit=abc"]) expect((await get(listOrgs, bad)).status).toBe(400);
  });

  it("the allowance route grants through the port with the idempotency key, and answers the new allowance", async () => {
    const res = await post(allowance, { credits: 250 }, { "idempotency-key": "key-1" }, ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgUserId: ORG, allowance: 750, applied: true });
    expect(fake.grantConnectionAllowance).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin-1" }), { orgUserId: ORG, credits: 250, key: "key-1" });
    expect(fake.log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "connection.allowance_granted", orgUserId: ORG, credits: 250, applied: true, adminUserId: "admin-1" }), "connection.allowance_granted");
  });

  it("with no Idempotency-Key a fresh key is made; a retry that was applied answers applied false", async () => {
    await post(allowance, { credits: 5 }, {}, ctx());
    const key = fake.grantConnectionAllowance.mock.calls[0]?.[1]?.key as string;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    fake.grantConnectionAllowance.mockResolvedValue({ allowance: 750, applied: false });
    expect(await (await post(allowance, { credits: 5 }, { "idempotency-key": "k" }, ctx())).json()).toMatchObject({ applied: false });
  });

  it("the allowance route refuses a bad body or key before any write, and an unknown org is 404", async () => {
    for (const body of [{}, { credits: 0 }, { credits: -5 }, { credits: 1.5 }, { credits: "9" }, { credits: Number.MAX_SAFE_INTEGER + 2 }])
      expect((await post(allowance, body, {}, ctx())).status, JSON.stringify(body)).toBe(400);
    expect((await post(allowance, { credits: 5 }, { "idempotency-key": "has space" }, ctx())).status).toBe(400);
    expect((await post(allowance, { credits: 5 }, {}, ctx("bad id!"))).status).toBe(404);
    expect(fake.grantConnectionAllowance).not.toHaveBeenCalled();
    fake.grantConnectionAllowance.mockResolvedValue(null);
    expect((await post(allowance, { credits: 5 }, {}, ctx())).status).toBe(404);
  });

  it("a store failure on the allowance is 503", async () => {
    fake.grantConnectionAllowance.mockRejectedValue(new Error("db down"));
    expect((await post(allowance, { credits: 5 }, {}, ctx())).status).toBe(503);
  });

  it("Suspend and Resume go through the port; an unknown org is 404; a bad body is 400", async () => {
    expect(await (await post(suspension, { suspended: true }, {}, ctx())).json()).toEqual({ orgUserId: ORG, suspended: true });
    expect(fake.setConnectedOrgSuspended).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin-1" }), { orgUserId: ORG, suspended: true });
    await post(suspension, { suspended: false }, {}, ctx());
    expect(fake.setConnectedOrgSuspended).toHaveBeenLastCalledWith(expect.anything(), { orgUserId: ORG, suspended: false });
    fake.setConnectedOrgSuspended.mockResolvedValue(false);
    expect((await post(suspension, { suspended: true }, {}, ctx())).status).toBe(404);
    expect((await post(suspension, { suspended: "yes" }, {}, ctx())).status).toBe(400);
  });
});

describe("customer: /api/v1/admin/connections", () => {
  it("GET lists the configured targets with this node's state and the static offer, and says whether the node can sign", async () => {
    const res = await get(listConnections);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(targets);
    fake.listOutboundConnections.mockResolvedValue({ signer: false, targets: targets.targets });
    expect(await (await get(listConnections)).json()).toMatchObject({ signer: false });
  });

  it("POST connect and disconnect reach the port with the minted session and return the provider's answer", async () => {
    const res = await post(act, { act: "connect", alias: "prov", cap: 1000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alias: "prov", act: "connect", httpStatus: 200, status: "connected", error: null, target: { status: "connected", cap: 1000 } });
    expect(fake.actOutboundConnection).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin-1" }), { act: "connect", alias: "prov", cap: 1000 });
    await post(act, { act: "disconnect", alias: "prov" });
    expect(fake.actOutboundConnection).toHaveBeenLastCalledWith(expect.anything(), { act: "disconnect", alias: "prov" });
  });

  it("a provider refusal is shown as it is (its code and status), with no state change claimed", async () => {
    fake.actOutboundConnection.mockResolvedValue({
      ok: true,
      alias: "prov",
      act: "connect",
      httpStatus: 409,
      status: null,
      error: "stale_seq",
      target: { alias: "prov", origin: "https://prov.example.org", status: "not_connected", cap: null },
    });
    const body = await (await post(act, { act: "connect", alias: "prov", cap: 5 })).json();
    expect(body).toMatchObject({ httpStatus: 409, status: null, error: "stale_seq", target: { status: "not_connected" } });
  });

  it("an unknown alias is 404, no signing key is 503 signer_unavailable, an unreachable provider is 502; a bad body is 400 before anything is signed", async () => {
    fake.actOutboundConnection.mockResolvedValue({ ok: false, reason: "unknown_alias" });
    expect((await post(act, { act: "disconnect", alias: "nope" })).status).toBe(404);
    fake.actOutboundConnection.mockResolvedValue({ ok: false, reason: "no_signer" });
    const noSigner = await post(act, { act: "connect", alias: "prov", cap: 5 });
    expect(noSigner.status).toBe(503);
    expect(await noSigner.json()).toEqual({ error: "signer_unavailable" });
    fake.actOutboundConnection.mockResolvedValue({ ok: false, reason: "unreachable" });
    expect((await post(act, { act: "connect", alias: "prov", cap: 5 })).status).toBe(502);
    fake.actOutboundConnection.mockClear();
    for (const body of [{}, { act: "connect", alias: "prov" }, { act: "connect", alias: "Bad Alias", cap: 5 }, { act: "connect", alias: "prov", cap: -1 }, { act: "connect", alias: "prov", cap: 1.5 }, { act: "grant", alias: "prov", cap: 5 }])
      expect((await post(act, body)).status, JSON.stringify(body)).toBe(400);
    expect(fake.actOutboundConnection).not.toHaveBeenCalled();
  });
});
