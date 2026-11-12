// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-client` sign
 * Purpose: Build and sign a `service.enrollment.v1` token: the one signed request a service sends to the node it asks for a key.
 * Scope: Claim assembly and JWS signing. The signer takes a key (`jose` accepts a KeyObject, CryptoKey, JWK or bytes) or a `signBytes` function
 *   (a KMS, an HSM, a remote signer). No env, no storage, no network.
 * Invariants:
 *   - OWN_TYP_AND_KIND: the protected header carries `typ: cogni-service-enrollment+jwt` and the claims carry `kind: service.enrollment.v1`, the
 *     same pair the provider's verifier demands, so the token cannot be replayed as any other signed token of the issuer.
 *   - EDDSA_ONLY: the algorithm is EdDSA; the provider refuses any other.
 *   - SHORT_LIFE: claims are checked against the provider's own zod shape before signing; `exp - iat` above `SERVICE_ENROLLMENT_MAX_TTL_SEC`
 *     never leaves this module.
 *   - CNF_IS_PUBLIC: the claims carry the PUBLIC half of the ephemeral key; a private JWK is refused by the shape.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, ../claims.ts, ../verify.ts
 * @public
 */

import { SignJWT } from "jose";
import {
  SERVICE_ENROLLMENT_KIND,
  SERVICE_ENROLLMENT_MAX_TTL_SEC,
  SERVICE_ENROLLMENT_TYP,
  type ServiceEnrollmentClaims,
  type ServiceEnrollmentCnfJwk,
  serviceEnrollmentAudience,
  serviceEnrollmentClaims,
} from "../claims";
import { enrollmentProofSchema } from "../protocol";

export const SERVICE_ENROLLMENT_SIGNING_ALG = "EdDSA";

export type EnrollmentSigningKey = Parameters<SignJWT["sign"]>[0];

/** Where the signature comes from: a key `jose` can sign with, or a function that signs the JWS signing input (`<header>.<payload>`). */
export type EnrollmentSignerInput =
  | { readonly kid: string; readonly key: EnrollmentSigningKey }
  | {
      readonly kid: string;
      readonly signBytes: (signingInput: Uint8Array) => Promise<Uint8Array>;
    };

export interface EnrollmentSigner {
  sign(claims: ServiceEnrollmentClaims): Promise<string>;
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export function createEnrollmentSigner(
  input: EnrollmentSignerInput
): EnrollmentSigner {
  return {
    async sign(claims) {
      const checked = serviceEnrollmentClaims.parse(claims);
      if (checked.exp - checked.iat > SERVICE_ENROLLMENT_MAX_TTL_SEC)
        throw new Error("enrollment token lifetime exceeds the maximum");
      const header = {
        alg: SERVICE_ENROLLMENT_SIGNING_ALG,
        typ: SERVICE_ENROLLMENT_TYP,
        kid: input.kid,
      };
      if ("key" in input)
        return new SignJWT({ ...checked })
          .setProtectedHeader(header)
          .sign(input.key);
      const encoder = new TextEncoder();
      const signingInput = `${toBase64Url(encoder.encode(JSON.stringify(header)))}.${toBase64Url(encoder.encode(JSON.stringify(checked)))}`;
      const signature = await input.signBytes(encoder.encode(signingInput));
      return `${signingInput}.${toBase64Url(signature)}`;
    },
  };
}

export interface BuildEnrollmentClaimsInput {
  /** The requester's own canonical HTTPS origin: the issuer the served node trusts and whose JWKS holds the signing key. */
  readonly issuer: string;
  /** The uuid of the node being asked (audience `urn:cogni:node:<uuid>`). */
  readonly nodeId: string;
  /** The service asking, a lowercase slug (for example `git-review`). */
  readonly service: string;
  /** The one permission asked for (for example `knowledge:read`). */
  readonly scope: string;
  /** The PUBLIC X25519 key the issued key is sealed to. */
  readonly cnfPublicJwk: ServiceEnrollmentCnfJwk;
  /** A fresh uuid: the provider accepts a `jti` once. */
  readonly jti: string;
  readonly now: Date;
  /** Lifetime in seconds, at most 600 (default 600). */
  readonly ttlSec?: number;
}

/** The claims of one enrollment token, checked against the provider's own shape. */
export function buildEnrollmentClaims(
  input: BuildEnrollmentClaimsInput
): ServiceEnrollmentClaims {
  const iat = Math.floor(input.now.getTime() / 1000);
  return serviceEnrollmentClaims.parse({
    iss: input.issuer,
    aud: serviceEnrollmentAudience(input.nodeId),
    kind: SERVICE_ENROLLMENT_KIND,
    jti: input.jti,
    iat,
    exp:
      iat +
      Math.min(
        input.ttlSec ?? SERVICE_ENROLLMENT_MAX_TTL_SEC,
        SERVICE_ENROLLMENT_MAX_TTL_SEC
      ),
    service: input.service,
    scopes: [input.scope],
    cnf: { jwk: input.cnfPublicJwk },
  });
}

/** Durable proofs carry the original immutable identity; continuation gets only a fresh proof identifier/deadline. */
export interface EnrollmentProofSigner {
  signProof(proof: import("../protocol").EnrollmentProof): Promise<string>;
}
export function createEnrollmentProofSigner(
  input: EnrollmentSignerInput
): EnrollmentProofSigner {
  return {
    async signProof(proof) {
      const checked = enrollmentProofSchema.parse(proof);
      if (!input.kid) throw new Error("enrollment_signer_unavailable");
      const header = {
        alg: "EdDSA",
        typ: SERVICE_ENROLLMENT_TYP,
        kid: input.kid,
      };
      if ("key" in input)
        return new SignJWT({ ...checked })
          .setProtectedHeader(header)
          .sign(input.key);
      const encode = (s: string) => toBase64Url(new TextEncoder().encode(s));
      const bytes = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(checked))}`;
      return `${bytes}.${toBase64Url(await input.signBytes(new TextEncoder().encode(bytes)))}`;
    },
  };
}
