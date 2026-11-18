// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/placement`
 * Purpose: Where the one-shot cutover places an item that is still in a legacy status (task.0122, hub work-status-ladder
 *   "Cutover"), and the fixed reason it writes.
 * Scope: Pure. The placement script reads each item's PR or inbox state and calls `DoltgresWorkItemAdapter.place` with the
 *   answer. The move predicate (`evaluateMove`) has no legacy case; this is the whole of the legacy handling.
 * Invariants:
 *   - FIXED_REASONS: every placement carries one of `PLACEMENT_REASONS`, each within the 25-word change reason limit.
 *   - FACTS_DECIDE: a needs_closeout item goes to done when its PR (an inbox: its merge) is merged, to
 *     needs_implementation_review when it is open, to needs_implement when it was closed without merging or there is no `pr`
 *     (a spike with no `pr`: needs_research); blocked goes to needs_triage. An unreadable state places nothing. The store reads
 *     `merged` and `open` from its PR-facts and inbox ports, so a closed unmerged PR or inbox is `closed`, never `open`.
 *   - TWO_SOURCES: only needs_closeout and blocked are sources. needs_merge is not: migration 0008 moves every needs_merge item
 *     to needs_closeout first, so a ladder stage can never be placed.
 *   - IDEMPOTENT: an item outside those two statuses has no placement, so a re-run is a no-op.
 * Side-effects: none
 * Links: hub work-status-ladder (Cutover)
 * @public
 */

import type { WorkItemStatus, WorkItemType } from "./types.js";

export const PLACEMENT_REASONS = {
  done: "Cutover: the PR or inbox is merged, so the item is done.",
  review: "Cutover: the PR or inbox is open, so the item awaits implementation review.",
  implement: "Cutover: no open deliverable, so the item is back at implement.",
  research: "Cutover: a spike with no inbox is back at research.",
  triage: "Cutover: blocked is no longer a stage, so the item is back at triage.",
} as const;

/** The state of an item's PR or inbox: `unknown` when it could not be read. */
export type DeliverableState = "merged" | "open" | "closed" | "unknown";

export interface PlacementInput {
  readonly type: WorkItemType;
  readonly status: WorkItemStatus;
  readonly pr?: string | null | undefined;
  /** The state of `pr`; ignored when there is no `pr`. */
  readonly state?: DeliverableState | undefined;
}

export interface Placement {
  readonly to: WorkItemStatus;
  readonly reason: string;
}

/** The placement for an item, or `undefined` when it is not in needs_closeout or blocked, or its state could not be read. */
export function placementFor(input: PlacementInput): Placement | undefined {
  if (input.status === "blocked")
    return { to: "needs_triage", reason: PLACEMENT_REASONS.triage };
  if (input.status !== "needs_closeout") return undefined;
  if (!input.pr?.trim()) {
    return input.type === "spike"
      ? { to: "needs_research", reason: PLACEMENT_REASONS.research }
      : { to: "needs_implement", reason: PLACEMENT_REASONS.implement };
  }
  switch (input.state) {
    case "merged":
      return { to: "done", reason: PLACEMENT_REASONS.done };
    case "open":
      return { to: "needs_implementation_review", reason: PLACEMENT_REASONS.review };
    case "closed":
      return { to: "needs_implement", reason: PLACEMENT_REASONS.implement };
    default:
      return undefined;
  }
}
