// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/orgs.routes`
 * Purpose: The org account routes (task.0181) as thin HTTP over `container.orgAccounts`: each domain refusal keeps its code and status, a store failure is 503 `authz_unavailable`,
 *   the suspension and outbound routes run the one admin check first, and the public link route turns each refusal code into its status without ever echoing the assertion.
 * Scope: The real route handlers over a fake container; no database, no network.
 * Side-effects: none
 */

import { LinkError, OrgError } from "@cogni/agent-grants";
import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  adminCheck: vi.fn(),
  orgAccounts: {
    create: vi.fn(),
    invite: vi.fn(),
    changeRole: vi.fn(),
    remove: vi.fn(),
    linkCode: vi.fn(),
    closeLink: vi.fn(),
    applyLink: vi.fn(),
    setSuspended: vi.fn(),
    signOutbound: vi.fn(),
    accept: vi.fn(),
  },
}));

const ctx = () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown, context?: unknown) => Promise<NextResponse>) =>
    (request: Request, context?: unknown) =>
      handler(ctx(), request, { id: "caller-1", via: "session" }, context),
  wrapPublicRoute:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler(ctx(), request),
}));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ agentAuthority: { adminCheck: fake.adminCheck }, orgAccounts: fake.orgAccounts }),
}));

import { POST as CREATE } from "@/app/api/v1/orgs/route";
import { POST as ACCEPT } from "@/app/api/v1/orgs/invites/[inviteId]/accept/route";
import { POST as LINK } from "@/app/api/v1/orgs/link/route";
import { POST as OUTBOUND } from "@/app/api/v1/orgs/outbound/route";
import { POST as INVITE } from "@/app/api/v1/orgs/[orgId]/invites/route";
import { POST as LINK_CODE } from "@/app/api/v1/orgs/[orgId]/link-codes/route";
import { DELETE as REMOVE, PATCH as ROLE } from "@/app/api/v1/orgs/[orgId]/members/[userId]/route";
import { POST as SUSPEND } from "@/app/api/v1/orgs/[orgId]/suspension/route";

const req = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const WALLET = `0x${"1".repeat(40)}`;

beforeEach(() => {
  vi.clearAllMocks();
  fake.adminCheck.mockResolvedValue("allow");
});

describe("create, invite, accept", () => {
  it("creates an org (201) and maps its refusals: too many orgs 409, a bad name 400, a store failure 503", async () => {
    fake.orgAccounts.create.mockResolvedValueOnce({ orgUserId: "o1", billingAccountId: "a1", name: "toks5" });
    const ok = await CREATE(req("/api/v1/orgs", "POST", { name: "toks5" }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ orgUserId: "o1", billingAccountId: "a1", name: "toks5" });
    expect(fake.orgAccounts.create).toHaveBeenCalledWith("caller-1", "toks5");
    fake.orgAccounts.create.mockRejectedValueOnce(new OrgError("too_many_orgs"));
    expect((await CREATE(req("/api/v1/orgs", "POST", { name: "x" }))).status).toBe(409);
    fake.orgAccounts.create.mockRejectedValueOnce(new OrgError("invalid_name"));
    expect((await CREATE(req("/api/v1/orgs", "POST", { name: "x" }))).status).toBe(400);
    expect((await CREATE(req("/api/v1/orgs", "POST", {}))).status).toBe(400);
    fake.orgAccounts.create.mockRejectedValueOnce(new Error("db down"));
    const down = await CREATE(req("/api/v1/orgs", "POST", { name: "x" }));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "authz_unavailable" });
  });

  it("an invite names the caller as the actor; a stranger is 404, an admin inviting an owner 403, a member of the wallet 409", async () => {
    fake.orgAccounts.invite.mockResolvedValueOnce({ id: "i1", role: "admin", expiresAt: "2026-11-27T00:00:00.000Z" });
    const ok = await INVITE(req("/api/v1/orgs/o1/invites", "POST", { wallet: WALLET, role: "admin" }), params({ orgId: "o1" }));
    expect(ok.status).toBe(201);
    expect(fake.orgAccounts.invite).toHaveBeenCalledWith({ actorUserId: "caller-1", orgUserId: "o1", wallet: WALLET, role: "admin" });
    for (const [code, status] of [["not_found", 404], ["not_allowed", 403], ["already_member", 409], ["invalid_wallet", 400], ["too_many_invites", 429]] as const) {
      fake.orgAccounts.invite.mockRejectedValueOnce(new OrgError(code));
      expect((await INVITE(req("/api/v1/orgs/o1/invites", "POST", { wallet: WALLET, role: "admin" }), params({ orgId: "o1" }))).status, code).toBe(status);
    }
    expect((await INVITE(req("/api/v1/orgs/o1/invites", "POST", { wallet: WALLET, role: "member" }), params({ orgId: "o1" }))).status).toBe(400);
  });

  it("accept is the caller's own: a used or foreign invite is 404, a void one 409", async () => {
    fake.orgAccounts.accept.mockResolvedValueOnce({ orgUserId: "o1", role: "admin" });
    expect((await ACCEPT(req("/api/v1/orgs/invites/i1/accept", "POST"), params({ inviteId: "i1" }))).status).toBe(200);
    expect(fake.orgAccounts.accept).toHaveBeenCalledWith("caller-1", "i1");
    fake.orgAccounts.accept.mockRejectedValueOnce(new OrgError("invite_not_found"));
    expect((await ACCEPT(req("/api/v1/orgs/invites/i1/accept", "POST"), params({ inviteId: "i1" }))).status).toBe(404);
    fake.orgAccounts.accept.mockRejectedValueOnce(new OrgError("invite_void"));
    expect((await ACCEPT(req("/api/v1/orgs/invites/i1/accept", "POST"), params({ inviteId: "i1" }))).status).toBe(409);
  });
});

describe("members and links", () => {
  it("the last owner is 409 last_owner on a role change and on a removal; an admin touching an owner is 403", async () => {
    fake.orgAccounts.changeRole.mockRejectedValueOnce(new OrgError("last_owner"));
    const res = await ROLE(req("/api/v1/orgs/o1/members/u1", "PATCH", { role: "admin" }), params({ orgId: "o1", userId: "u1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_owner" });
    fake.orgAccounts.remove.mockRejectedValueOnce(new OrgError("last_owner"));
    expect((await REMOVE(req("/api/v1/orgs/o1/members/u1", "DELETE"), params({ orgId: "o1", userId: "u1" }))).status).toBe(409);
    fake.orgAccounts.remove.mockRejectedValueOnce(new OrgError("not_allowed"));
    expect((await REMOVE(req("/api/v1/orgs/o1/members/u1", "DELETE"), params({ orgId: "o1", userId: "u1" }))).status).toBe(403);
    fake.orgAccounts.changeRole.mockResolvedValueOnce({ changed: true, from: "admin", to: "owner" });
    expect((await ROLE(req("/api/v1/orgs/o1/members/u1", "PATCH", { role: "owner" }), params({ orgId: "o1", userId: "u1" }))).status).toBe(200);
    expect(fake.orgAccounts.changeRole).toHaveBeenLastCalledWith({ actorUserId: "caller-1", orgUserId: "o1", targetUserId: "u1", role: "owner" });
  });

  it("a link code answers once with the code (201); an admin is 403, a linked origin 409, a bad origin 400", async () => {
    fake.orgAccounts.linkCode.mockResolvedValueOnce({ code: "c".repeat(43), origin: "https://toks5.example.org", expiresAt: "2026-11-20T00:15:00.000Z" });
    const ok = await LINK_CODE(req("/api/v1/orgs/o1/link-codes", "POST", { origin: "https://toks5.example.org" }), params({ orgId: "o1" }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).code).toHaveLength(43);
    fake.orgAccounts.linkCode.mockRejectedValueOnce(new OrgError("not_allowed"));
    expect((await LINK_CODE(req("/api/v1/orgs/o1/link-codes", "POST", { origin: "https://toks5.example.org" }), params({ orgId: "o1" }))).status).toBe(403);
    fake.orgAccounts.linkCode.mockRejectedValueOnce(new LinkError("issuer_already_linked"));
    expect((await LINK_CODE(req("/api/v1/orgs/o1/link-codes", "POST", { origin: "https://toks5.example.org" }), params({ orgId: "o1" }))).status).toBe(409);
    fake.orgAccounts.linkCode.mockRejectedValueOnce(new LinkError("invalid_origin"));
    expect((await LINK_CODE(req("/api/v1/orgs/o1/link-codes", "POST", { origin: "nope" }), params({ orgId: "o1" }))).status).toBe(400);
  });
});

describe("POST /api/v1/orgs/link (the signature is the credential)", () => {
  const link = (headers: Record<string, string>, body: unknown = {}) => LINK(req("/api/v1/orgs/link", "POST", body, headers));

  it("no bearer is 401 and nothing is applied", async () => {
    expect((await link({})).status).toBe(401);
    expect(fake.orgAccounts.applyLink).not.toHaveBeenCalled();
  });

  it("a body with anything in it is 400; the bearer alone carries the claims", async () => {
    expect((await link({ authorization: "Bearer t" }, { act: "link" })).status).toBe(400);
    expect(fake.orgAccounts.applyLink).not.toHaveBeenCalled();
  });

  it("each refusal code has its status, the assertion is never echoed, and a failure of the stores is 503", async () => {
    const cases = [
      ["invalid_assertion", 401, "invalid_token"],
      ["link_code_invalid", 400, "link_code_invalid"],
      ["issuer_already_linked", 409, "issuer_already_linked"],
      ["no_open_link", 404, "no_open_link"],
      ["org_suspended", 403, "org_suspended"],
      ["jwks_unavailable", 503, "jwks_unavailable"],
    ] as const;
    for (const [code, status, error] of cases) {
      fake.orgAccounts.applyLink.mockResolvedValueOnce({ ok: false, code });
      const res = await link({ authorization: "Bearer SECRET-ASSERTION" });
      expect(res.status, code).toBe(status);
      const text = JSON.stringify(await res.json());
      expect(text).toContain(error);
      expect(text).not.toContain("SECRET-ASSERTION");
    }
    fake.orgAccounts.applyLink.mockRejectedValueOnce(new Error("replay store down"));
    expect((await link({ authorization: "Bearer t" })).status).toBe(503);
  });

  it("a verified link is 201 and an unlink 200, with the org and the services", async () => {
    fake.orgAccounts.applyLink.mockResolvedValueOnce({ ok: true, act: "link", orgUserId: "o1", issuer: "https://x.example", services: ["node-ai"], linkId: "l1", bound: 1 });
    const linked = await link({ authorization: "Bearer t" });
    expect(linked.status).toBe(201);
    expect(await linked.json()).toEqual({ act: "link", orgUserId: "o1", services: ["node-ai"], linkId: "l1" });
    fake.orgAccounts.applyLink.mockResolvedValueOnce({ ok: true, act: "unlink", orgUserId: "o1", issuer: "https://x.example", services: ["node-ai"], linkId: "l1", closedBindings: 1 });
    expect((await link({ authorization: "Bearer t" })).status).toBe(200);
  });
});

describe("the admin-only routes run the one admin check first", () => {
  it("suspension: a non-admin is 403 and nothing changes, an unreadable check is 503, an admin suspends, an unknown org is 404", async () => {
    const call = (body: unknown) => SUSPEND(req("/api/v1/orgs/o1/suspension", "POST", body), params({ orgId: "o1" }));
    fake.adminCheck.mockResolvedValueOnce("denied");
    expect((await call({ suspended: true })).status).toBe(403);
    fake.adminCheck.mockResolvedValueOnce("unavailable");
    expect((await call({ suspended: true })).status).toBe(503);
    expect(fake.orgAccounts.setSuspended).not.toHaveBeenCalled();
    fake.orgAccounts.setSuspended.mockResolvedValueOnce(true);
    const ok = await call({ suspended: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ suspended: true });
    expect(fake.orgAccounts.setSuspended).toHaveBeenCalledWith({ adminUserId: "caller-1", orgUserId: "o1", suspended: true });
    fake.orgAccounts.setSuspended.mockResolvedValueOnce(false);
    expect((await call({ suspended: false })).status).toBe(404);
  });

  it("outbound: a non-admin is 403 and nothing is signed; an admin gets the target's answer; no signer is 503, an unreachable target 502", async () => {
    const body = { act: "link", targetOrigin: "https://node-template.example", targetNodeId: "node-template", orgUserId: "o1", code: "c".repeat(43), services: ["node-ai"] };
    const call = () => OUTBOUND(req("/api/v1/orgs/outbound", "POST", body));
    fake.adminCheck.mockResolvedValueOnce("denied");
    expect((await call()).status).toBe(403);
    expect(fake.orgAccounts.signOutbound).not.toHaveBeenCalled();
    fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: true, httpStatus: 201, error: null, act: "link" });
    const ok = await call();
    expect(await ok.json()).toEqual({ httpStatus: 201, error: null, act: "link" });
    fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: false, reason: "no_signer" });
    expect((await call()).status).toBe(503);
    fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    expect((await call()).status).toBe(502);
  });
});
