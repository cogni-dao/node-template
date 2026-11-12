// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` verify
 * Purpose: Verify a service enrollment token against a list of trusted home nodes.
 * Scope: Pure over injected key sets (the node supplies a remote JWKS reader per issuer). No env, no store, no network of its own.
 * Invariants:
 *   - TRUSTED_HOMES_ONLY: the token's `iss` must equal the origin of an entry in the list. An unknown issuer is `invalid_token` with no key fetch.
 *   - EDDSA_ONLY: `alg` is restricted to EdDSA, so there is no HS or `none` downgrade.
 *   - EXACT_AUDIENCE_TYP_KIND: `aud` is this node's `urn:cogni:node:<uuid>`, header `typ` is the enrollment type and claim `kind` is
 *     `service.enrollment.v1`.
 *   - HOME_LIMITS_THE_ASK: the service must be listed for that home and every scope must be one that home may ask for.
 *   - FAIL_CLOSED: an error that does not prove the token is bad (a JWKS outage) is `jwks_unavailable` (503), never an accept.
 *   - NEVER_THROWS: every failure is a result.
 * Side-effects: IO only through the injected key getter
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { decodeJwt, errors, importJWK, type JWTVerifyGetKey, jwtVerify } from "jose";

import {
  SERVICE_ENROLLMENT_MAX_TTL_SEC,
  SERVICE_ENROLLMENT_TYP,
  type ServiceEnrollmentClaims,
  serviceEnrollmentAudience,
  serviceEnrollmentClaims,
} from "./claims";

/** One home node this node trusts to sign enrollment tokens. `services` maps a service name to the scopes it may ask for. */
export interface TrustedHome {
  readonly origin: string;
  readonly services: Readonly<Record<string, readonly string[]>>;
}

export type EnrollmentVerifyResult =
  | { readonly ok: true; readonly claims: ServiceEnrollmentClaims; readonly home: TrustedHome }
  | { readonly ok: false; readonly reason: "invalid_token" | "jwks_unavailable" };

/** The verifier port a node injects into `requestServiceEnrollment`. */
export type EnrollmentTokenVerifier = (token: string) => Promise<EnrollmentVerifyResult>;

export interface EnrollmentVerifierOptions {
  /** This node's uuid (the audience). */
  readonly nodeId: string;
  readonly homes: readonly TrustedHome[];
  /** The key set of one home (the node supplies a cached remote JWKS reader for `${origin}/.well-known/jwks.json`). */
  readonly keysFor: (origin: string) => JWTVerifyGetKey;
  readonly now?: () => Date;
}

const MAX_TOKEN_CHARS = 4096;
const CLOCK_SKEW_SEC = 60;
const INVALID = { ok: false, reason: "invalid_token" } as const;

/** Errors that prove the TOKEN is bad. Everything else (a JWKS timeout, a malformed key document) is an issuer availability problem. */
function isTokenError(error: unknown): boolean {
  return (
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  );
}

export function createEnrollmentTokenVerifier(options: EnrollmentVerifierOptions): EnrollmentTokenVerifier {
  const now = options.now ?? (() => new Date());
  const audience = serviceEnrollmentAudience(options.nodeId);
  return async (token) => {
    if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return INVALID;
    let issuer: unknown;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      return INVALID;
    }
    const home = options.homes.find((h) => h.origin === issuer);
    if (!home) return INVALID;
    try {
      const currentDate = now();
      const { payload } = await jwtVerify(token, options.keysFor(home.origin), {
        issuer: home.origin,
        audience,
        algorithms: ["EdDSA"],
        typ: SERVICE_ENROLLMENT_TYP,
        currentDate,
      });
      const parsed = serviceEnrollmentClaims.safeParse(payload);
      if (!parsed.success) return INVALID;
      const claims = parsed.data;
      const nowSec = Math.floor(currentDate.getTime() / 1000);
      if (claims.exp - claims.iat > SERVICE_ENROLLMENT_MAX_TTL_SEC || claims.iat > nowSec + CLOCK_SKEW_SEC) return INVALID;
      const allowed = home.services[claims.service];
      if (!allowed || !claims.scopes.every((scope) => allowed.includes(scope))) return INVALID;
      // The key must be importable as an ECDH-ES key before a device code is issued for it.
      await importJWK(claims.cnf.jwk, "ECDH-ES");
      return { ok: true, claims, home };
    } catch (error) {
      return isTokenError(error) ? INVALID : { ok: false, reason: "jwks_unavailable" };
    }
  };
}
