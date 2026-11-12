// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.service-enrollments`
 * Purpose: Contract tests for the PUBLIC service enrollment routes (story.0038): POST /api/v1/public/agent/service-enrollments (a signed token becomes a
 *   principal, one pending ask and a device code) and POST .../token (after the admin's click, a pending key SEALED to the token's `cnf.jwk`).
 * Scope: The real routes, wrapPublicRoute, route shell, package service and REAL token verifier (a local JWKS and a test signer) over the package's memory
 *   store. Fakes: the store, the key set, the billing account call, the limiter, the container. No network, no database.
 * Invariants: replay is 401; a wrong typ is 401; the key and the device code are never logged or cached; a copied device code returns ciphertext only; a store or
 *   billing outage is 503, never a 401.
 * Side-effects: none
 */

import {
  createEnrollmentTokenVerifier,
  ENROLLMENT_PROTOCOL,
  type EnrollmentProof,
  intentDigestOf,
  openSealed,
  SERVICE_ENROLLMENT_TYP,
  sealToJwk,
  serviceEnrollmentAudience,
} from "@cogni/agent-grants/enrollment";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "55555555-5555-4555-8555-555555555555";
const ISSUER = "https://home.example";

const fake = vi.hoisted(() => ({
  memory: undefined as unknown as { store: unknown; credentials: unknown },
  verifier: undefined as unknown,
  billingFails: false,
  billing: undefined as unknown as { mock: { calls: unknown[][] } },
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
        enabled: true,
        headerName: "x-stack-test",
        headerValue: "1",
      },
      DEPLOY_ENVIRONMENT: "test",
      unhandledErrorPolicy: "rethrow",
    },
  })),
}));
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));
vi.mock("@/bootstrap/agent-credentials", () => ({
  getAgentCredentialStore: () => fake.memory.credentials,
  admitCredentialLookup: () => true,
  recordCredentialMiss: () => undefined,
}));
vi.mock("@/app/_lib/auth/service-enrollment-verifier", () => ({
  getEnrollmentTokenVerifier: () => fake.verifier,
}));
vi.mock("@/bootstrap/agent-enrollment", () => ({
  getAgentEnrollmentStore: () => fake.memory.store,
  getAskableScopes: () => ["knowledge:read", "knowledge:contribute"],
  ensureEnrollmentBillingAccount: async (...args: unknown[]) => {
    (fake.billing.mock.calls as unknown[][]).push(args);
    if (fake.billingFails) throw new Error("billing down");
  },
  enrollmentPublicRateLimit: {
    limiter: { consume: () => true },
    clientKey: () => "test-client",
  },
}));

import { POST as create } from "@/app/api/v1/public/agent/service-enrollments/route";
import { POST as poll } from "@/app/api/v1/public/agent/service-enrollments/token/route";

const post = (handler: typeof create, path: string, body: unknown) =>
  handler(
    new NextRequest(`http://localhost/api/v1/public/agent/${path}`, {
      method: "POST",
      headers: { "x-stack-test": "1" },
      body: JSON.stringify(body),
    }),
    undefined as never
  );
const enroll = (token: string) =>
  post(create, "service-enrollments", { token });
const token = (deviceCode: string) =>
  post(poll, "service-enrollments/token", { deviceCode });

const logged = () =>
  JSON.stringify([
    ...log.info.mock.calls,
    ...log.warn.mock.calls,
    ...log.error.mock.calls,
  ]);

let signer: Awaited<ReturnType<typeof generateKeyPair>>;
let cnfPublic: JWK, cnfPrivate: JWK;
const home = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  environment: "candidate-a",
  origin: ISSUER,
};
const target = {
  nodeId: NODE_ID,
  environment: "candidate-a",
  origin: "https://target.example",
};
let proof: EnrollmentProof;
let acceptCalls: unknown[];
let pendingError = "authorization_pending";
let stored: Record<string, unknown> | undefined;
async function sign(patch: Record<string, unknown> = {}) {
  return new SignJWT({ ...proof, ...patch })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: "k1",
      typ: SERVICE_ENROLLMENT_TYP,
    })
    .sign(signer.privateKey);
}
beforeEach(async () => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  fake.billingFails = false;
  fake.billing = { mock: { calls: [] } };
  signer = await generateKeyPair("EdDSA");
  const cnf = await generateKeyPair("ECDH-ES", {
    crv: "X25519",
    extractable: true,
  });
  cnfPublic = await exportJWK(cnf.publicKey);
  cnfPrivate = await exportJWK(cnf.privateKey);
  const iat = Math.floor(Date.now() / 1000),
    jti = crypto.randomUUID();
  const intent = {
    kind: ENROLLMENT_PROTOCOL,
    operationId: crypto.randomUUID(),
    generation: 1,
    expectedGeneration: 0,
    expectedOperationId: null,
    home,
    target,
    service: "git-review",
    scopes: ["knowledge:read"],
    cnf: {
      jwk: {
        kty: "OKP" as const,
        crv: "X25519" as const,
        x: cnfPublic.x as string,
      },
    },
    originalStartJti: jti,
    originalStartIat: iat,
    originalStartExp: iat + 600,
  };
  proof = {
    ...intent,
    op: "start",
    intentDigest: await intentDigestOf(intent),
    iss: ISSUER,
    aud: serviceEnrollmentAudience(NODE_ID),
    jti,
    iat,
    exp: iat + 600,
  };
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(signer.publicKey)), kid: "k1", alg: "EdDSA" }],
  });
  fake.verifier = createEnrollmentTokenVerifier({
    nodeId: NODE_ID,
    receiver: target,
    homes: [
      { ...home, kids: ["k1"], services: { "git-review": ["knowledge:read"] } },
    ],
    keysFor: () => keys,
  });
  stored = undefined;
  acceptCalls = [];
  pendingError = "authorization_pending";
  fake.memory = {
    credentials: {},
    store: {
      async acceptProof(p: EnrollmentProof, digest: string) {
        acceptCalls.push({ operationId: p.operationId, digest });
        if (stored) return stored;
        if (p.op === "continue")
          return {
            ok: false,
            reason: "unknown_operation",
            observedAt: new Date().toISOString(),
          };
        stored = {
          ok: true,
          proofOp: p.op,
          principalUserId: "target-principal",
          enrollmentId: crypto.randomUUID(),
          principalCreated: true,
          service: p.service,
          issuer: p.iss,
          scope: p.scopes[0],
          reply: {
            operationId: p.operationId,
            generation: p.generation,
            status: "open",
            credentialId: null,
            credentialState: null,
            observedAt: new Date().toISOString(),
            sealedAcceptance: await sealToJwk(
              JSON.stringify({ marker: "only-the-home-can-open" }),
              p.cnf.jwk
            ),
          },
        };
        return stored;
      },
      async pollStable() {
        return { ok: false, error: pendingError };
      },
    },
  };
});
describe("public v2 enrollment mounts", () => {
  it("returns only the sealed receipt; exact response-loss retry returns identical ciphertext", async () => {
    const jwt = await sign(),
      a = await enroll(jwt),
      body = await a.json(),
      b = await enroll(jwt);
    expect(a.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await b.json()).toEqual(body);
    expect(body.deviceCode).toBeUndefined();
    expect(body.sealedAcceptance).toBeTruthy();
    expect(
      JSON.parse(await openSealed(body.sealedAcceptance, cnfPrivate))
    ).toEqual({ marker: "only-the-home-can-open" });
    expect(logged()).not.toContain(jwt);
    expect(logged()).not.toContain(body.sealedAcceptance);
    expect(acceptCalls).toHaveLength(2);
  });
  it("rejects v1, wrong environment, expired proof and unknown body fields before the provider", async () => {
    for (const patch of [
      { kind: "service.enrollment.v1" },
      { target: { ...target, environment: "production" } },
      { exp: 1 },
    ])
      expect((await enroll(await sign(patch))).status).toBe(401);
    expect(
      (
        await post(create, "service-enrollments", {
          token: await sign(),
          challenge: "not-a-human-door",
        })
      ).status
    ).toBe(400);
    expect(acceptCalls).toHaveLength(0);
  });
  it("accepted-only unknown continuation is404 with receiver time and no creation", async () => {
    const res = await enroll(
      await sign({
        op: "continue",
        originalTokenDigest: "a".repeat(64),
        jti: crypto.randomUUID(),
      })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "unknown_operation",
      observedAt: expect.any(String),
    });
    expect(stored).toBeUndefined();
  });
  it("billing response failure retains the provider acceptance for exact retry", async () => {
    fake.billingFails = true;
    const jwt = await sign();
    expect((await enroll(jwt)).status).toBe(503);
    const ciphertext = (stored?.reply as { sealedAcceptance: string })
      .sealedAcceptance;
    fake.billingFails = false;
    const retried = await enroll(jwt);
    expect((await retried.json()).sealedAcceptance).toBe(ciphertext);
  });
  it("poll pending/Off/terminal answers retain no-store and contain no bearer", async () => {
    for (const error of [
      "authorization_pending",
      "permission_off",
      "access_denied",
      "expired_token",
    ]) {
      pendingError = error;
      const res = await token("a".repeat(43));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error });
    }
  });
});
