// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment` seal
 * Purpose: Seal a key to the requester's confirmation key (`cnf.jwk`) as a compact JWE, and open one with the private key.
 * Scope: `jose` only. ECDH-ES with X25519 and A256GCM. No store, no env.
 * Invariants:
 *   - SEALED_TO_CNF: the key leaves this node only as a JWE for the public key the signed token named. A copied device code returns
 *     ciphertext that only the holder of the matching private key can open.
 *   - PLAINTEXT_IS_THE_KEY: the plaintext is the key string itself (UTF-8), nothing else.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment (RFC 7800 `cnf`, RFC 7516)
 * @public
 */

import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from "jose";

import type { ServiceEnrollmentCnfJwk } from "./claims";

export const SEAL_ALG = "ECDH-ES";
export const SEAL_ENC = "A256GCM";

/** Seal `plaintext` to an X25519 public JWK. */
export async function sealToJwk(plaintext: string, publicJwk: ServiceEnrollmentCnfJwk): Promise<string> {
  const key = await importJWK(publicJwk, SEAL_ALG);
  return new CompactEncrypt(new TextEncoder().encode(plaintext)).setProtectedHeader({ alg: SEAL_ALG, enc: SEAL_ENC }).encrypt(key);
}

/** Open a compact JWE made by `sealToJwk`. `privateJwk` is the X25519 private JWK (`d` present). Throws when it does not open. */
export async function openSealed(jwe: string, privateJwk: JWK): Promise<string> {
  const key = await importJWK(privateJwk, SEAL_ALG);
  const { plaintext } = await compactDecrypt(jwe, key, {
    keyManagementAlgorithms: [SEAL_ALG],
    contentEncryptionAlgorithms: [SEAL_ENC],
  });
  return new TextDecoder().decode(plaintext);
}
