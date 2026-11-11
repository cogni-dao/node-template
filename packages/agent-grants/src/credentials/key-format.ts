// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` key format
 * Purpose: The ONE definition of the revocable agent key wire format: how a key is built and how a token is checked for shape.
 * Scope: Pure string and CRC functions. No store, no env, no IO. Mint and every shape check (service, proxy) call this file.
 * Invariants:
 *   - ONE_PREFIX: `REVOCABLE_KEY_PREFIX` is the only prefix constant. Nothing else spells it.
 *   - KEY_FORMAT: key = prefix + body + checksum. body = 43 base64url chars (32 random bytes). checksum = 6 base62 chars of
 *     CRC32(body), left-padded with `0`. Total length = prefix + 49. The store sees only sha256 of the whole token, so the checksum
 *     needs no migration.
 *   - CHECKSUM_BEFORE_DB: a token whose shape or checksum fails is refused before any database read. The checksum is NOT a secret and adds
 *     no strength; it gives cheap offline rejection of typos and fakes, and lets secret scanners match keys with near-zero false hits.
 *   - SCANNER_PATTERN: `REVOCABLE_KEY_SCAN_PATTERN` is the regex a secret scanner registers for this key.
 * Side-effects: none
 * Links: https://docs.github.com/en/code-security/secret-scanning (GitHub-style checksummed tokens), https://cognidao.org/work/items/task.5474
 * @public
 */

export const REVOCABLE_KEY_PREFIX = "cogni_ag_sk_v2_";

const BODY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Regex source for a secret scanner (gitleaks, trufflehog, GitHub custom patterns). Shape only: the CRC is checked by `isWellFormedRevocableKey`. */
export const REVOCABLE_KEY_SCAN_PATTERN = `${REVOCABLE_KEY_PREFIX}[A-Za-z0-9_-]{${BODY_LENGTH}}[0-9A-Za-z]{${CHECKSUM_LENGTH}}`;

const SHAPE = new RegExp(`^${REVOCABLE_KEY_PREFIX}([A-Za-z0-9_-]{${BODY_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumOf(body: string): string {
  let value = crc32(body);
  let out = "";
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    out = BASE62[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

/** Build a key from its 43-char base64url body. The only place a key string is assembled. */
export function formatRevocableKey(body: string): string {
  if (body.length !== BODY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error("revocable key body must be 43 base64url chars");
  return `${REVOCABLE_KEY_PREFIX}${body}${checksumOf(body)}`;
}

/** Routing test only: does this bearer claim to be a revocable key? A match says nothing about validity. */
export const isRevocableKey = (token: string): boolean => token.startsWith(REVOCABLE_KEY_PREFIX);

/** Shape and checksum. Pure: no store read. A token that fails here is refused before the database. */
export function isWellFormedRevocableKey(token: string): boolean {
  const match = SHAPE.exec(token);
  return match !== null && checksumOf(match[1] as string) === match[2];
}
