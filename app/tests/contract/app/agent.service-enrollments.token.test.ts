// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.service-enrollments.token`
 * Purpose: Contract tests for POST /api/v1/public/agent/service-enrollments/token on its own (story.0038): the RFC 8628 answers, `no-store` on every one, and the
 *   per-client limiter configured on the route. The full enrollment flow (request, click, sealed key, confirm) is in `agent.service-enrollments.test.ts`.
 * Scope: The real route, wrapPublicRoute and package service over the package's memory store. Fakes: the store, the container. No network, no database.
 * Invariants: every answer is `no-store`; a device code the node never made is `expired_token`; the route uses its own limiter, not the shared public one.
 * Side-effects: none
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryEnrollmentStore } from "../../../../packages/agent-grants/tests/enrollment-memory-store";

const fake = vi.hoisted(() => ({
  memory: undefined as unknown as { store: unknown; credentials: unknown },
  ownLimiter: { consume: vi.fn(() => true) },
  sharedLimiter: { consume: vi.fn(() => true) },
}));
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: async () => null,
}));
vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log,
    clock: { now: () => new Date("2026-11-11T12:00:00Z") },
    config: {
      rateLimitBypass: {
        enabled: false,
        headerName: "x-stack-test",
        headerValue: "1",
      },
      DEPLOY_ENVIRONMENT: "test",
      unhandledErrorPolicy: "rethrow",
    },
  })),
}));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: fake.sharedLimiter,
  extractClientIp: vi.fn(() => "shared-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => fake.memory.credentials,
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => undefined,
}));
vi.mock("@/bootstrap/agent-enrollment", () => ({
  getAgentEnrollmentStore: () => fake.memory.store,
  enrollmentPublicRateLimit: {
    limiter: fake.ownLimiter,
    clientKey: () => "edge-client",
  },
}));

import { POST } from "@/app/api/v1/public/agent/service-enrollments/token/route";

const poll = (body: unknown) =>
  POST(
    new NextRequest(
      "http://localhost/api/v1/public/agent/service-enrollments/token",
      { method: "POST", body: JSON.stringify(body) }
    ),
    undefined as never
  );

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.memory = memoryEnrollmentStore();
  (fake.memory.store as { pollStable?: unknown }).pollStable = async () => ({
    ok: false,
    error: "expired_token",
  });
  fake.ownLimiter.consume.mockReturnValue(true);
});

describe("POST /api/v1/public/agent/service-enrollments/token", () => {
  it("a code the node never made is 400 expired_token, no-store; a malformed code never reaches the store", async () => {
    const unknown = await poll({ deviceCode: "q".repeat(43) });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.json()).toEqual({ error: "expired_token" });
    expect(await (await poll({ deviceCode: "short" })).json()).toEqual({
      error: "expired_token",
    });
  });

  it("an empty body is 400 invalid input and no-store", async () => {
    const res = await poll({});
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid input" });
  });

  it("the route spends its OWN bucket keyed on the edge client, never the shared public one; over the limit is 429", async () => {
    await poll({ deviceCode: "q".repeat(43) });
    expect(fake.ownLimiter.consume).toHaveBeenCalledWith("edge-client");
    expect(fake.sharedLimiter.consume).not.toHaveBeenCalled();
    fake.ownLimiter.consume.mockReturnValue(false);
    const limited = await poll({ deviceCode: "q".repeat(43) });
    expect(limited.status).toBe(429);
  });
});
