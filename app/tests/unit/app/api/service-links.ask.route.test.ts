// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/service-links.ask.route`
 * Purpose: POST /api/v1/service-links/ask (story.0038 phase 2): only a node admin (the one admin check) starts the ask, a non-admin is 403 and nothing is signed or sent, an unreadable
 *   admin check is 503, no signing key is 503 `signer_unavailable`, an unknown alias is 404 `unknown_alias`, and an admin's ask returns the target's answer.
 * Scope: The real route handler over the real `createServiceLinks` with a fake container; no database, no network except an injected fetch.
 * Side-effects: none
 */

import type { ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import { NextRequest, type NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceLinks } from "@/bootstrap/service-links";

const fake = vi.hoisted(() => ({
  adminCheck: vi.fn(),
  links: undefined as unknown,
}));

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_o: unknown, handler: (ctx: unknown, request: Request, user: unknown) => Promise<NextResponse>) =>
    (request: Request) =>
      handler({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, request, { id: "caller-1", via: "session" }),
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    agentAuthority: { adminCheck: fake.adminCheck },
    serviceLinks: fake.links,
  }),
}));

import { POST } from "@/app/api/v1/service-links/ask/route";

const TARGETS = [{ alias: "toks5", nodeId: "node-toks5", origin: "https://toks5.example.org" }];
const log = { info: vi.fn(), warn: vi.fn() } as never;
const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/service-links/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined as never
  );
const signer = (): ServiceAssertionSigner =>
  ({ authorizationHeader: vi.fn(async () => "Bearer signed"), sign: vi.fn(), jwks: vi.fn() }) as unknown as ServiceAssertionSigner;

describe("POST /api/v1/service-links/ask", () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "pending" }), { status: 201 }));

  beforeEach(() => {
    vi.clearAllMocks();
    fake.adminCheck.mockResolvedValue("allow");
    fake.links = createServiceLinks({ targets: TARGETS, signer: async () => signer(), log, fetchImpl: fetchImpl as unknown as typeof fetch });
  });

  it("a non-admin is 403 and nothing is signed or sent", async () => {
    fake.adminCheck.mockResolvedValue("denied");
    const s = signer();
    fake.links = createServiceLinks({ targets: TARGETS, signer: async () => s, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await call({ alias: "toks5", scope: "knowledge:read" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "authz_denied" });
    expect(s.authorizationHeader).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.adminCheck).toHaveBeenCalledWith("caller-1");
  });

  it("an admin check that cannot answer is 503 and nothing is sent", async () => {
    fake.adminCheck.mockResolvedValue("unavailable");
    expect((await call({ alias: "toks5", scope: "knowledge:read" })).status).toBe(503);
    fake.adminCheck.mockRejectedValue(new Error("roster down"));
    const res = await call({ alias: "toks5", scope: "knowledge:read" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("with no signing key it is 503 signer_unavailable and nothing is sent unsigned", async () => {
    fake.links = createServiceLinks({ targets: TARGETS, signer: async () => null, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await call({ alias: "toks5", scope: "knowledge:read" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "signer_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an alias the deployment does not list is 404 unknown_alias, before any signing", async () => {
    const s = signer();
    fake.links = createServiceLinks({ targets: TARGETS, signer: async () => s, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await call({ alias: "nope", scope: "knowledge:read" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_alias" });
    expect(s.authorizationHeader).not.toHaveBeenCalled();
    // A deployment with no targets at all refuses every alias the same way.
    fake.links = createServiceLinks({ targets: [], signer: async () => s, log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await call({ alias: "toks5", scope: "knowledge:read" })).status).toBe(404);
  });

  it("an admin's ask returns the target's answer; a bad body is 400", async () => {
    const res = await call({ alias: "toks5", scope: "knowledge:read" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alias: "toks5", status: "pending", httpStatus: 201 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await call({ alias: "https://evil.example", scope: "knowledge:read" })).status).toBe(400);
    expect((await call({ alias: "toks5" })).status).toBe(400);
  });
});
