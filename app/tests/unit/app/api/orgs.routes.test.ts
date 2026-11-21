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
    suspend: vi.fn(),
    signOutbound: vi.fn(),
    previewOutbound: vi.fn(),
    previewCode: vi.fn(),
    accept: vi.fn(),
    list: vi.fn(),
    members: vi.fn(),
    links: vi.fn(),
    myInvites: vi.fn(),
    view: vi.fn(),
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

import { POST as LINK_PREVIEW } from "@/app/api/v1/public/orgs/link-preview/route";
import { GET as LIST, POST as CREATE } from "@/app/api/v1/orgs/route";
import { GET as MEMBERS } from "@/app/api/v1/orgs/[orgId]/members/route";
import { GET as VIEW } from "@/app/api/v1/orgs/[orgId]/route";
import { GET as LINKS } from "@/app/api/v1/orgs/[orgId]/links/route";
import { GET as MINE } from "@/app/api/v1/orgs/invites/mine/route";
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
    fake.orgAccounts.create.mockRejectedValueOnce(new OrgError("org_role_limit"));
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
  it("suspension: a non-admin is 403 and nothing changes, an unreadable check is 503, an admin suspends (final: only `suspended: true` is accepted), an unknown org is 404", async () => {
    const call = (body: unknown) => SUSPEND(req("/api/v1/orgs/o1/suspension", "POST", body), params({ orgId: "o1" }));
    fake.adminCheck.mockResolvedValueOnce("denied");
    expect((await call({ suspended: true })).status).toBe(403);
    fake.adminCheck.mockResolvedValueOnce("unavailable");
    expect((await call({ suspended: true })).status).toBe(503);
    expect(fake.orgAccounts.suspend).not.toHaveBeenCalled();
    fake.orgAccounts.suspend.mockResolvedValueOnce(true);
    const ok = await call({ suspended: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ suspended: true });
    // The caller is the admin who is stored as `suspended_by`; the body names no actor.
    expect(fake.orgAccounts.suspend).toHaveBeenCalledWith({ adminUserId: "caller-1", orgUserId: "o1" });
    // There is no Resume: a body that asks for `suspended: false` is refused before anything is written.
    fake.orgAccounts.suspend.mockClear();
    expect((await call({ suspended: false })).status).toBe(400);
    expect(fake.orgAccounts.suspend).not.toHaveBeenCalled();
    fake.orgAccounts.suspend.mockResolvedValueOnce(false);
    expect((await call({ suspended: true })).status).toBe(404);
  });

  it("outbound: a non-admin is 403 and nothing is previewed or signed; only the code is entered", async () => {
    const call = (body: unknown) => OUTBOUND(req("/api/v1/orgs/outbound", "POST", body));
    const CODE = `${"e".repeat(60)}.${"s".repeat(43)}`;
    fake.adminCheck.mockResolvedValueOnce("denied");
    expect((await call({ step: "preview", code: CODE })).status).toBe(403);
    fake.adminCheck.mockResolvedValueOnce("unavailable");
    expect((await call({ step: "preview", code: CODE })).status).toBe(503);
    expect(fake.orgAccounts.previewOutbound).not.toHaveBeenCalled();
    expect(fake.orgAccounts.signOutbound).not.toHaveBeenCalled();
    // The old shape (an origin, a node id and an org id typed by the admin) is no longer accepted.
    expect((await call({ act: "link", targetOrigin: "https://x.example", targetNodeId: "n", orgUserId: "o", code: CODE, services: ["node-ai"] })).status).toBe(400);
  });

  it("outbound preview returns the org name and origin; link needs the confirmed name; every refusal has its status", async () => {
    const call = (body: unknown) => OUTBOUND(req("/api/v1/orgs/outbound", "POST", body));
    const CODE = `${"e".repeat(60)}.${"s".repeat(43)}`;
    fake.orgAccounts.previewOutbound.mockResolvedValueOnce({ ok: true, preview: { orgName: "toks5", origin: "https://node-template.example" } });
    const preview = await call({ step: "preview", code: CODE });
    expect(await preview.json()).toEqual({ step: "preview", orgName: "toks5", origin: "https://node-template.example" });
    expect(fake.orgAccounts.previewOutbound).toHaveBeenCalledWith(CODE);

    expect((await call({ step: "link", code: CODE, services: ["node-ai"] })).status).toBe(400); // no confirmed name
    expect((await call({ step: "link", code: CODE, expectOrgName: "toks5", services: [] })).status).toBe(400);
    fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: true, httpStatus: 201, error: null, act: "link" });
    const linked = await call({ step: "link", code: CODE, expectOrgName: "toks5", services: ["node-ai"] });
    expect(await linked.json()).toEqual({ step: "link", httpStatus: 201, error: null, act: "link" });
    expect(fake.orgAccounts.signOutbound).toHaveBeenLastCalledWith({ act: "link", code: CODE, expectOrgName: "toks5", services: ["node-ai"] });
    fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: true, httpStatus: 200, error: null, act: "unlink" });
    expect((await call({ step: "unlink", code: CODE })).status).toBe(200);
    expect(fake.orgAccounts.signOutbound).toHaveBeenLastCalledWith({ act: "unlink", code: CODE });

    for (const [reason, status] of [["invalid_code", 400], ["code_not_found", 404], ["preview_mismatch", 502], ["preview_changed", 409], ["no_signer", 503], ["unreachable", 502]] as const) {
      fake.orgAccounts.signOutbound.mockResolvedValueOnce({ ok: false, reason });
      expect((await call({ step: "link", code: CODE, expectOrgName: "toks5", services: ["node-ai"] })).status, reason).toBe(status);
    }
  });
});

describe("POST /api/v1/public/orgs/link-preview (public)", () => {
  const preview = (body: unknown) => LINK_PREVIEW(req("/api/v1/public/orgs/link-preview", "POST", body));

  it("a valid code in the BODY answers the org's name and this node's origin and nothing else", async () => {
    fake.orgAccounts.previewCode.mockResolvedValueOnce({ orgName: "toks5", origin: "https://node-template.example" });
    const res = await preview({ code: "abc.def" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgName: "toks5", origin: "https://node-template.example" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fake.orgAccounts.previewCode).toHaveBeenCalledWith("abc.def");
  });

  it("an unknown code, a missing or malformed body and an over-long code are ONE answer, 404 not_found, and the bad ones are never looked up", async () => {
    fake.orgAccounts.previewCode.mockResolvedValueOnce(null);
    const unknown = await preview({ code: "x.y" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    fake.orgAccounts.previewCode.mockClear();
    for (const bad of [{}, { code: "" }, { code: 5 }, { code: "a".repeat(701) }, { code: "a.b", extra: 1 }, null]) expect((await preview(bad)).status, JSON.stringify(bad)).toBe(404);
    expect((await LINK_PREVIEW(new NextRequest("http://localhost/api/v1/public/orgs/link-preview", { method: "POST", body: "not json" }))).status).toBe(404);
    expect(fake.orgAccounts.previewCode).not.toHaveBeenCalled();
  });

  it("a code in a URL is not read (the code is a body), and a store failure is 503", async () => {
    expect((await LINK_PREVIEW(new NextRequest("http://localhost/api/v1/public/orgs/link-preview?code=abc.def", { method: "POST" }))).status).toBe(404);
    expect(fake.orgAccounts.previewCode).not.toHaveBeenCalled();
    fake.orgAccounts.previewCode.mockRejectedValueOnce(new Error("db down"));
    expect((await preview({ code: "a.b" })).status).toBe(503);
  });
});

describe("lists page (LISTS_PAGE)", () => {
  it("orgs: limit and cursor go to the store, the cursor comes back, a bad limit is 400", async () => {
    fake.orgAccounts.list.mockResolvedValueOnce({
      items: [{ orgUserId: "o1", name: "toks5", billingAccountId: "a1", balanceCredits: 1200, suspendedAt: null, role: "owner" }],
      nextCursor: "o1",
    });
    const res = await LIST(req("/api/v1/orgs?limit=1&cursor=o0", "GET"));
    expect(await res.json()).toEqual({ orgs: [{ orgUserId: "o1", name: "toks5", billingAccountId: "a1", balanceCredits: 1200, suspended: false, role: "owner" }], nextCursor: "o1" });
    expect(fake.orgAccounts.list).toHaveBeenCalledWith("caller-1", { limit: 1, cursor: "o0" });
    expect((await LIST(req("/api/v1/orgs?limit=1000", "GET"))).status).toBe(400);
    expect((await LIST(req("/api/v1/orgs?limit=abc", "GET"))).status).toBe(400);
  });

  it("members, links and invites answer { items, nextCursor }; a stranger is 404 and a bad cursor 400", async () => {
    fake.orgAccounts.members.mockResolvedValueOnce({ items: [{ userId: "u1", name: "alice", wallet: "0xabc", role: "owner", since: "t" }], nextCursor: "c1" });
    const members = await MEMBERS(req("/api/v1/orgs/o1/members?limit=1", "GET"), params({ orgId: "o1" }));
    expect(await members.json()).toEqual({ items: [{ userId: "u1", name: "alice", wallet: "0xabc", role: "owner", since: "t" }], nextCursor: "c1" });
    fake.orgAccounts.members.mockRejectedValueOnce(new OrgError("not_found"));
    expect((await MEMBERS(req("/api/v1/orgs/o1/members", "GET"), params({ orgId: "o1" }))).status).toBe(404);
    fake.orgAccounts.members.mockRejectedValueOnce(new OrgError("invalid_cursor"));
    expect((await MEMBERS(req("/api/v1/orgs/o1/members?cursor=zzz", "GET"), params({ orgId: "o1" }))).status).toBe(400);
    fake.orgAccounts.links.mockRejectedValueOnce(new OrgError("invalid_cursor"));
    const badLinks = await LINKS(req("/api/v1/orgs/o1/links?cursor=x", "GET"), params({ orgId: "o1" }));
    expect(badLinks.status).toBe(400);
    expect(await badLinks.json()).toEqual({ error: "invalid_cursor" });
    fake.orgAccounts.links.mockResolvedValueOnce({ items: [{ id: "l1", orgUserId: "o1", issuer: "https://x.example", services: ["node-ai"], createdAt: "t" }], nextCursor: null });
    const links = await LINKS(req("/api/v1/orgs/o1/links", "GET"), params({ orgId: "o1" }));
    expect(await links.json()).toEqual({ items: [{ id: "l1", issuer: "https://x.example", services: ["node-ai"], createdAt: "t" }], nextCursor: null });
    fake.orgAccounts.myInvites.mockResolvedValueOnce({ items: [{ id: "i1", orgUserId: "o1", orgName: "toks5", role: "admin", invitedBy: "u1", expiresAt: "t" }], nextCursor: null });
    expect(await (await MINE(req("/api/v1/orgs/invites/mine", "GET"))).json()).toEqual({ invites: [{ id: "i1", orgUserId: "o1", orgName: "toks5", role: "admin", expiresAt: "t" }], nextCursor: null });
  });

  it("a racing unique-index violation is 409 conflict, never a 503", async () => {
    fake.orgAccounts.accept.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    expect((await ACCEPT(req("/api/v1/orgs/invites/i1/accept", "POST"), params({ inviteId: "i1" }))).status).toBe(409);
  });
});

describe("the org view carries the balance and the members' bound wallets", () => {
  it("GET /api/v1/orgs/{id} answers balanceCredits and this month's spend (computed in SQL, not summed in the browser), and each member's wallet", async () => {
    fake.orgAccounts.view.mockResolvedValueOnce({
      org: { orgUserId: "o1", name: "toks5", billingAccountId: "a1", balanceCredits: 4200, spentThisMonthCredits: 310, suspendedAt: null },
      role: "owner",
      members: { items: [{ userId: "u1", name: "alice", wallet: "0xabc", role: "owner", since: "t" }, { userId: "u2", name: "bob", wallet: null, role: "admin", since: "t" }], nextCursor: null },
      links: { items: [], nextCursor: null },
    });
    const res = await VIEW(req("/api/v1/orgs/o1", "GET"), params({ orgId: "o1" }));
    expect(await res.json()).toEqual({
      org: { orgUserId: "o1", name: "toks5", billingAccountId: "a1", balanceCredits: 4200, spentThisMonthCredits: 310, suspended: false },
      role: "owner",
      members: { items: [{ userId: "u1", name: "alice", wallet: "0xabc", role: "owner", since: "t" }, { userId: "u2", name: "bob", wallet: null, role: "admin", since: "t" }], nextCursor: null },
      links: { items: [], nextCursor: null },
    });
  });
});
