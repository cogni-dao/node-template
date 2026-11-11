// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.recover`
 * Purpose: Contract tests for the PUBLIC key recovery, POST /api/v1/public/agent/recover (task.0091): a bound agent with no key proves its GitHub account and
 *   gets ONE active key on the SAME users.id.
 * Scope: The real route, wrapPublicRoute, route shell and package service over the package's memory store. Fakes: the store, GitHub (a scripted comment
 *   reader), the per-challenge limiter, the container. No network, no database.
 * Invariants: the key is returned once, `no-store`, and never logged; replay is 401; a stopped agent is 403 and consumes nothing; GitHub down is 503 and consumes nothing.
 * Side-effects: none
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CommentRead,
  confirmCredential,
  issueProofChallenge,
  liftPrincipalStop,
  revokePrincipalCredentials,
  upgradeSignedKey,
  verifyBearer,
} from "@cogni/agent-grants/credentials";
import { memoryCredentialStore } from "../../../../packages/agent-grants/tests/credentials-memory-store";

const ISSUE = "cogni-dao/proof-issues#1";
const GITHUB_ID = 295942454;
const USER = "agent-recover-1";
const ADMIN = "node-admin-1";

const fake = vi.hoisted(() => ({
  memory: undefined as unknown as { store: unknown; outage: { failing: boolean; failOn: string | null } },
  read: { kind: "not_found" } as { kind: string },
  admit: true,
  misses: 0,
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
  getProofConfig: () => ({ nodeId: "node-under-test", issues: ["cogni-dao/proof-issues#1"] }),
  getProofVerifier: () => ({ fetchComment: async () => fake.read }),
  proofAttemptGuards: () => ({
    admit: () => fake.admit,
    onInvalid: () => {
      fake.misses += 1;
    },
  }),
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => undefined,
  proofPublicRateLimit: { limiter: { consume: () => true }, clientKey: () => "test-client" },
}));

import { POST } from "@/app/api/v1/public/agent/recover/route";

const recover = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/public/agent/recover", { method: "POST", headers: { "x-stack-test": "1" }, body: JSON.stringify(body) }), undefined as never);
const store = () => fake.memory.store as Parameters<typeof upgradeSignedKey>[0];
const events = () => [...log.info.mock.calls, ...log.warn.mock.calls].map((c) => (c[0] as { event?: string }).event).filter((e) => e?.startsWith("agent."));

/** A challenge and the comment that proves it, by the account `githubId`. */
async function challengeWithComment(githubId = GITHUB_ID) {
  const ch = await issueProofChallenge(store(), { nodeId: "node-under-test", issues: [ISSUE], purpose: "recover" });
  if (!ch.ok) throw new Error("challenge refused");
  const at = new Date(Date.parse(ch.expiresAt) - 600_000 + 1000).toISOString();
  const read: CommentRead = {
    kind: "found",
    comment: {
      issueUrl: "https://api.github.com/repos/cogni-dao/proof-issues/issues/1",
      userId: githubId,
      login: "agent-account",
      userType: "User",
      body: ch.proofLine,
      createdAt: at,
      updatedAt: at,
    },
  };
  fake.read = read;
  return { ch, body: { challengeId: ch.challengeId, challengeSecret: ch.challengeSecret, issue: ISSUE, commentId: 77 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.memory = memoryCredentialStore({ users: { [USER]: { agent: true, githubId: String(GITHUB_ID), roles: true }, [ADMIN]: {} } }) as never;
  fake.read = { kind: "not_found" };
  fake.admit = true;
  fake.misses = 0;
});

describe("POST /api/v1/public/agent/recover", () => {
  it("a bound agent with no working key gets a new active key on the SAME user id; the old key is dead; the key is never cached or logged", async () => {
    const old = await upgradeSignedKey(store(), { userId: USER });
    if (!old.ok) throw new Error("upgrade refused");
    await confirmCredential(store(), { credentialId: old.credentialId });
    const { body } = await challengeWithComment();
    const res = await recover(body);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await res.json();
    expect(out).toMatchObject({ userId: USER, status: "active" });
    expect(await verifyBearer(store(), out.apiKey)).toMatchObject({ ok: true, userId: USER, state: "active" });
    expect(await verifyBearer(store(), old.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(events()).toEqual(["agent.credential.recovered"]);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain(out.apiKey);
    expect(logged).not.toContain(body.challengeSecret);
  });

  it("the challenge is single use: a replay with the same secret is one 401", async () => {
    const { body } = await challengeWithComment();
    expect((await recover(body)).status).toBe(200);
    const again = await recover(body);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "invalid_challenge" });
  });

  it("a wrong secret is 401, spends the per-challenge limiter and reads GitHub zero times; an over-limit client is 429", async () => {
    const { body } = await challengeWithComment();
    const wrong = await recover({ ...body, challengeSecret: "x".repeat(43) });
    expect(wrong.status).toBe(401);
    expect(fake.misses).toBe(1);
    fake.admit = false;
    expect((await recover(body)).status).toBe(429);
  });

  it("an account nobody bound is one uniform 404 no_binding", async () => {
    const { body } = await challengeWithComment(424242);
    const res = await recover(body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_binding" });
  });

  it("an edited comment is 422 proof_failed with a fixed reason", async () => {
    const { body } = await challengeWithComment();
    const read = fake.read as { comment: { updatedAt: string } };
    read.comment.updatedAt = "2099-01-01T00:00:00.000Z";
    const res = await recover(body);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "proof_failed", reason: "comment_edited" });
    expect(log.warn.mock.calls.some((c) => (c[0] as { reason?: string }).reason === "comment_edited")).toBe(true);
  });

  it("GitHub down is 503 proof_unavailable with retry-after, and the challenge still works afterwards", async () => {
    const { body } = await challengeWithComment();
    const good = fake.read;
    fake.read = { kind: "unavailable" };
    const down = await recover(body);
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("30");
    fake.read = good;
    expect((await recover(body)).status).toBe(200);
  });

  it("a stopped agent is 403 stopped and nothing changes; after a lift recovery works", async () => {
    const admin = async (id: string) => (id === ADMIN ? ("allow" as const) : ("denied" as const));
    const stop = { actorUserId: ADMIN, targetUserId: USER, plane: "human" as const };
    await revokePrincipalCredentials(store(), admin, stop);
    const { body } = await challengeWithComment();
    const refused = await recover(body);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "stopped" });
    await liftPrincipalStop(store(), admin, stop);
    expect((await recover(body)).status).toBe(200);
  });

  it("bad bodies are 400; a store outage is 503 authz_unavailable", async () => {
    expect((await recover({})).status).toBe(400);
    expect((await recover({ challengeId: "nope", challengeSecret: "s", issue: ISSUE, commentId: 1 })).status).toBe(400);
    const { body } = await challengeWithComment();
    fake.memory.outage.failing = true;
    const res = await recover(body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });
});
