// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/agent-me.route`
 * Purpose: GET /api/v1/agent/me answers the same for a session and a bearer: wallets, the one admin check, live grants only.
 * Scope: Route handler with a faked container. Does not touch a database.
 * Invariants: ONE_ADMIN_CHECK, OWN_DATA_ONLY, FAIL_CLOSED_NON_DISCLOSING.
 * Side-effects: none
 * Links: src/app/api/v1/agent/me/route.ts
 * @internal
 */

import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  user: null as unknown,
  boundWallets: vi.fn(),
  adminCheck: vi.fn(),
  listOwnAccess: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: fake.log }, request, fake.user),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { boundWallets: fake.boundWallets, adminCheck: fake.adminCheck, listOwnAccess: fake.listOwnAccess },
  }),
}));

import { GET } from "@/app/api/v1/agent/me/route";

const call = () => GET(new NextRequest("http://localhost/api/v1/agent/me"), undefined as never);
const user = (id: string, via: "session" | "bearer") => ({ id, walletAddress: null, displayName: null, avatarColor: null, via });

beforeEach(() => {
  vi.clearAllMocks();
  fake.boundWallets.mockResolvedValue([]);
  fake.adminCheck.mockResolvedValue("denied");
  fake.listOwnAccess.mockResolvedValue([
    { scope: "knowledge:contribute", state: "granted", at: "2026-11-17T00:00:00.000Z", accountId: null },
    { scope: "work_item:transition", state: "pending", at: "2026-11-17T00:00:00.000Z", accountId: null },
    { scope: "account:read", state: "revoked", at: "2026-11-16T00:00:00.000Z", accountId: "acct-1" },
  ]);
});

describe("GET /api/v1/agent/me", () => {
  it("a bearer reads its kind, wallets, the one admin check and only its live grants", async () => {
    fake.user = user("agent-1", "bearer");
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      userId: "agent-1",
      kind: "agent",
      via: "bearer",
      wallets: [],
      isAdmin: false,
      grants: [{ scope: "knowledge:contribute", accountId: null, since: "2026-11-17T00:00:00.000Z" }],
    });
    expect(fake.adminCheck).toHaveBeenCalledWith("agent-1");
  });

  it("a session admin gets isAdmin from the same check, on its own user id", async () => {
    fake.user = user("admin-1", "session");
    fake.boundWallets.mockResolvedValue(["0xabc"]);
    fake.adminCheck.mockResolvedValue("allow");
    expect(await (await call()).json()).toMatchObject({ kind: "human", via: "session", wallets: ["0xabc"], isAdmin: true });
    expect(fake.adminCheck).toHaveBeenCalledWith("admin-1");
  });

  it("an admin or store outage is 503 authz_unavailable, never a partial answer", async () => {
    fake.user = user("agent-1", "bearer");
    fake.adminCheck.mockResolvedValue("unavailable");
    expect((await call()).status).toBe(503);
    fake.adminCheck.mockRejectedValue(new Error("down"));
    expect((await call()).status).toBe(503);
  });
});
