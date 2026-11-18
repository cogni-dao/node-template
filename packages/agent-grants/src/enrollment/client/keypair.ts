// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-client` keypair
 * Purpose: The ephemeral X25519 key an enrollment seals its key to, and the unseal of the JWE the served node returns.
 * Scope: Key generation and `CompactDecrypt` (ECDH-ES, A256GCM) through `jose`. No IO, no storage: the caller keeps the private JWK until the key arrives.
 * Invariants:
 *   - EPHEMERAL_PER_ENROLLMENT: one keypair per enrollment; the caller stores the private half (encrypted) and deletes it once the key is stored.
 *   - ALGORITHMS_PINNED: only `ECDH-ES` with `A256GCM` opens; any other header fails closed.
 *   - KEY_SHAPE_CHECKED: the plaintext must be a well-formed revocable key (prefix, length and checksum), so a hostile node cannot make a caller
 *     store arbitrary text as a credential.
 *   - KEY_NOT_LOGGED: errors carry a fixed code, never the JWE or the plaintext.
 * Side-effects: none
 * Links: ../seal.ts (the provider's seal), https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { exportJWK, generateKeyPair, type JWK } from "jose";

import { isWellFormedRevocableKey } from "../../credentials/key-format";
import type { ServiceEnrollmentCnfJwk } from "../claims";
import { openSealed } from "../seal";

/** A sealed key is a short compact JWE; anything longer is refused before any crypto. */
export const MAX_SEALED_KEY_CHARS = 16_384;

export interface LinkKeypair {
  readonly publicJwk: ServiceEnrollmentCnfJwk;
  /** The X25519 private JWK (`d` present). Secret: store it encrypted, never log it. */
  readonly privateJwk: JWK;
}

export async function generateLinkKeypair(): Promise<LinkKeypair> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "X25519", extractable: true });
  const pub = await exportJWK(publicKey);
  if (pub.kty !== "OKP" || pub.crv !== "X25519" || !pub.x) throw new Error("link_keypair_unexpected_shape");
  return { publicJwk: { kty: "OKP", crv: "X25519", x: pub.x }, privateJwk: await exportJWK(privateKey) };
}

/** Open the sealed key with the enrollment's private JWK. Throws `sealed_key_unreadable` for any failure. */
export async function unsealServiceKey(jwe: string, privateJwk: JWK): Promise<string> {
  try {
    if (jwe.length === 0 || jwe.length > MAX_SEALED_KEY_CHARS) throw new Error("size");
    const key = (await openSealed(jwe, privateJwk)).trim();
    if (!isWellFormedRevocableKey(key)) throw new Error("shape");
    return key;
  } catch {
    throw new Error("sealed_key_unreadable");
  }
}
