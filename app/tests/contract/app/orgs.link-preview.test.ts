// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/orgs.link-preview`
 * Purpose: Contract tests for POST /api/v1/public/orgs/link-preview (task.0181): the public preview of a link code. An ANONYMOUS request (no cookie, no bearer) reaches the handler through
 *   the real public wrapper; the answer is the org's name and this node's origin and nothing else; every other case is one 404; the code is read from the body, never from a URL.
 * Scope: HTTP behavior over a mocked container (no database, no network).
 * Invariants: PREVIEW_SAYS_LITTLE, CODE_IN_THE_BODY, BOUNDED, rate limited per IP (a limited caller never reaches the lookup).
 * Side-effects: none (fully mocked)
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ previewCode: vi.fn(), consume: vi.fn() }));

vi.mock("@/bootstrap/container", () => {
  const log = { child: vi.fn(() => log), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-01-01T00:00:00Z")) },
      config: { rateLimitBypass: { enabled: false, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
      orgAccounts: { previewCode: fake.previewCode },
    })),
  };
});
vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: (...args: unknown[]) => fake.consume(...args) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

import { POST } from "@/app/api/v1/public/orgs/link-preview/route";

/** No cookie and no Authorization header: an anonymous caller. */
const anonymous = (body: unknown, url = "http://localhost:3000/api/v1/public/orgs/link-preview") =>
  POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("POST /api/v1/public/orgs/link-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.consume.mockReturnValue(true);
  });

  it("an anonymous request reaches the handler and gets the org's name and this node's origin, nothing else", async () => {
    fake.previewCode.mockResolvedValueOnce({ orgName: "toks5", origin: "https://node-template.example" });
    const res = await anonymous({ code: "abc.def" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgName: "toks5", origin: "https://node-template.example" });
    expect(res.headers.get("cache-control")).toContain("max-age=0"); // a POST answer is never cached
    expect(fake.previewCode).toHaveBeenCalledWith("abc.def");
  });

  it("an unknown code, a malformed body and an over-long code are ONE answer, 404 not_found, and the bad ones never reach the lookup", async () => {
    fake.previewCode.mockResolvedValueOnce(null);
    const unknown = await anonymous({ code: "x.y" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    fake.previewCode.mockClear();
    for (const bad of [{}, { code: "" }, { code: "a".repeat(701) }, { code: "a.b", extra: 1 }, "not json"]) expect((await anonymous(bad)).status).toBe(404);
    expect(fake.previewCode).not.toHaveBeenCalled();
  });

  it("the code is a body, never a URL: a code in the query string is not read", async () => {
    expect((await anonymous({}, "http://localhost:3000/api/v1/public/orgs/link-preview?code=abc.def")).status).toBe(404);
    expect(fake.previewCode).not.toHaveBeenCalled();
  });

  it("a rate-limited caller never reaches the lookup, and a store failure is 503", async () => {
    fake.consume.mockReturnValue(false);
    expect((await anonymous({ code: "abc.def" })).status).toBe(429);
    expect(fake.previewCode).not.toHaveBeenCalled();
    fake.consume.mockReturnValue(true);
    fake.previewCode.mockRejectedValueOnce(new Error("db down"));
    expect((await anonymous({ code: "abc.def" })).status).toBe(503);
  });
});
