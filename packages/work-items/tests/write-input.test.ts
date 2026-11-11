// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/write-input`
 * Purpose: Proves the store input a node and a tool forward comes from one place (task.0097).
 * Scope: Pure.
 * Invariants:
 *   - EVERY_STORE_FIELD_FORWARDS: each create field reaches the store input; a node-only key does not.
 *   - PATCH_FORWARDS_REASON_CITES_MOVES: reason, cites, expectedRevision and `set.moves` reach the store; `undefined` never does.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  toWorkItemsCreateInput,
  toWorkItemsPatchInput,
  WORK_ITEM_CREATE_FIELDS,
} from "../src/write-input.js";

describe("toWorkItemsCreateInput", () => {
  it("forwards every listed field and brands the id fields", () => {
    const wire = {
      id: "task.0001",
      type: "task",
      title: "t",
      summary: "s",
      outcome: "o",
      specRefs: ["a"],
      projectId: "proj.x",
      parentId: "story.0001",
      labels: ["l"],
      assignees: [{ kind: "user", userId: "u" }],
      node: "n",
      status: "needs_triage",
      priority: 2,
      rank: 3,
      estimate: 1,
      scores: { goal: { v: 3 } },
      moves: [{ metricId: "m-1", direction: "up" }],
    } as const;
    expect(Object.keys(wire).sort()).toEqual([...WORK_ITEM_CREATE_FIELDS].sort());
    expect(toWorkItemsCreateInput(wire as never)).toEqual(wire);
  });

  it("drops undefined values and keys the store does not own", () => {
    const out = toWorkItemsCreateInput({
      type: "task",
      title: "t",
      summary: undefined,
      moves: [],
      nodeOnly: "x",
    } as never);
    expect(out).toEqual({ type: "task", title: "t", moves: [] });
    expect("summary" in out).toBe(false);
  });
});

describe("toWorkItemsPatchInput", () => {
  it("forwards reason, cites, revision and set (with moves) and drops undefined keys", () => {
    const cites = [{ id: "change-history-design" }];
    const out = toWorkItemsPatchInput({
      id: "task.0001",
      expectedRevision: 7,
      reason: "r",
      cites,
      set: { summary: "x", outcome: undefined, moves: [{ metricId: "m-1", direction: "down" }] },
    });
    expect(out).toEqual({
      id: "task.0001",
      expectedRevision: 7,
      reason: "r",
      cites,
      set: { summary: "x", moves: [{ metricId: "m-1", direction: "down" }] },
    });
    expect("outcome" in out.set).toBe(false);
  });

  it("leaves out an absent revision and absent cites, keeps the reason", () => {
    const out = toWorkItemsPatchInput({
      id: "task.0001",
      reason: "r",
      expectedRevision: undefined,
      cites: undefined,
      set: { moves: [] },
    });
    expect(out).toEqual({ id: "task.0001", reason: "r", set: { moves: [] } });
    expect(Object.keys(out).sort()).toEqual(["id", "reason", "set"]);
  });

  it("does not forward a top-level key the package does not own", () => {
    const out = toWorkItemsPatchInput({
      id: "task.0001",
      reason: "r",
      set: { summary: "x" },
      nodeOnly: 1,
    } as never);
    expect("nodeOnly" in out).toBe(false);
  });
});
