// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { addOnly as grantsAddOnly } from "@cogni/agent-grants";
import { addOnly, assertOwnedToolIds, defineNodeExtensions } from "../src";

const tool = (name: string) => ({ contract: { name } });

describe("addOnly", () => {
  it("is agent-grants' one implementation, re-exported: same function, same behaviour and error shape", () => {
    expect(addOnly).toBe(grantsAddOnly);
    const sources = [
      { source: "core", entries: { dup: 1 } },
      { source: "poly", entries: { dup: 2 } },
    ];
    const msg = 'TOOL_ID_DUPLICATE: tool "dup" is declared by "core" and again by "poly"; a node adds, it never replaces';
    expect(() => addOnly({ what: "tool", code: "TOOL_ID_DUPLICATE" }, ...sources)).toThrow(msg);
    expect(() => grantsAddOnly({ what: "tool", code: "TOOL_ID_DUPLICATE" }, ...sources.reverse())).toThrow(msg);
  });
});

describe("defineNodeExtensions", () => {
  it("returns a frozen declaration", () => {
    const declared = defineNodeExtensions<unknown>({ tools: () => [] });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(declared.tools?.({})).toEqual([]);
  });
});

describe("assertOwnedToolIds", () => {
  it("returns the shared node prefix", () => {
    expect(assertOwnedToolIds([tool("poly__place_order"), tool("poly__cancel")])).toBe("poly");
    expect(assertOwnedToolIds([])).toBeUndefined();
  });

  it("rejects core__, a missing prefix and mixed prefixes", () => {
    expect(() => assertOwnedToolIds([tool("core__x")])).toThrow(/EXTENSION_ID_RESERVED/);
    expect(() => assertOwnedToolIds([tool("place_order")])).toThrow(/EXTENSION_ID_PREFIX/);
    expect(() => assertOwnedToolIds([tool("poly__a"), tool("red__b")])).toThrow(/EXTENSION_ID_PREFIX/);
  });
});
