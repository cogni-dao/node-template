// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/orgs.disconnect`
 * Purpose: Contract tests for POST /api/v1/public/orgs/disconnect (task.0181): only a verified org-connect assertion with the disconnect scope ends the connection of the org it names.
 * Scope: HTTP behavior over a mocked container (no database, no network). Each test names a way a connection could be ended by the wrong caller: the connect scope used to disconnect,
 *   another service's assertion, and an org that never connected.
 * Side-effects: none (fully mocked)
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ verifyOrgCall: vi.fn(), connectOrg: vi.fn(), disconnectOrg: vi.fn() }));

vi.mock("@/bootstrap/container", () => {
  const log = { child: vi.fn(() => log), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { rateLimitBypass: { enabled: true, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
      agentAuthority: { verifyOrgCall: fake.verifyOrgCall, connectOrg: fake.connectOrg, disconnectOrg: fake.disconnectOrg },
    })),
  };
});
vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

import { POST } from "@/app/api/v1/public/orgs/disconnect/route";

const ORIGIN = "https://toks5.example.com";
const verified = (over: Record<string, unknown> = {}) => ({ ok: true, issuer: ORIGIN, service: "org-connect", clientId: `${ORIGIN}#org-connect`, scope: "org:disconnect", jti: "j", ...over });
const call = (authorization: string | null = "Bearer a.b.c") =>
  POST(new NextRequest("http://localhost:3000/api/v1/public/orgs/disconnect", { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: "{}" }));

describe("POST /api/v1/public/orgs/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.verifyOrgCall.mockResolvedValue(verified());
    fake.disconnectOrg.mockResolvedValue({ applied: true, version: 1_790_000_000, orgUserId: "o1", billingAccountId: "b1", status: "disconnected", reason: null });
  });

  it("disconnects the verified issuer's origin and answers the status", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "disconnected", reason: null, applied: true, version: 1_790_000_000 });
    expect(fake.disconnectOrg).toHaveBeenCalledWith(ORIGIN);
  });

  it("the connect scope, another service's assertion or no bearer ends nothing", async () => {
    fake.verifyOrgCall.mockResolvedValue(verified({ scope: "org:connect" }));
    expect((await call()).status).toBe(401);
    fake.verifyOrgCall.mockResolvedValue(verified({ service: "node-ai", scope: "org:disconnect" }));
    expect((await call()).status).toBe(401);
    expect((await call(null)).status).toBe(401);
    expect(fake.disconnectOrg).not.toHaveBeenCalled();
  });

  it("an org that never connected is one 404", async () => {
    fake.disconnectOrg.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
