// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/placement`
 * Purpose: Pins the cutover placement table (task.0122, hub work-status-ladder "Cutover") and its fixed reasons.
 * Scope: Pure.
 * Invariants: facts decide; every reason fits the change-reason limit; a non-legacy item or an unreadable state places nothing.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { checkChangeReason } from "../src/history.js";
import {
  PLACEMENT_REASONS,
  type PlacementInput,
  placementFor,
} from "../src/placement.js";

const PR = "https://github.com/cogni-dao/node-template/pull/9";

describe("placementFor", () => {
  it.each<[string, PlacementInput, string | undefined]>([
    ["needs_closeout, PR merged", { type: "bug", status: "needs_closeout", pr: PR, state: "merged" }, "done"],
    ["needs_closeout, inbox open", { type: "spike", status: "needs_closeout", pr: "https://h/knowledge/inbox/contrib-x", state: "open" }, "needs_implementation_review"],
    ["needs_closeout, PR closed unmerged", { type: "task", status: "needs_closeout", pr: PR, state: "closed" }, "needs_implement"],
    ["needs_closeout, blank pr", { type: "story", status: "needs_closeout", pr: "  " }, "needs_implement"],
    ["a spike with no pr", { type: "spike", status: "needs_closeout" }, "needs_research"],
    ["blocked", { type: "task", status: "blocked", pr: PR, state: "open" }, "needs_triage"],
    ["blocked, no pr", { type: "story", status: "blocked" }, "needs_triage"],
  ])("%s", (_name, input, to) => {
    expect(placementFor(input)?.to).toBe(to);
  });

  it.each<[string, PlacementInput]>([
    ["an unreadable PR state places nothing", { type: "task", status: "needs_closeout", pr: PR, state: "unknown" }],
    ["needs_merge is not a source (the migration moves it to needs_closeout first)", { type: "task", status: "needs_merge", pr: PR, state: "merged" }],
    ["needs_merge with no pr is not a source either", { type: "task", status: "needs_merge" }],
    ["a missing state places nothing", { type: "task", status: "needs_closeout", pr: PR }],
    ["a ladder status is not legacy", { type: "task", status: "needs_implement" }],
    ["needs_triage is not legacy", { type: "task", status: "needs_triage" }],
    ["done is not legacy", { type: "task", status: "done", pr: PR, state: "merged" }],
    ["cancelled is not legacy", { type: "task", status: "cancelled" }],
  ])("%s", (_name, input) => {
    expect(placementFor(input)).toBeUndefined();
  });

  it("every fixed reason is a valid change reason", () => {
    for (const reason of Object.values(PLACEMENT_REASONS)) {
      expect(checkChangeReason(reason)).toMatchObject({ ok: true });
    }
  });

  it("a second pass places nothing: a placed item is no longer legacy", () => {
    const first = placementFor({ type: "task", status: "needs_closeout", pr: PR, state: "merged" });
    expect(first?.to).toBe("done");
    expect(placementFor({ type: "task", status: first?.to ?? "done", pr: PR, state: "merged" })).toBeUndefined();
  });
});
