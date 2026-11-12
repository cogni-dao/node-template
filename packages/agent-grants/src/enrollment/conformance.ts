// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-conformance`
 * Purpose: The service enrollment conformance suite (SUITE_GATES_RELEASE). Every node that adopts `@cogni-dao/agent-grants/enrollment` runs
 *   these rows over ITS store, so one definition of "a correct enrollment store" gates every adopter and the package release.
 * Scope: Test rows only. The package imports no test runner: the caller passes `describe`, `it` and `expect` (vitest) and a harness that
 *   prepares a store, plays the admin's click, moves time and breaks the store. The package runs the rows over a memory store; a node
 *   runs them over real SQL. Token verification is NOT in these rows (a stub verifier hands over claims); `verify.ts` has its own tests.
 * Invariants: Rows assert behavior through `requestServiceEnrollment`, `pollServiceEnrollment`, `verifyBearer` and `confirmCredential`.
 *   The only harness reads are the three that prove hash-only storage, the lapse and the removal of an unredeemed principal.
 * Side-effects: whatever the harness does
 * @public
 */

import { exportJWK, generateKeyPair, type JWK } from "jose";

import { confirmCredential, revokeCredential, verifyBearer } from "../credentials/service";
import type { CredentialStore } from "../credentials/types";
import { SERVICE_ENROLLMENT_KIND, type ServiceEnrollmentClaims, serviceEnrollmentAudience } from "./claims";
import { openSealed } from "./seal";
import { pollServiceEnrollment, requestServiceEnrollment } from "./service";
import type { EnrollmentStore } from "./types";
import type { EnrollmentTokenVerifier } from "./verify";

// biome-ignore lint/suspicious/noExplicitAny: structural match for vitest's `expect`
type Expect = (value: unknown) => any;

export interface EnrollmentConformanceSetup {
  readonly store: EnrollmentStore;
  readonly credentials: CredentialStore;
  /** The scopes an outside agent can use (the node's `askableScopes`). Includes `knowledge:read`. */
  readonly askableScopes: readonly string[];
  /** The admin's yes on the principal's pending ask. */
  approve(principalUserId: string, scope: string): Promise<void>;
  /** The admin's dismiss of the pending ask. */
  dismiss(principalUserId: string, scope: string): Promise<void>;
  /** The admin switching a live permission off. */
  switchOff(principalUserId: string, scope: string): Promise<void>;
  switchOn(userId: string, scope: string): Promise<void>;
  hasLiveRole(principalUserId: string, scope: string): Promise<boolean>;
  /** Pending (unapproved, unrevoked) asks of this principal. */
  pendingAsks(principalUserId: string, scope: string): Promise<number>;
  /** Make the poll interval of every enrollment pass (the database clock keeps its own time). */
  skipPollInterval(): Promise<void>;
  /** Make every enrollment of this principal lapse (its 24 hour code ended). */
  lapse(principalUserId: string): Promise<void>;
  /** Expire both the pending and confirmed lifetimes of one key without lapsing its enrollment code. */
  expireCredential(credentialId: string): Promise<void>;
  /** Make the principal 25 hours old. */
  ageUnredeemed(principalUserId: string): Promise<void>;
  principalExists(principalUserId: string): Promise<boolean>;
  /** Does ANY stored column equal this device code (plaintext)? Must be false. */
  deviceCodeStoredPlain(deviceCode: string): Promise<boolean>;
  /** Is the sha256 of this device code stored? Must be true. */
  deviceCodeHashStored(deviceCode: string): Promise<boolean>;
  /** The stored `token_hash` of a credential. */
  storedHash(credentialId: string): Promise<string | null>;
  /** A store whose every call throws. */
  broken(): EnrollmentStore;
}

export interface EnrollmentConformanceHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: Expect;
  setup(): Promise<EnrollmentConformanceSetup>;
}

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const ISSUER = "https://home.example";
const SCOPE = "knowledge:read";

let counter = 0;
const uuid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

interface Requester {
  readonly claims: ServiceEnrollmentClaims;
  readonly privateJwk: JWK;
}

/** A requester: claims for one (issuer, service) with a fresh X25519 confirmation key. */
async function requester(options: { service?: string; issuer?: string; jti?: string } = {}): Promise<Requester> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  return {
    claims: {
      iss: options.issuer ?? ISSUER,
      aud: serviceEnrollmentAudience(NODE_ID),
      kind: SERVICE_ENROLLMENT_KIND,
      jti: options.jti ?? uuid(),
      iat: now,
      exp: now + 300,
      service: options.service ?? "git-review",
      scopes: [SCOPE],
      cnf: { jwk: { kty: "OKP", crv: "X25519", x: jwk.x as string } },
    },
    privateJwk: await exportJWK(privateKey),
  };
}

/** The stub verifier: the token IS the claims (JSON). The signature path is `verify.ts`'s own test. */
const stubVerifier: EnrollmentTokenVerifier = async (token) => ({
  ok: true,
  claims: JSON.parse(token) as ServiceEnrollmentClaims,
  home: { origin: ISSUER, services: {} },
});

const token = (r: Requester): string => JSON.stringify(r.claims);

export function runEnrollmentConformance(h: EnrollmentConformanceHarness): void {
  const { describe, it, expect } = h;

  const enroll = async (s: EnrollmentConformanceSetup, r: Requester) => {
    const result = await requestServiceEnrollment(s.store, stubVerifier, { token: token(r), askableScopes: s.askableScopes });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    return result;
  };
  /** Approve then poll to the sealed key; returns the opened key. */
  const redeem = async (s: EnrollmentConformanceSetup, r: Requester, e: Awaited<ReturnType<typeof enroll>>) => {
    await s.approve(e.principalUserId, SCOPE);
    await s.skipPollInterval();
    const polled = await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode });
    if (!polled.ok) throw new Error(`poll: ${polled.error}`);
    return { ...polled, key: await openSealed(polled.sealedKey, r.privateJwk) };
  };

  describe("enrollment conformance: request", () => {
    it("a request makes one external principal, one pending ask and a device code; only the code's hash is stored", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      expect(e.principalCreated).toBe(true);
      expect(e.expiresIn).toBe(86_400);
      expect(e.interval).toBe(5);
      expect(e.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await s.pendingAsks(e.principalUserId, SCOPE)).toBe(1);
      expect(await s.hasLiveRole(e.principalUserId, SCOPE)).toBe(false);
      expect(await s.deviceCodeStoredPlain(e.deviceCode)).toBe(false);
      expect(await s.deviceCodeHashStored(e.deviceCode)).toBe(true);
    });

    it("TOKEN_ONCE: the same token twice is replayed_token and creates nothing", async () => {
      const s = await h.setup();
      const r = await requester();
      const first = await enroll(s, r);
      const again = await requestServiceEnrollment(s.store, stubVerifier, { token: token(r), askableScopes: s.askableScopes });
      expect(again).toEqual({ ok: false, reason: "replayed_token" });
      expect(await s.pendingAsks(first.principalUserId, SCOPE)).toBe(1);
    });

    it("a scope no route can use is invalid_scope and creates nothing", async () => {
      const s = await h.setup();
      const r = await requester();
      const result = await requestServiceEnrollment(s.store, stubVerifier, { token: token(r), askableScopes: ["work_item:transition"] });
      expect(result).toEqual({ ok: false, reason: "invalid_scope" });
    });

    it("a store outage is unavailable (503), never a refusal", async () => {
      const s = await h.setup();
      const r = await requester();
      await expect(requestServiceEnrollment(s.broken(), stubVerifier, { token: token(r), askableScopes: s.askableScopes })).rejects.toMatchObject({
        code: "authz_unavailable",
      });
      await expect(pollServiceEnrollment(s.broken(), { deviceCode: "a".repeat(43) })).rejects.toMatchObject({ code: "authz_unavailable" });
    });
  });

  describe("enrollment conformance: poll", () => {
    it("before the admin's yes the poll is authorization_pending, and a poll inside the interval is slow_down", async () => {
      const s = await h.setup();
      const e = await enroll(s, await requester());
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "authorization_pending" });
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "slow_down" });
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "authorization_pending" });
    });

    it("an unknown or malformed device code is expired_token", async () => {
      const s = await h.setup();
      expect(await pollServiceEnrollment(s.store, { deviceCode: "x".repeat(43) })).toEqual({ ok: false, error: "expired_token" });
      expect(await pollServiceEnrollment(s.store, { deviceCode: "short" })).toEqual({ ok: false, error: "expired_token" });
    });

    it("KEY_SEALED_TO_CNF: after the yes the poll returns a pending key only the cnf private key opens; a copied device code gets ciphertext", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      const stranger = await requester();
      const got = await redeem(s, r, e);
      expect(got.userId).toBe(e.principalUserId);
      expect(got.key).toMatch(/^cogni_ag_sk_v2_/);
      expect(got.sealedKey).not.toContain(got.key);
      await expect(openSealed(got.sealedKey, stranger.privateJwk)).rejects.toThrow();
      // The key is pending: it can confirm, and it opens no ordinary door until it does.
      expect(await verifyBearer(s.credentials, got.key, ["pending"])).toMatchObject({ ok: true, userId: e.principalUserId });
      expect(await verifyBearer(s.credentials, got.key)).toEqual({ ok: false, reason: "invalid" });
      expect(await s.storedHash(got.credentialId)).not.toBe(got.key);
    });

    it("a repeated poll before confirm replaces the pending key", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      const first = await redeem(s, r, e);
      await s.skipPollInterval();
      const polled = await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode });
      if (!polled.ok) throw new Error("second poll refused");
      const second = await openSealed(polled.sealedKey, r.privateJwk);
      expect(second).not.toBe(first.key);
      expect(await verifyBearer(s.credentials, first.key, ["pending"])).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(s.credentials, second, ["pending"])).toMatchObject({ ok: true });
    });

    it("confirm activates the key; the device code is then spent (expired_token)", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      const got = await redeem(s, r, e);
      expect(await confirmCredential(s.credentials, { credentialId: got.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      expect(await verifyBearer(s.credentials, got.key)).toMatchObject({ ok: true, userId: e.principalUserId, state: "active" });
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "expired_token" });
    });

    for (const endedBy of ["revoke", "expiry"] as const) {
      it(`a confirmed code stays spent after credential ${endedBy}, even before its first post-confirm poll`, async () => {
        const s = await h.setup();
        const r = await requester();
        const e = await enroll(s, r);
        const got = await redeem(s, r, e);
        expect(await confirmCredential(s.credentials, { credentialId: got.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
        if (endedBy === "revoke") {
          expect(await revokeCredential(s.credentials, { credentialId: got.credentialId, userId: e.principalUserId, revokedBy: e.principalUserId })).toBe(true);
        } else {
          await s.expireCredential(got.credentialId);
        }
        expect(await verifyBearer(s.credentials, got.key)).toEqual({ ok: false, reason: "invalid" });
        expect(await s.hasLiveRole(e.principalUserId, SCOPE)).toBe(true);
        for (let i = 0; i < 2; i++) {
          await s.skipPollInterval();
          expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "expired_token" });
        }
      });
    }

    it("an expired unconfirmed key can still be replaced through its unspent code", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      const first = await redeem(s, r, e);
      await s.expireCredential(first.credentialId);
      await s.skipPollInterval();
      const next = await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode });
      if (!next.ok) throw new Error(`retry refused: ${next.error}`);
      expect(next.credentialId).not.toBe(first.credentialId);
      const key = await openSealed(next.sealedKey, r.privateJwk);
      expect(await verifyBearer(s.credentials, first.key, ["pending"])).toEqual({ ok: false, reason: "invalid" });
      expect(await confirmCredential(s.credentials, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      expect(await verifyBearer(s.credentials, key)).toMatchObject({ ok: true, userId: e.principalUserId });
    });

    it("a dismissed ask is access_denied, and stays so", async () => {
      const s = await h.setup();
      const e = await enroll(s, await requester());
      await s.dismiss(e.principalUserId, SCOPE);
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "access_denied" });
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "access_denied" });
    });

    it("a permission switched off before the key is handed over is access_denied", async () => {
      const s = await h.setup();
      const e = await enroll(s, await requester());
      await s.approve(e.principalUserId, SCOPE);
      await s.switchOff(e.principalUserId, SCOPE);
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "access_denied" });
    });

    it("a lapsed device code is expired_token and its ask leaves the admin's list", async () => {
      const s = await h.setup();
      const e = await enroll(s, await requester());
      await s.lapse(e.principalUserId);
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "expired_token" });
      expect(await s.pendingAsks(e.principalUserId, SCOPE)).toBe(0);
    });
  });

  describe("enrollment conformance: one principal per issuer and service", () => {
    it("a second enrollment reuses the principal and retains current consent; the older key dies only when the new key confirms", async () => {
      const s = await h.setup();
      const first = await requester();
      const e1 = await enroll(s, first);
      const k1 = await redeem(s, first, e1);
      await confirmCredential(s.credentials, { credentialId: k1.credentialId });
      expect(await s.hasLiveRole(e1.principalUserId, SCOPE)).toBe(true);

      const second = await requester();
      const e2 = await enroll(s, second);
      expect(e2.principalUserId).toBe(e1.principalUserId);
      expect(e2.principalCreated).toBe(false);
      // Consent survives; the old key still authenticates and the old code stays spent.
      expect(await s.hasLiveRole(e1.principalUserId, SCOPE)).toBe(true);
      expect(await s.pendingAsks(e1.principalUserId, SCOPE)).toBe(0);
      expect(await verifyBearer(s.credentials, k1.key)).toMatchObject({ ok: true });
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e1.deviceCode })).toEqual({ ok: false, error: "expired_token" });

      const k2 = await redeem(s, second, e2);
      expect(await verifyBearer(s.credentials, k1.key)).toMatchObject({ ok: true }); // not yet: the new key is only pending
      await confirmCredential(s.credentials, { credentialId: k2.credentialId });
      expect(await verifyBearer(s.credentials, k1.key)).toEqual({ ok: false, reason: "invalid" });
      expect(await verifyBearer(s.credentials, k2.key)).toMatchObject({ ok: true, userId: e1.principalUserId });
    });

    it("four successive approved pending enrollments cannot obstruct the latest confirmation", async () => {
      const s = await h.setup();
      let latest: Awaited<ReturnType<typeof redeem>> | undefined;
      const older: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await requester();
        const e = await enroll(s, r);
        if (latest) older.push(latest.key);
        latest = await redeem(s, r, e);
      }
      if (!latest) throw new Error("missing latest credential");
      expect(await confirmCredential(s.credentials, { credentialId: latest.credentialId })).toMatchObject({ ok: true });
      expect(await verifyBearer(s.credentials, latest.key)).toMatchObject({ ok: true });
      for (const key of older) expect(await verifyBearer(s.credentials, key)).toMatchObject({ ok: false });
    });

    it("another service of the same issuer, and the same service of another issuer, are other principals", async () => {
      const s = await h.setup();
      const a = await enroll(s, await requester({ service: "git-review" }));
      const b = await enroll(s, await requester({ service: "outreach" }));
      const c = await enroll(s, await requester({ service: "git-review", issuer: "https://other.example" }));
      expect(new Set([a.principalUserId, b.principalUserId, c.principalUserId]).size).toBe(3);
    });
  });

  describe("enrollment conformance: caps and clean-up", () => {
    it("the sixth open enrollment is too_many_enrollments; a lapsed code frees its place", async () => {
      const s = await h.setup();
      const made: string[] = [];
      for (let i = 0; i < 5; i++) made.push((await enroll(s, await requester({ service: `svc-${i}` }))).principalUserId);
      const sixth = await requester({ service: "svc-5" });
      expect(await requestServiceEnrollment(s.store, stubVerifier, { token: token(sixth), askableScopes: s.askableScopes })).toEqual({
        ok: false,
        reason: "too_many_enrollments",
      });
      await s.lapse(made[0] as string);
      expect(await requestServiceEnrollment(s.store, stubVerifier, { token: JSON.stringify({ ...sixth.claims, jti: uuid() }), askableScopes: s.askableScopes })).toMatchObject({ ok: true });
    });

    it("the 26th ACTIVE enrolled agent is too_many_agents", async () => {
      const s = await h.setup();
      for (let i = 0; i < 25; i++) {
        const r = await requester({ service: `agent-${i}` });
        const e = await enroll(s, r);
        const key = await redeem(s, r, e);
        await confirmCredential(s.credentials, { credentialId: key.credentialId });
      }
      const result = await requestServiceEnrollment(s.store, stubVerifier, { token: token(await requester({ service: "agent-25" })), askableScopes: s.askableScopes });
      expect(result).toEqual({ ok: false, reason: "too_many_agents" });
    });

    it("RETAINED_IDENTITY: an abandoned principal remains marked after expiry while capacity is reusable", async () => {
      const s = await h.setup();
      const stale = await enroll(s, await requester({ service: "stale" }));
      await s.lapse(stale.principalUserId);
      await s.ageUnredeemed(stale.principalUserId);
      expect(await s.principalExists(stale.principalUserId)).toBe(true);
      await enroll(s, await requester({ service: "fresh" }));
      expect(await s.principalExists(stale.principalUserId)).toBe(true);
    });

    it("approved abandoned operations free active capacity without erasing identity or consent", async () => {
      const s = await h.setup();
      const first = await requester({ service: "retained" });
      const e = await enroll(s, first);
      await s.approve(e.principalUserId, SCOPE);
      await s.lapse(e.principalUserId);
      for (let i = 0; i < 26; i++) {
        const other = await enroll(s, await requester({ service: `inactive-${i}` }));
        await s.lapse(other.principalUserId);
      }
      expect(await s.principalExists(e.principalUserId)).toBe(true);
      expect(await s.hasLiveRole(e.principalUserId, SCOPE)).toBe(true);
      const again = await enroll(s, await requester({ service: "retained" }));
      expect(again.principalUserId).toBe(e.principalUserId);
      expect(await s.pendingAsks(e.principalUserId, SCOPE)).toBe(0);
    });

    it("retained identity250 cap never deletes an older marked principal", async () => {
      const s = await h.setup();
      for (let i = 0; i < 250; i++) {
        const e = await enroll(s, await requester({ service: `retained-${i}` }));
        await s.lapse(e.principalUserId);
      }
      expect(await requestServiceEnrollment(s.store, stubVerifier, { token: token(await requester({ service: "retained-250" })), askableScopes: s.askableScopes }))
        .toEqual({ ok: false, reason: "too_many_agents" });
      expect((await enroll(s, await requester({ service: "retained-0" }))).principalCreated).toBe(false);
    });

    it("Off pauses an unconfirmed receipt and On resumes it without re-enrollment", async () => {
      const s = await h.setup();
      const r = await requester();
      const e = await enroll(s, r);
      await s.approve(e.principalUserId, SCOPE);
      await s.switchOff(e.principalUserId, SCOPE);
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toEqual({ ok: false, error: "access_denied" });
      await s.switchOn(e.principalUserId, SCOPE);
      await s.skipPollInterval();
      expect(await pollServiceEnrollment(s.store, { deviceCode: e.deviceCode })).toMatchObject({ ok: true });
    });

    it("late approval and first activation cannot cross the receipt deadline", async () => {
      const s = await h.setup();
      const pending = await enroll(s, await requester({ service: "late-approve" }));
      await s.lapse(pending.principalUserId);
      await s.approve(pending.principalUserId, SCOPE);
      expect(await s.hasLiveRole(pending.principalUserId, SCOPE)).toBe(false);
      const r = await requester({ service: "late-confirm" });
      const e = await enroll(s, r);
      const key = await redeem(s, r, e);
      await s.lapse(e.principalUserId);
      expect(await confirmCredential(s.credentials, { credentialId: key.credentialId })).toMatchObject({ ok: false });
      expect(await verifyBearer(s.credentials, key.key)).toMatchObject({ ok: false });
      expect(await s.hasLiveRole(e.principalUserId, SCOPE)).toBe(true);
    });

    it("a principal that holds a key is never removed", async () => {
      const s = await h.setup();
      const r = await requester({ service: "kept" });
      const e = await enroll(s, r);
      const k = await redeem(s, r, e);
      await confirmCredential(s.credentials, { credentialId: k.credentialId });
      await s.lapse(e.principalUserId);
      await s.ageUnredeemed(e.principalUserId);
      await enroll(s, await requester({ service: "other" }));
      expect(await s.principalExists(e.principalUserId)).toBe(true);
    });
  });
}
