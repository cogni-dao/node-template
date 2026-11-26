// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { addOnly, assertOwnedToolIds, defineNodeExtensions } from "../src";

const tool = (name: string) => ({ contract: { name } });

describe("addOnly", () => {
  it("merges disjoint sources", () => {
    expect(addOnly<number>({ what: "x" }, { source: "a", entries: { one: 1 } }, { source: "b", entries: { two: 2 } }, { source: "c", entries: undefined })).toEqual({ one: 1, two: 2 });
  });

  it("throws naming the key and both sources, whichever came first", () => {
    const a = { source: "core", entries: { dup: 1 } };
    const b = { source: "poly", entries: { dup: 2 } };
    const msg = 'TOOL_ID_DUPLICATE: tool "dup" is declared by "core" and again by "poly"';
    expect(() => addOnly({ what: "tool", code: "TOOL_ID_DUPLICATE" }, a, b)).toThrow(msg);
    expect(() => addOnly({ what: "tool", code: "TOOL_ID_DUPLICATE" }, b, a)).toThrow(msg);
  });

  it("lets an equal repeat count as one declaration when `same` says so", () => {
    const same = (x: { v: number }, y: { v: number }) => x.v === y.v;
    expect(addOnly({ what: "scope", same }, { source: "a", entries: { s: { v: 1 } } }, { source: "b", entries: { s: { v: 1 } } })).toEqual({ s: { v: 1 } });
    expect(() => addOnly({ what: "scope", same }, { source: "a", entries: { s: { v: 1 } } }, { source: "b", entries: { s: { v: 2 } } })).toThrow(/"a" and again by "b"/);
  });

  it("does not read inherited names as collisions", () => {
    expect(addOnly<number>({ what: "x" }, { source: "a", entries: { constructor: 1, toString: 2 } })).toEqual({ constructor: 1, toString: 2 });
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
