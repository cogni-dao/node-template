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

import { exportJWK, generateKeyPair, type JWK, createLocalJWKSet, SignJWT } from "jose";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmCredential, verifyBearer } from "@cogni/agent-grants/credentials";
import {
  createEnrollmentTokenVerifier,
  openSealed,
  SERVICE_ENROLLMENT_KIND,
  SERVICE_ENROLLMENT_TYP,
  serviceEnrollmentAudience,
} from "@cogni/agent-grants/enrollment";
import { memoryEnrollmentStore } from "../../../../packages/agent-grants/tests/enrollment-memory-store";

const NODE_ID = "55555555-5555-4555-8555-555555555555";
const ISSUER = "https://home.example";

const fake = vi.hoisted(() => ({
  memory: undefined as unknown as { store: unknown; credentials: unknown },
  verifier: undefined as unknown,
  billingFails: false,
  billing: undefined as unknown as { mock: { calls: unknown[][] } },
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
    clock: { now: () => new Date("2026-11-11T12:00:00Z") },
    config: { rateLimitBypass: { enabled: true, headerName: "x-stack-test", headerValue: "1" }, DEPLOY_ENVIRONMENT: "test", unhandledErrorPolicy: "rethrow" },
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
vi.mock("@/app/_lib/auth/service-enrollment-verifier", () => ({ getEnrollmentTokenVerifier: () => fake.verifier }));
vi.mock("@/bootstrap/agent-enrollment", () => ({
  getAgentEnrollmentStore: () => fake.memory.store,
  getAskableScopes: () => ["knowledge:read", "knowledge:contribute"],
  ensureEnrollmentBillingAccount: async (...args: unknown[]) => {
    (fake.billing.mock.calls as unknown[][]).push(args);
    if (fake.billingFails) throw new Error("billing down");
  },
  enrollmentPublicRateLimit: { limiter: { consume: () => true }, clientKey: () => "test-client" },
}));

import { POST as poll } from "@/app/api/v1/public/agent/service-enrollments/token/route";
import { POST as create } from "@/app/api/v1/public/agent/service-enrollments/route";

const post = (handler: typeof create, path: string, body: unknown) =>
  handler(new NextRequest(`http://localhost/api/v1/public/agent/${path}`, { method: "POST", headers: { "x-stack-test": "1" }, body: JSON.stringify(body) }), undefined as never);
const enroll = (token: string) => post(create, "service-enrollments", { token });
const token = (deviceCode: string) => post(poll, "service-enrollments/token", { deviceCode });
const events = () => [...log.info.mock.calls, ...log.warn.mock.calls].map((c) => (c[0] as { event?: string }).event).filter((e) => e?.startsWith("agent."));
const logged = () => JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);

let signer: Awaited<ReturnType<typeof generateKeyPair>>;
let cnfPublic: JWK;
let cnfPrivate: JWK;
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

async function sign(over: { typ?: string; kind?: string; jti?: string; service?: string } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({
    kind: over.kind ?? SERVICE_ENROLLMENT_KIND,
    jti: over.jti ?? uuid(),
    service: over.service ?? "git-review",
    scopes: ["knowledge:read"],
    cnf: { jwk: { kty: "OKP", crv: "X25519", x: cnfPublic.x } },
  } as never)
    .setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: over.typ ?? SERVICE_ENROLLMENT_TYP })
    .setIssuer(ISSUER)
    .setAudience(serviceEnrollmentAudience(NODE_ID))
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(signer.privateKey);
}

let memory: ReturnType<typeof memoryEnrollmentStore>;

beforeEach(async () => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  signer = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const cnf = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
  cnfPublic = await exportJWK(cnf.publicKey);
  cnfPrivate = await exportJWK(cnf.privateKey);
  memory = memoryEnrollmentStore();
  fake.memory = memory;
  fake.billingFails = false;
  fake.billing = { mock: { calls: [] } };
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(signer.publicKey)), alg: "EdDSA", kid: "k1" }] });
  fake.verifier = createEnrollmentTokenVerifier({
    nodeId: NODE_ID,
    homes: [{ origin: ISSUER, services: { "git-review": ["knowledge:read"] } }],
    keysFor: () => keys,
  });
});

describe("POST /api/v1/public/agent/service-enrollments", () => {
  it("a signed token becomes a principal, one pending ask and a device code; nothing secret is cached or logged", async () => {
    const jwt = await sign();
    const res = await enroll(jwt);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ deviceCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expires_in: 86_400, interval: 5 });
    expect(memory.principals).toHaveLength(1);
    expect(memory.roles).toEqual([expect.objectContaining({ scope: "knowledge:read", approved: false, revoked: false })]);
    expect(fake.billing.mock.calls).toEqual([[expect.any(String), "git-review@home.example"]]);
    expect(events()).toEqual(["agent.enrollment.requested"]);
    expect(logged()).not.toContain(jwt);
    expect(logged()).not.toContain(body.deviceCode);
  });

  it("TOKEN_ONCE: the same token a second time is 401 replayed_token and creates nothing", async () => {
    const jwt = await sign();
    expect((await enroll(jwt)).status).toBe(200);
    const again = await enroll(jwt);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "replayed_token" });
    expect(memory.principals).toHaveLength(1);
    expect(events()).toEqual(["agent.enrollment.requested", "agent.enrollment.replayed"]);
  });

  it("a token with another typ or kind (an identity attestation reused here) is one 401 invalid_token and creates nothing", async () => {
    for (const over of [{ typ: "JWT" }, { kind: "identity.attestation.v1" }]) {
      const res = await enroll(await sign(over));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(memory.principals).toHaveLength(0);
    expect(events()).toEqual(["agent.enrollment.attestation_rejected", "agent.enrollment.attestation_rejected"]);
  });

  it("a service the home may not sign for is 401, and a missing or malformed body is 400", async () => {
    expect((await enroll(await sign({ service: "outreach" }))).status).toBe(401);
    expect((await post(create, "service-enrollments", {})).status).toBe(400);
    expect((await post(create, "service-enrollments", { token: "" })).status).toBe(400);
  });

  it("a billing account that cannot be made is 503 authz_unavailable, never a 401 or a 500", async () => {
    fake.billingFails = true;
    const res = await enroll(await sign());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "authz_unavailable" });
  });

  it("a store outage is 503", async () => {
    fake.memory = { store: memoryEnrollmentStore({ failing: true }).store, credentials: memory.credentials };
    expect((await enroll(await sign())).status).toBe(503);
  });

  it("an issuer whose keys cannot be read is 503 jwks_unavailable (never an accept)", async () => {
    fake.verifier = createEnrollmentTokenVerifier({
      nodeId: NODE_ID,
      homes: [{ origin: ISSUER, services: { "git-review": ["knowledge:read"] } }],
      keysFor: () => async () => {
        throw new Error("jwks down");
      },
    });
    const res = await enroll(await sign());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "jwks_unavailable" });
  });
});

describe("POST /api/v1/public/agent/service-enrollments/token", () => {
  const redeem = async () => {
    const created = await (await enroll(await sign())).json();
    const principalUserId = memory.principals[0]?.userId as string;
    return { deviceCode: created.deviceCode as string, principalUserId };
  };

  it("before the click: 400 authorization_pending, then slow_down inside the interval; both no-store", async () => {
    const { deviceCode } = await redeem();
    const pending = await token(deviceCode);
    expect(pending.status).toBe(400);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ error: "authorization_pending" });
    expect(await (await token(deviceCode)).json()).toEqual({ error: "slow_down" });
  });

  it("KEY_SEALED_TO_CNF: after the click the key comes back sealed; only the cnf private key opens it; the key is never logged; a copied device code gets ciphertext", async () => {
    const { deviceCode, principalUserId } = await redeem();
    memory.approve(principalUserId, "knowledge:read");
    const res = await token(deviceCode);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await res.json();
    expect(out).toMatchObject({ status: "pending", userId: principalUserId, sealedKey: expect.any(String) });
    expect(out.sealedKey.split(".")).toHaveLength(5);
    const apiKey = await openSealed(out.sealedKey, cnfPrivate);
    expect(apiKey).toMatch(/^cogni_ag_sk_v2_/);
    expect(JSON.stringify(out)).not.toContain(apiKey);
    expect(logged()).not.toContain(apiKey);
    expect(logged()).not.toContain(out.sealedKey);
    expect(events()).toContain("agent.enrollment.redeemed");
    expect(events()).toContain("agent.credential.issued");
    // The holder confirms with the key; it is then active, and the device code is spent.
    expect(await verifyBearer(memory.credentials, apiKey, ["pending"])).toMatchObject({ ok: true, userId: principalUserId });
    expect(await confirmCredential(memory.credentials, { credentialId: out.credentialId })).toMatchObject({ ok: true });
    expect(await verifyBearer(memory.credentials, apiKey)).toMatchObject({ ok: true, state: "active" });
    memory.enrollments.forEach((e) => {
      e.lastPolledAt = null;
    });
    const spent = await token(deviceCode);
    expect(spent.status).toBe(400);
    expect(await spent.json()).toEqual({ error: "expired_token" });
  });

  it("a dismissed ask is 400 access_denied with one agent.enrollment.denied line; an unknown code is 400 expired_token", async () => {
    const { deviceCode, principalUserId } = await redeem();
    memory.dismiss(principalUserId, "knowledge:read");
    const denied = await token(deviceCode);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "access_denied" });
    expect(events()).toContain("agent.enrollment.denied");
    const unknown = await token("z".repeat(43));
    expect(await unknown.json()).toEqual({ error: "expired_token" });
    expect(events()).toContain("agent.enrollment.expired");
  });

  it("a malformed body is 400 and a store outage is 503", async () => {
    expect((await post(poll, "service-enrollments/token", {})).status).toBe(400);
    fake.memory = { store: memoryEnrollmentStore({ failing: true }).store, credentials: memory.credentials };
    expect((await token("a".repeat(43))).status).toBe(503);
  });
});
