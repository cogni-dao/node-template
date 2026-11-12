// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` claims
 * Purpose: The wire contract of a service enrollment token: its own `typ`, its own `kind`, the claim shapes and the fixed limits.
 * Scope: Constants, zod shapes and two pure name helpers. No IO, no env, no JWT library (`verify.ts` owns verification).
 * Invariants:
 *   - OWN_TYP_AND_KIND: an enrollment token carries header `typ: cogni-service-enrollment+jwt` AND claim `kind: service.enrollment.v1`.
 *     Any other verifier (for example the GitHub identity attestation, which shares the `urn:cogni:node:<uuid>` audience) refuses a token
 *     that carries either one, so a token signed for one purpose cannot be replayed as the other.
 *   - SHORT_LIFE: `exp - iat` is at most `SERVICE_ENROLLMENT_MAX_TTL_SEC`.
 *   - CNF_IS_PUBLIC: `cnf.jwk` is an X25519 PUBLIC key (RFC 7800). A JWK that carries a private part (`d`) is refused.
 *   - ONE_PRINCIPAL_PER_ISSUER_AND_SERVICE: `serviceKeyOf` is the one key of that rule (`agent_principals.service_key`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { z } from "zod";

export const SERVICE_ENROLLMENT_TYP = "cogni-service-enrollment+jwt";
/** Legacy utility codec only. The serving verifier exclusively parses protocol.enrollmentProofSchema (v2). */
export const SERVICE_ENROLLMENT_KIND = "service.enrollment.v1";
export const SERVICE_ENROLLMENT_MAX_TTL_SEC = 600;
export const SERVICE_ENROLLMENT_AUDIENCE_PREFIX = "urn:cogni:node:";

/** The audience of an enrollment token for the node with this uuid. */
export const serviceEnrollmentAudience = (nodeId: string): string =>
  `${SERVICE_ENROLLMENT_AUDIENCE_PREFIX}${nodeId}`;

/** Fixed limits (constants, no setting). The device code lives 24 hours; a client may poll every 5 seconds. */
export const SERVICE_ENROLLMENT_LIMITS = {
  deviceCodeSec: 86_400,
  pollIntervalSec: 5,
  /** Open (unredeemed, unexpired) enrollments on one node. */
  openEnrollments: 5,
  /** Agents made by enrollment (one principal per issuer and service). */
  enrolledAgents: 25,
} as const;

/** A canonical HTTPS origin: no path, query, fragment or credentials. */
export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

const origin = z
  .string()
  .refine(isHttpsOrigin, { message: "must be a canonical HTTPS origin" });

/** An X25519 public JWK. `d` (a private key) is refused. The parsed value keeps only the three public members. */
export const serviceEnrollmentCnfJwk = z
  .looseObject({
    kty: z.literal("OKP"),
    crv: z.literal("X25519"),
    x: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "x must be 32 bytes in base64url"),
  })
  .refine((jwk) => !("d" in jwk), {
    message: "a private key is never a confirmation key",
  })
  .transform(({ kty, crv, x }) => ({ kty, crv, x }));

export type ServiceEnrollmentCnfJwk = z.infer<typeof serviceEnrollmentCnfJwk>;

export const serviceEnrollmentClaims = z.object({
  iss: origin,
  aud: z.string().min(1),
  kind: z.literal(SERVICE_ENROLLMENT_KIND),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  service: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "service is a lowercase slug"),
  /** v0 carries exactly one permission. */
  scopes: z
    .array(z.string().regex(/^[a-z][a-z0-9_.-]*:[a-z0-9_.-]+$/))
    .length(1),
  cnf: z.object({ jwk: serviceEnrollmentCnfJwk }),
});

export type ServiceEnrollmentClaims = z.infer<typeof serviceEnrollmentClaims>;

/** `<issuer origin>#<service>`: the key of the ONE principal an (issuer, service) pair owns on a node. */
export const serviceKeyOf = (issuer: string, service: string): string =>
  `${issuer}#${service}`;

/** The principal's name, built only from verified claims: `git-review@cognidao.org`. */
export const servicePrincipalName = (issuer: string, service: string): string =>
  `${service}@${new URL(issuer).host}`;
