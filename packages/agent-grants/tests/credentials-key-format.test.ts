// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  formatRevocableKey,
  isRevocableKey,
  isWellFormedRevocableKey,
  REVOCABLE_KEY_PREFIX,
  REVOCABLE_KEY_SCAN_PATTERN,
} from "../src/credentials";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

describe("revocable key format", () => {
  const key = formatRevocableKey("A".repeat(43));

  it("is prefix + 43 body + 6 checksum chars, and the scanner pattern matches it", () => {
    expect(key).toHaveLength(REVOCABLE_KEY_PREFIX.length + 49);
    expect(new RegExp(`^${REVOCABLE_KEY_SCAN_PATTERN}$`).test(key)).toBe(true);
    expect(isWellFormedRevocableKey(key)).toBe(true);
    expect(isRevocableKey(key)).toBe(true);
  });

  it("the checksum is the CRC32 of the body in base62 (checked against node:zlib)", () => {
    const body = "Zk3-_a9Q".padEnd(43, "x");
    let n = crc32(body);
    let expected = "";
    for (let i = 0; i < 6; i++) {
      expected = BASE62[n % 62] + expected;
      n = Math.floor(n / 62);
    }
    expect(formatRevocableKey(body)).toBe(`${REVOCABLE_KEY_PREFIX}${body}${expected}`);
    expect(formatRevocableKey("_".repeat(43))).not.toBe(key);
  });

  it("rejects an edited body, an edited checksum, a wrong length and a wrong prefix", () => {
    const edit = (i: number) => key.slice(0, i) + (key[i] === "B" ? "C" : "B") + key.slice(i + 1);
    expect(isWellFormedRevocableKey(edit(REVOCABLE_KEY_PREFIX.length + 3))).toBe(false);
    expect(isWellFormedRevocableKey(edit(key.length - 1))).toBe(false);
    expect(isWellFormedRevocableKey(`${key}x`)).toBe(false);
    expect(isWellFormedRevocableKey(key.slice(0, -1))).toBe(false);
    expect(isWellFormedRevocableKey(key.replace("_v2_", "_v3_"))).toBe(false);
    expect(isWellFormedRevocableKey("")).toBe(false);
  });

  it("refuses to build a key from a body of the wrong length or charset", () => {
    expect(() => formatRevocableKey("short")).toThrow();
    expect(() => formatRevocableKey(`${"a".repeat(42)}!`)).toThrow();
  });
});
