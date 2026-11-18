// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { type ConnectionKey, canonicalJson } from "../protocol";
/** Versioned AES-GCM custody codec. Legacy provider AAD is unaffected. */
import type { CustodyCipher } from "./types";
export const custodyAad = (
  key: ConnectionKey,
  operationId: string,
  connectionId: string
): string => canonicalJson({ version: 2, key, operationId, connectionId });
export const toBase64 = (v: Uint8Array): string =>
  btoa(String.fromCharCode(...v));
export const fromBase64 = (v: string): Uint8Array =>
  Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
export function createCustodyCipher(
  bytes: Uint8Array,
  keyId: string
): CustodyCipher {
  if (bytes.length !== 32 || !keyId) throw new Error("custody_key_unavailable");
  const key = crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  return {
    keyId,
    async seal(plaintext, aad) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv,
            additionalData: new TextEncoder().encode(aad),
          },
          await key,
          new TextEncoder().encode(plaintext)
        )
      );
      const result = new Uint8Array(iv.length + body.length);
      result.set(iv);
      result.set(body, iv.length);
      return result;
    },
    async open(ciphertext, aad) {
      const bytes = new Uint8Array(ciphertext);
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bytes.slice(0, 12),
            additionalData: new TextEncoder().encode(aad),
          },
          await key,
          bytes.slice(12)
        )
      );
    },
  };
}
