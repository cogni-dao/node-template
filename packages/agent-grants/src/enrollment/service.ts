// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` service
 * Purpose: The two operations of a service enrollment on the node being served: request (verify the signed token, make the principal, the ask
 *   and a device code) and poll (after the admin's yes, hand over a pending key sealed to the token's `cnf.jwk`).
 * Scope: Orchestration over an `EnrollmentStore` and an injected token verifier. No HTTP, no env, no logging.
 * Invariants:
 *   - TOKEN_ONCE: a `jti` is accepted once (the store's unique column). A second POST is `replayed_token` and creates nothing.
 *   - NO_SELF_APPROVAL: a request only writes a pending ask. Only an admin session writes the approver. The requester holds no key until the poll.
 *   - DEVICE_CODE_HASH_ONLY: the device code is 32 random bytes shown once; only its sha256 is stored.
 *   - KEY_SEALED_TO_CNF: the key leaves only as a JWE for the token's `cnf.jwk` (`seal.ts`). The device code alone cannot read it.
 *   - ASK_MUST_BE_ASKABLE: the scope must be one an outside agent can use (a route twin exists), as for any ask.
 *   - EVERY_STORE_FAILURE_IS_UNAVAILABLE: a store that throws surfaces as `CredentialStoreUnavailableError` (503), never a 500 or a false 401.
 * Side-effects: IO (store)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { type CredentialPolicy, DEFAULT_CREDENTIAL_POLICY } from "../credentials/types";
import { CredentialStoreUnavailableError, hashAgentKey, mintKey } from "../credentials/service";
import {
  SERVICE_ENROLLMENT_LIMITS,
  servicePrincipalName,
  serviceKeyOf,
} from "./claims";
import { sealToJwk } from "./seal";
import type { CreateEnrollmentRefusal, EnrollmentStore } from "./types";
import type { EnrollmentTokenVerifier } from "./verify";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A device code is exactly 43 base64url characters (32 random bytes). Anything else is refused before a store read. */
export const DEVICE_CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

async function viaStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
}

export type RequestEnrollmentResult =
  | {
      readonly ok: true;
      readonly deviceCode: string;
      readonly expiresIn: number;
      readonly interval: number;
      readonly principalUserId: string;
      readonly enrollmentId: string;
      readonly principalCreated: boolean;
      readonly service: string;
      readonly issuer: string;
      readonly scope: string;
    }
  | { readonly ok: false; readonly reason: "invalid_token" | "jwks_unavailable" | "invalid_scope" | CreateEnrollmentRefusal };

export async function requestServiceEnrollment(
  store: EnrollmentStore,
  verify: EnrollmentTokenVerifier,
  input: {
    readonly token: string;
    /** The scopes an outside agent can use on this node (`askableScopes` of the node's authority). */
    readonly askableScopes: readonly string[];
  }
): Promise<RequestEnrollmentResult> {
  const verified = await verify(input.token);
  if (!verified.ok) return verified;
  const { claims } = verified;
  const scope = claims.scopes[0] as string;
  if (!input.askableScopes.includes(scope)) return { ok: false, reason: "invalid_scope" };
  const deviceCode = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const created = await viaStore(async () =>
    store.createEnrollment({
      claims,
      scope,
      principalName: servicePrincipalName(claims.iss, claims.service),
      serviceKey: serviceKeyOf(claims.iss, claims.service),
      deviceCodeHash: await hashAgentKey(deviceCode),
      limits: SERVICE_ENROLLMENT_LIMITS,
    })
  );
  if (!created.ok) return created;
  return {
    ok: true,
    deviceCode,
    expiresIn: SERVICE_ENROLLMENT_LIMITS.deviceCodeSec,
    interval: SERVICE_ENROLLMENT_LIMITS.pollIntervalSec,
    principalUserId: created.principalUserId,
    enrollmentId: created.enrollmentId,
    principalCreated: created.principalCreated,
    service: claims.service,
    issuer: claims.iss,
    scope,
  };
}

export type PollEnrollmentResult =
  | {
      readonly ok: true;
      /** The key as a compact JWE for the token's `cnf.jwk`. The plaintext is the key string. */
      readonly sealedKey: string;
      readonly credentialId: string;
      readonly userId: string;
      readonly enrollmentId: string;
      readonly pendingExpiresAt: string;
    }
  | { readonly ok: false; readonly error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" };

export async function pollServiceEnrollment(
  store: EnrollmentStore,
  input: { readonly deviceCode: string; readonly policy?: CredentialPolicy }
): Promise<PollEnrollmentResult> {
  if (!DEVICE_CODE_SHAPE.test(input.deviceCode)) return { ok: false, error: "expired_token" };
  const { token, tokenHash } = await mintKey();
  const deviceCodeHash = await hashAgentKey(input.deviceCode);
  const outcome = await viaStore(() =>
    store.poll({
      deviceCodeHash,
      tokenHash,
      policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY,
      intervalSec: SERVICE_ENROLLMENT_LIMITS.pollIntervalSec,
    })
  );
  if (outcome.state !== "issued") return { ok: false, error: outcome.state };
  return {
    ok: true,
    sealedKey: await sealToJwk(token, outcome.cnfJwk),
    credentialId: outcome.credentialId,
    userId: outcome.userId,
    enrollmentId: outcome.enrollmentId,
    pendingExpiresAt: outcome.pendingExpiresAt,
  };
}
