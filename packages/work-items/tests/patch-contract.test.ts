// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/patch-contract`
 * Purpose: Pins the PATCH input schema's reason and cites rules (task.0086).
 * Scope: Pure zod parse. No adapter, no database.
 * Invariants:
 *   - REASON_REQUIRED: a missing reason is an issue at ["reason"] that says what to send; the caps match the adapter's.
 *   - CITES_BOUNDED: at most 8, ids unique, id and contribution patterns pinned.
 * Side-effects: none
 * Links: hub change-history-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import { CITE_ID_PATTERN, CITE_MAX } from "../src/cites.js";
import { CHANGE_REASON_REQUIRED_MESSAGE } from "../src/history.js";
import { WorkItemPatchInputSchema } from "../src/patch-contract.js";

const base = { id: "task.1", set: { title: "t" } };
const parse = (extra: Record<string, unknown>) =>
  WorkItemPatchInputSchema.safeParse({ ...base, ...extra });
const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");

describe("WorkItemPatchInputSchema reason", () => {
  it("a missing reason is an issue at reason that says what to send", () => {
    const result = parse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["reason"],
        message: CHANGE_REASON_REQUIRED_MESSAGE,
      }),
    ]);
  });

  it.each([
    [words(25), true],
    [words(26), false],
    ["x".repeat(240), true],
    ["x".repeat(241), false],
    ["a\u0000b", false],
    ["line one\nline two", true],
    ["", false],
  ])("%j -> %s", (reason, ok) => {
    expect(parse({ reason }).success).toBe(ok);
  });
});

describe("WorkItemPatchInputSchema cites", () => {
  const ok = (cites: unknown) => parse({ reason: "r", cites }).success;

  it("accepts none, one main cite and one inbox cite", () => {
    expect(parse({ reason: "r" }).success).toBe(true);
    expect(ok([{ id: "change-history-design" }])).toBe(true);
    expect(ok([{ id: "a.b_c-1", contribution: "contrib-derek-x-0d47fb13" }])).toBe(true);
  });

  it("accepts eight and rejects nine", () => {
    const cites = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `atom-${i}` }));
    expect(CITE_MAX).toBe(8);
    expect(ok(cites(8))).toBe(true);
    expect(ok(cites(9))).toBe(false);
  });

  it("rejects a repeated id, a bad id, a bad contribution and an unknown key", () => {
    expect(ok([{ id: "a" }, { id: "a" }])).toBe(false);
    expect(ok([{ id: "Upper" }])).toBe(false);
    expect(ok([{ id: "-lead" }])).toBe(false);
    expect(ok([{ id: "a\nb" }])).toBe(false);
    expect(ok([{ id: "a", contribution: "branch-x" }])).toBe(false);
    expect(ok([{ id: "a", contribution: "contrib-" }])).toBe(false);
    expect(ok([{ id: "a", extra: 1 }])).toBe(false);
  });

  it("pins the id pattern at 256 characters", () => {
    expect(CITE_ID_PATTERN.test("a".repeat(256))).toBe(true);
    expect(CITE_ID_PATTERN.test("a".repeat(257))).toBe(false);
  });
});
