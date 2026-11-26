// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/orgs.connect`
 * Purpose: Contract tests for POST /api/v1/public/orgs/connect (task.0181): only a verified org-connect assertion with the connect scope connects the org it names, and the answer is
 *   the account's status.
 * Scope: HTTP behavior over a mocked container (no database, no network). Each test names a way an org could be connected by the wrong caller: no bearer, a service assertion made
 *   for something else (a knowledge read), a disconnect scope used to connect, and a statement this node cannot read.
 * Invariants: The route never takes the org's origin from the body: it is the verified issuer.
 * Side-effects: none (fully mocked)
 */

import { OwnerSourceUnavailableError } from "@cogni/agent-grants/orgs";
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

import { POST } from "@/app/api/v1/public/orgs/connect/route";

const ORIGIN = "https://toks5.example.com";
const verified = (over: Record<string, unknown> = {}) => ({ ok: true, issuer: ORIGIN, service: "org-connect", clientId: `${ORIGIN}#org-connect`, scope: "org:connect", jti: "j", ...over });
const call = (authorization: string | null = "Bearer a.b.c") =>
  POST(new NextRequest("http://localhost:3000/api/v1/public/orgs/connect", { method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ origin: "https://evil.example.com" }) }));

describe("POST /api/v1/public/orgs/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.verifyOrgCall.mockResolvedValue(verified());
    fake.connectOrg.mockResolvedValue({ applied: true, version: 1_790_000_000, orgUserId: "o1", billingAccountId: "b1", status: "connected", reason: null });
  });

  it("connects the verified issuer's origin, never an origin named in the body, and answers the status", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected", reason: null, applied: true, version: 1_790_000_000 });
    expect(fake.connectOrg).toHaveBeenCalledWith(ORIGIN);
  });

  it("answers a suspended account with its status and reason, so the org's governance page can show it", async () => {
    fake.connectOrg.mockResolvedValue({ applied: true, version: 1_790_000_000, orgUserId: "o1", billingAccountId: "b1", status: "suspended", reason: "chargeback" });
    expect(await (await call()).json()).toEqual({ status: "suspended", reason: "chargeback", applied: true, version: 1_790_000_000 });
  });

  it("says a statement older than the one held was NOT applied and which version is held, so the org never records an acknowledgement for it", async () => {
    fake.connectOrg.mockResolvedValue({ applied: false, version: 1_800_000_000, orgUserId: "o1", billingAccountId: "b1", status: "connected", reason: null });
    expect(await (await call()).json()).toEqual({ status: "connected", reason: null, applied: false, version: 1_800_000_000 });
  });

  it("no bearer, a refused assertion, another service's assertion or the disconnect scope is 401 and connects nothing; unreachable keys are 503", async () => {
    expect((await call(null)).status).toBe(401);
    fake.verifyOrgCall.mockResolvedValue({ ok: false, code: "replayed" });
    expect((await call()).status).toBe(401);
    fake.verifyOrgCall.mockResolvedValue(verified({ service: "node-ai", scope: "knowledge:read" }));
    expect((await call()).status).toBe(401);
    fake.verifyOrgCall.mockResolvedValue(verified({ scope: "org:disconnect" }));
    expect((await call()).status).toBe(401);
    expect(fake.connectOrg).not.toHaveBeenCalled();
    fake.verifyOrgCall.mockResolvedValue({ ok: false, code: "jwks_unavailable" });
    expect((await call()).status).toBe(503);
  });

  it("is 502 when the org's statement cannot be read or verified, and creates nothing", async () => {
    fake.connectOrg.mockRejectedValue(new OwnerSourceUnavailableError("bad_signature"));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "statement_unavailable", reason: "bad_signature" });
  });
});
