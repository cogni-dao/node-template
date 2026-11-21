// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/admin-orgs.route`
 * Purpose: GET /api/v1/admin/orgs (task.0181): the node admin's list of every org, through the one mint. A non-admin is 403 with no read, an admin gets `{ orgs, nextCursor }` a page at a
 *   time (at most 100), a bad limit is 400, and a store failure is 503.
 * Scope: The real route and mint over a fake container and session; no database.
 * Side-effects: none
 */

import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  adminCheck: vi.fn(),
  listAll: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ log: fake.log, agentAuthority: { adminCheck: fake.adminCheck }, orgAccounts: { listAll: fake.listAll } }),
}));

import { GET } from "@/app/api/v1/admin/orgs/route";

const get = (query = "") => GET(new NextRequest(`http://localhost/api/v1/admin/orgs${query}`), undefined as never);

beforeEach(() => {
  vi.clearAllMocks();
  fake.user = { id: "admin-1", walletAddress: "0xa", displayName: null, avatarColor: null, via: "session" };
  fake.adminCheck.mockResolvedValue("allow");
});

describe("GET /api/v1/admin/orgs", () => {
  it("an admin lists the orgs a page at a time and gets the cursor back", async () => {
    fake.listAll.mockResolvedValueOnce({ items: [{ orgUserId: "o1", name: "toks5", suspended: false }], nextCursor: "o1" });
    const res = await get("?limit=1&cursor=o0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgs: [{ orgUserId: "o1", name: "toks5", suspended: false }], nextCursor: "o1" });
    expect(fake.listAll).toHaveBeenCalledWith({ limit: 1, cursor: "o0" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a non-admin is 403 and nothing is read; no caller is 401; an unreadable admin check is 503", async () => {
    fake.adminCheck.mockResolvedValueOnce("denied");
    const denied = await get();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "authz_denied" });
    fake.user = null;
    expect((await get()).status).toBe(401);
    fake.user = { id: "admin-1", walletAddress: "0xa", displayName: null, avatarColor: null, via: "session" };
    fake.adminCheck.mockResolvedValueOnce("unavailable");
    expect((await get()).status).toBe(503);
    expect(fake.listAll).not.toHaveBeenCalled();
  });

  it("a page is at most 100: a bigger or bad limit is 400 before any read; a store failure is 503", async () => {
    expect((await get("?limit=101")).status).toBe(400);
    expect((await get("?limit=0")).status).toBe(400);
    expect((await get("?limit=abc")).status).toBe(400);
    expect(fake.listAll).not.toHaveBeenCalled();
    fake.listAll.mockRejectedValueOnce(new Error("db down"));
    expect((await get()).status).toBe(503);
  });
});
