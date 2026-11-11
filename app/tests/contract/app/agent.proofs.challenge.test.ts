// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.proofs.challenge`
 * Purpose: Contract tests for the PUBLIC recover challenge, POST /api/v1/public/agent/proofs/challenge (task.0091).
 * Scope: The real route, wrapPublicRoute, route shell and package service over the package's memory store (same semantics as the SQL). Fakes: the store, the
 *   per-client limiter, the container. No network, no database.
 * Invariants: the answer is `no-store` and carries the secret once; one terminal event; no secret or nonce in any log line; limits and outages fail toward "no key".
 * Side-effects: none
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryCredentialStore } from "../../../../packages/agent-grants/tests/credentials-memory-store";

const fake = vi.hoisted(() => ({
  memory: undefined as unknown as { store: unknown; outage: { failing: boolean; failOn: string | null } },
  issues: ["cogni-dao/proof-issues#1"] as string[],
  admitAnonymous: true,
}));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/auth/server", () => ({ getServerSessionUser: async () => null }));
vi.mock("@/shared/env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/shared/env/server-env", () => ({ serverEnv: () => MOCK_SERVER_ENV }));
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log,
    clock: { now: () => new Date("2026-11-10T00:00:00Z") },
    config: { rateLimitBypass: { enabled: true, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
  })),
}));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => fake.memory.store,
  getProofConfig: () => ({ nodeId: "node-under-test", issues: fake.issues }),
  admitAnonymousChallenge: () => fake.admitAnonymous,
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => undefined,
  proofPublicRateLimit: { limiter: { consume: () => true }, clientKey: () => "test-client" },
}));

import { POST } from "@/app/api/v1/public/agent/proofs/challenge/route";

const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/v1/public/agent/proofs/challenge", {
      method: "POST",
      headers: { "x-stack-test": "1" },
      body: JSON.stringify(body),
    }),
    undefined as never
  );
const events = () => [...log.info.mock.calls, ...log.warn.mock.calls].map((c) => (c[0] as { event?: string }).event).filter((e) => e?.startsWith("agent."));

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.memory = memoryCredentialStore({ users: {} }) as never;
  fake.issues = ["cogni-dao/proof-issues#1"];
  fake.admitAnonymous = true;
});

describe("POST /api/v1/public/agent/proofs/challenge", () => {
  it("returns a public proof line and a private secret, never cached, with one terminal event and no secret in any log", async () => {
    const res = await call({ purpose: "recover" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.proofLine).toMatch(/^cogni-proof:v1:node-under-test:[0-9a-f-]{36}:[A-Za-z0-9_-]{43}$/);
    expect(body.challengeSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.issues).toEqual(["cogni-dao/proof-issues#1"]);
    expect(events().filter((e) => e === "agent.proof.challenge_issued")).toHaveLength(1);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain(body.challengeSecret);
    expect(logged).not.toContain(body.proofLine.split(":").pop());
  });

  it("only the recover purpose is accepted here (bind has an authenticated route); bad bodies are 400", async () => {
    expect((await call({ purpose: "bind" })).status).toBe(400);
    expect((await call({ purpose: "enroll" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });

  it("a client over its per-IP limit is 429 with retry-after and one agent.proof.refused", async () => {
    fake.admitAnonymous = false;
    const res = await call({ purpose: "recover" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(events()).toEqual(["agent.proof.refused"]);
  });

  it("no proof issues configured is 503 proof_unavailable (fail closed)", async () => {
    fake.issues = [];
    const res = await call({ purpose: "recover" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "proof_unavailable" });
  });

  it("a store outage is 503 authz_unavailable, never a 500", async () => {
    fake.memory.outage.failing = true;
    const res = await call({ purpose: "recover" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });
});
