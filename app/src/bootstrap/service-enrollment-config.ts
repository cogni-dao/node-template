// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-enrollment-config`
 * Purpose: The pure, typed boundary for this node's service-enrollment configuration: where it is (origin, environment) and its proof-signing key.
 * Scope: Reads values handed in; imports no container, database or env module. Never logs a value.
 * Invariants:
 *   - PLAIN_CONFIG_IS_NOT_A_SECRET: the node's own origin and environment are derived from the typed config the node already has (`APP_BASE_URL`,
 *     `DEPLOY_ENVIRONMENT`); an explicit `SERVICE_ENROLLMENT_ORIGIN` / `_ENVIRONMENT` only overrides. Neither is a catalog secret.
 *   - GENERATED_SIGNING_KEY: the only credential is `SERVICE_ENROLLMENT_SIGNING_SEED`, 32 random bytes (base64) the operator mints once (`source: agent`).
 *     The Ed25519 key pair and its `kid` (the RFC 7638 thumbprint of the public key) are DERIVED from it, so no agent or human ever pastes a key or a kid.
 *   - FAIL_CLOSED: a missing or malformed seed throws `service_signer_unavailable`; the routes answer 503. The public key set carries no private member.
 * Side-effects: none
 * @public
 */

import { createPrivateKey } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, importJWK } from "jose";

/** PKCS#8 header of an Ed25519 private key; the 32-byte seed follows it. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface EnrollmentConfigEnv {
  readonly APP_BASE_URL?: string | undefined;
  readonly DEPLOY_ENVIRONMENT?: string | undefined;
  readonly SERVICE_ENROLLMENT_ORIGIN?: string | undefined;
  readonly SERVICE_ENROLLMENT_ENVIRONMENT?: string | undefined;
}

/** This node's canonical HTTPS origin: an explicit override, else the origin of its own `APP_BASE_URL`. */
export function serviceEnrollmentOrigin(env: EnrollmentConfigEnv): string | undefined {
  if (env.SERVICE_ENROLLMENT_ORIGIN) return env.SERVICE_ENROLLMENT_ORIGIN;
  if (!env.APP_BASE_URL) return undefined;
  try {
    return new URL(env.APP_BASE_URL).origin;
  } catch {
    return undefined;
  }
}

/** This node's deployment environment: an explicit override, else `DEPLOY_ENVIRONMENT`. */
export function serviceEnrollmentEnvironment(env: EnrollmentConfigEnv): string | undefined {
  return env.SERVICE_ENROLLMENT_ENVIRONMENT || env.DEPLOY_ENVIRONMENT || undefined;
}

/** Derive the proof-signing key pair, its `kid` and the PUBLIC key set from the generated seed. */
export async function deriveServiceSigner(seed: string | undefined) {
  if (!seed) throw new Error("service_signer_unavailable");
  const bytes = Buffer.from(seed, "base64");
  if (bytes.length !== 32) throw new Error("service_signer_unavailable");
  const jwk = await exportJWK(
    createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes]), format: "der", type: "pkcs8" })
  );
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string")
    throw new Error("service_signer_unavailable");
  const kid = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  return {
    kid,
    key: await importJWK(jwk, "EdDSA"),
    // Explicit allowlist: the private member can never reach the public route.
    jwks: { keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid, alg: "EdDSA", use: "sig" }] },
  };
}
