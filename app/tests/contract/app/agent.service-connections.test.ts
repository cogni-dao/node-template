// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.service-connections`
 * Purpose: Contract tests for POST /api/v1/public/agent/service-connections (story.0038, connect from home): a signed assertion of service `node-connect` carries `act`, `cap` and `seq`.
 * Scope: HTTP behavior over a mocked container (no database, no network): no bearer, an unlisted issuer, a bad, expired or replayed assertion and a service other than node-connect are 401 and
 *   NOTHING is applied; an unreachable key set or a store failure is 503; a stale seq is 409 with the stored seq; bad claims 400; a connect and a disconnect are 200 with the record's status, cap and seq.
 * Invariants: TRUSTED_HOMES_ONLY (the record is created only after the verifier said ok), ONLY_NODE_CONNECT, CONNECT_IS_ORDERED, NOTHING_IS_GRANTED (the answer carries no permission, key or token).
 * Side-effects: none (fully mocked)
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ verify: vi.fn(), apply: vi.fn() }));

vi.mock("@/bootstrap/container", () => {
  const log = { child: vi.fn(() => log), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { rateLimitBypass: { enabled: true, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
      serviceAuth: { verify: fake.verify },
      connections: { apply: fake.apply },
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

import { POST } from "@/app/api/v1/public/agent/service-connections/route";

const verified = {
  ok: true,
  issuer: "https://toks5-test.cognidao.org",
  service: "node-connect",
  clientId: "https://toks5-test.cognidao.org#node-connect",
  scope: "connection:write",
  jti: "j",
  claims: { act: "connect", cap: 1000, seq: 3 },
};
const call = (authorization: string | null = "Bearer a.b.c", body: unknown = {}) =>
  POST(
    new NextRequest("http://localhost:3000/api/v1/public/agent/service-connections", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    })
  );

describe("POST /api/v1/public/agent/service-connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.verify.mockResolvedValue(verified);
    fake.apply.mockResolvedValue({ ok: true, act: "connect", record: { status: "connected", cap: 1000, seq: 3, suspended: false } });
  });

  it("a connect is 200 with the record's status, cap and seq, never its suspension, and applies the VERIFIED assertion only", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected", cap: 1000, seq: 3 });
    expect(fake.apply).toHaveBeenCalledWith(verified);
  });

  it("a disconnect is 200 with status disconnected and the kept cap", async () => {
    fake.apply.mockResolvedValue({ ok: true, act: "disconnect", record: { status: "disconnected", cap: 1000, seq: 4, suspended: true } });
    expect(await (await call()).json()).toEqual({ status: "disconnected", cap: 1000, seq: 4 });
  });

  it("the body is ignored: the signed claims are the request, so an edited body changes nothing", async () => {
    await call("Bearer a.b.c", { act: "connect", cap: 999999999, seq: 99 });
    expect(fake.apply).toHaveBeenCalledWith(verified);
  });

  it("no bearer, or any refused assertion (unlisted issuer, unlisted service, bad signature, expired, replayed), is 401 and applies nothing", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("Basic abc")).status).toBe(401);
    for (const code of ["untrusted_issuer", "service_not_allowed", "bad_signature", "wrong_audience", "expired", "replayed", "malformed"]) {
      fake.verify.mockResolvedValue({ ok: false, code });
      const res = await call();
      expect(res.status, code).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it("an assertion of any other service is 401 here, even when it verified", async () => {
    fake.verify.mockResolvedValue({ ...verified, service: "node-ai", scope: "knowledge:read" });
    expect((await call()).status).toBe(401);
    expect(fake.apply).not.toHaveBeenCalled();
  });

  it("an unreachable key set or a store failure is 503 authz_unavailable", async () => {
    fake.verify.mockResolvedValue({ ok: false, code: "jwks_unavailable" });
    expect((await call()).status).toBe(503);
    fake.verify.mockRejectedValue(new Error("replay store down"));
    expect((await call()).status).toBe(503);
    fake.verify.mockResolvedValue(verified);
    fake.apply.mockRejectedValue(new Error("db down"));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });

  it("a stale seq is 409 with the stored seq (the signer is the record's own customer); bad claims are 400; a wrong scope is 400", async () => {
    fake.apply.mockResolvedValue({ ok: false, code: "stale_seq", seq: 9 });
    const stale = await call();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_seq", seq: 9 });
    fake.apply.mockResolvedValue({ ok: false, code: "seq_jump", seq: 5 });
    const jump = await call();
    expect(jump.status).toBe(409);
    expect(await jump.json()).toEqual({ error: "seq_jump", seq: 5 });
    fake.apply.mockResolvedValue({ ok: false, code: "invalid_claims" });
    expect(await (await call()).json()).toEqual({ error: "invalid_claims" });
    fake.apply.mockResolvedValue({ ok: false, code: "wrong_scope" });
    expect((await call()).status).toBe(400);
    fake.apply.mockResolvedValue({ ok: false, code: "wrong_service" });
    expect((await call()).status).toBe(401);
  });
});
