// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.scores.contract`
 * Purpose: Pins the `scores` wire shape on work-item create/patch (story.5111).
 * Scope: Pure Zod schema validation. Does not test HTTP transport or storage.
 * Invariants:
 *   - SCORE_IS_INT_0_TO_5: v must be an integer in [0, 5].
 *   - AXES_ARE_CONFIG: any axis id matching /^[a-z][a-z0-9_]{0,31}$/ is accepted; at most 12 axes.
 *   - SCORES_BOUNDS_IN_PACKAGE: every bound comes from `parseWorkItemScores` (@cogni-dao/work-items);
 *     these cases prove the contract wires it in, the package tests own the full matrix.
 *   - SCORE_NEEDS_EVIDENCE: v ≥ 4 needs an https, allow-listed `ev`.
 *   - PATCH_NULL_CLEARS: patch accepts scores:null; create does not.
 * Side-effects: none
 * Links: packages/node-contracts/src/work.items.list.v1.contract.ts, packages/work-items/src/scores.ts, hub work-item-scores-design
 * @internal
 */

import {
  WorkItemScoresInputSchema,
  workItemsCreateOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const ok = (scores: unknown) => WorkItemScoresInputSchema.safeParse(scores).success;

describe("WorkItemScoresInputSchema", () => {
  it("accepts six axes with and without evidence", () => {
    expect(
      ok({
        goal: { v: 5, ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself" },
        time: { v: 0 },
        unblocks: { v: 4, ev: "https://github.com/cogni-dao/node-template/pull/198" },
        ease: { v: 3 },
        confidence: { v: 2 },
        agent: { v: 1 },
      })
    ).toBe(true);
  });

  it("accepts a new axis id without a code change (axes are config)", () => {
    expect(ok({ reach_2: { v: 2 } })).toBe(true);
  });

  it.each([
    ["v above 5", { goal: { v: 6 } }],
    ["fractional v", { goal: { v: 2.5 } }],
    ["negative v", { goal: { v: -1 } }],
    ["missing v", { goal: { ev: "https://cognidao.org" } }],
    ["uppercase key", { Goal: { v: 1 } }],
    ["hyphenated key", { "do-now": { v: 1 } }],
    ["key starting with a digit", { "1goal": { v: 1 } }],
    ["over-long key", { [`a${"b".repeat(32)}`]: { v: 1 } }],
    ["extra property", { goal: { v: 1, note: "x" } }],
    ["v ≥ 4 without ev", { goal: { v: 4 } }],
    ["http: ev", { goal: { v: 4, ev: "http://cognidao.org/x" } }],
    ["non-allow-listed ev host", { goal: { v: 4, ev: "https://example.com/x" } }],
    ["ev over 300 chars", { goal: { v: 1, ev: `https://cognidao.org/${"a".repeat(300)}` } }],
    ["javascript: ev", { goal: { v: 4, ev: "javascript:alert(1)" } }],
    ["data: ev", { goal: { v: 4, ev: "data:text/html,<script>1</script>" } }],
    ["ftp: ev", { goal: { v: 4, ev: "ftp://example.com/x" } }],
    ["non-URL ev", { goal: { v: 4, ev: "see story.5108" } }],
  ])("rejects %s", (_label, scores) => {
    expect(ok(scores)).toBe(false);
  });

  it("rejects more than 12 axes", () => {
    const axes = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`axis${i}`, { v: 1 }])
      );
    expect(ok(axes(12))).toBe(true);
    expect(ok(axes(13))).toBe(false);
  });
});

describe("scores on create and patch", () => {
  const scores = {
    goal: { v: 5, ev: "https://cognidao.org/knowledge/goal-fleet-pays-itself" },
  };

  it("create accepts scores and rejects scores:null", () => {
    const base = { type: "task", title: "t" };
    expect(
      workItemsCreateOperation.input.safeParse({ ...base, scores }).success
    ).toBe(true);
    expect(
      workItemsCreateOperation.input.safeParse({ ...base, scores: null })
        .success
    ).toBe(false);
  });

  it("patch accepts scores and scores:null (clears the column)", () => {
    const patch = (set: unknown) =>
      workItemsPatchOperation.input.safeParse({ id: "task.0001", set });
    expect(patch({ scores }).success).toBe(true);
    const cleared = patch({ scores: null });
    expect(cleared.success).toBe(true);
    expect(cleared.data?.set.scores).toBeNull();
    expect(patch({ scores: { goal: { v: 6 } } }).success).toBe(false);
  });

  it("surfaces the package issue path and code", () => {
    const result = WorkItemScoresInputSchema.safeParse({ goal: { v: 5 } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["goal", "ev"]);
    expect(result.error?.issues[0]).toMatchObject({
      params: { scoresIssue: "evidence_required" },
    });
  });

  it("rejects a scores object over 1 KB", () => {
    const ev = `https://cognidao.org/x?q=${"a".repeat(250)}`;
    const big = Object.fromEntries(
      ["goal", "time", "unblocks", "ease"].map((axis) => [axis, { v: 4, ev }])
    );
    expect(ok(big)).toBe(false);
  });
});
