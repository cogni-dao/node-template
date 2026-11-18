// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-client` enroll
 * Purpose: The requester's whole protocol as functions over a transport and a signer: start an enrollment, poll the device code (one step or a
 *   loop), open the sealed key, confirm it. The caller decides where the private JWK, the device code and the key are stored.
 * Scope: Orchestration only. No storage, no env, no logging, no `Date` or timer it cannot be given (`now` and `sleep` are injected).
 * Invariants:
 *   - STORAGE_FREE: `startEnrollment` hands back the device code and the private JWK; the caller stores them (encrypted) and discards them once the key is kept.
 *   - POLL_INTERVAL_CLAMPED: the loop waits at least `intervalS` (clamped to 5..60 s), adds 5 s on `slow_down` (RFC 8628) and stops at the clamped expiry.
 *   - TRANSIENT_FAILURES_RETRIED: an unreachable node or a bad body is retried; after `maxTransientFailures` in a row the loop throws.
 *   - CONFIRM_AFTER_STORE: `enrollService` confirms only after it holds the opened key; a caller that stores the key itself calls `confirmKey` after storing.
 * Side-effects: IO through the transport
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import type { JWK } from "jose";

import type { ServiceEnrollmentCnfJwk } from "../claims";
import { generateLinkKeypair, unsealServiceKey } from "./keypair";
import { buildEnrollmentClaims, type EnrollmentSigner } from "./sign";
import { ENROLLMENT_CLIENT_LIMITS, type EnrollmentTransport } from "./transport";

/** Seconds added to the poll interval on `slow_down` (RFC 8628). */
export const SLOW_DOWN_STEP_S = 5;

export interface StartEnrollmentInput {
  readonly transport: Pick<EnrollmentTransport, "postEnrollment">;
  readonly signer: EnrollmentSigner;
  /** The requester's own HTTPS origin (`iss`). */
  readonly issuer: string;
  /** The origin of the node being asked, resolved by the caller from its own registry, never from a request body. */
  readonly origin: string;
  /** The uuid of the node being asked. */
  readonly nodeId: string;
  readonly service: string;
  readonly scope: string;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export interface StartedEnrollment {
  readonly jti: string;
  readonly deviceCode: string;
  /** Clamped: 60..86400. */
  readonly expiresInS: number;
  /** Clamped: 5..60. */
  readonly intervalS: number;
  readonly cnfPublicJwk: ServiceEnrollmentCnfJwk;
  /** Secret. The key is sealed to it; keep it encrypted until the key arrives. */
  readonly cnfPrivateJwk: JWK;
}

/** Make the ephemeral key, sign the claims, post the token. Throws `EnrollmentClientError` when the node refuses or is unreachable. */
export async function startEnrollment(input: StartEnrollmentInput): Promise<StartedEnrollment> {
  const keypair = await generateLinkKeypair();
  const jti = input.newId();
  const claims = buildEnrollmentClaims({
    issuer: input.issuer,
    nodeId: input.nodeId,
    service: input.service,
    scope: input.scope,
    cnfPublicJwk: keypair.publicJwk,
    jti,
    now: (input.now ?? (() => new Date()))(),
  });
  const accepted = await input.transport.postEnrollment(input.origin, await input.signer.sign(claims));
  return { jti, ...accepted, cnfPublicJwk: keypair.publicJwk, cnfPrivateJwk: keypair.privateJwk };
}

export type PollLoopResult =
  | { readonly kind: "issued"; readonly sealedKey: string; readonly credentialId: string; readonly pendingExpiresAt: string }
  | { readonly kind: "access_denied" | "expired_token" | "aborted" };

export interface PollEnrollmentInput {
  readonly transport: Pick<EnrollmentTransport, "pollToken">;
  readonly origin: string;
  readonly deviceCode: string;
  readonly intervalS: number;
  readonly expiresInS: number;
  readonly now?: () => number;
  /** Resolves after `ms`; rejects or resolves early when `signal` aborts. Default: `setTimeout`. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Failures in a row (node unreachable, bad body) before the loop throws. Default 5. */
  readonly maxTransientFailures?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/** Poll the device code until the node issues the key, the admin says no, the code lapses or the caller aborts. */
export async function pollEnrollment(input: PollEnrollmentInput): Promise<PollLoopResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const maxFailures = input.maxTransientFailures ?? 5;
  const { minIntervalS, maxIntervalS, minExpiresInS, maxExpiresInS } = ENROLLMENT_CLIENT_LIMITS;
  const deadline = now() + Math.min(maxExpiresInS, Math.max(minExpiresInS, input.expiresInS)) * 1000;
  let intervalS = Math.min(maxIntervalS, Math.max(minIntervalS, input.intervalS));
  let failures = 0;
  for (;;) {
    if (input.signal?.aborted) return { kind: "aborted" };
    if (now() >= deadline) return { kind: "expired_token" };
    try {
      const result = await input.transport.pollToken(input.origin, input.deviceCode);
      failures = 0;
      if (result.kind === "issued") return result;
      if (result.kind === "access_denied" || result.kind === "expired_token") return { kind: result.kind };
      if (result.kind === "slow_down") intervalS = Math.min(maxIntervalS, intervalS + SLOW_DOWN_STEP_S);
    } catch (error) {
      failures += 1;
      if (failures >= maxFailures) throw error;
    }
    await sleep(intervalS * 1000, input.signal);
  }
}

export type EnrollServiceResult =
  | { readonly ok: true; readonly apiKey: string; readonly credentialId: string }
  | { readonly ok: false; readonly reason: "access_denied" | "expired_token" | "aborted" | "sealed_key_unreadable" | "confirm_not_accepted" };

/**
 * The whole handshake for a caller that has nowhere to persist between steps (a script, a test): start, poll, open, confirm.
 * `store` receives the opened key BEFORE the confirm, so a key the node activated is never lost; it must throw when it cannot keep the key.
 */
export async function enrollService(
  input: StartEnrollmentInput & Omit<PollEnrollmentInput, "origin" | "deviceCode" | "intervalS" | "expiresInS" | "transport"> & {
    readonly transport: EnrollmentTransport;
    readonly store?: (apiKey: string) => Promise<void>;
  }
): Promise<EnrollServiceResult> {
  const started = await startEnrollment(input);
  const polled = await pollEnrollment({ ...input, deviceCode: started.deviceCode, intervalS: started.intervalS, expiresInS: started.expiresInS });
  if (polled.kind !== "issued") return { ok: false, reason: polled.kind };
  let apiKey: string;
  try {
    apiKey = await unsealServiceKey(polled.sealedKey, started.cnfPrivateJwk);
  } catch {
    return { ok: false, reason: "sealed_key_unreadable" };
  }
  await input.store?.(apiKey);
  const confirmed = await input.transport.confirmKey(input.origin, apiKey);
  if (!confirmed.ok) return { ok: false, reason: "confirm_not_accepted" };
  return { ok: true, apiKey, credentialId: polled.credentialId };
}
