// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/transitions`
 * Purpose: The stage order of a work item (task.0122, hub work-status-ladder): one global order and the structural moves
 *   between stages. Which artifact a forward move needs lives in `gates.ts`.
 * Scope: Pure data constants and validators. Does not perform I/O.
 * Invariants:
 *   - ONE_ORDER: triage < research < design < design_review < implement < implementation_review < validation < merge <
 *     done. Each item uses the stages on its path; `evaluateMove` computes the path.
 *   - TRANSITION_TABLE_COMPLETE: every WorkItemStatus has an entry; the key order is the board column order. The legacy
 *     `blocked` and `needs_closeout` stay readable until every node has migrated; nothing enters them.
 *   - BACK_IS_FREE_FORWARD_IS_ONE: a move to `needs_triage` or an earlier stage, or to `cancelled`, is structurally allowed;
 *     a forward move is allowed only to a stage that can follow its source on some path.
 *   - TERMINAL_STAYS_TERMINAL: `done` and `cancelled` have no exits.
 *   - STRUCTURE_IS_NOT_PROOF: `isValidTransition` says a move may exist; `evaluateMove` says whether its artifacts do.
 * Side-effects: none
 * Links: hub work-status-ladder
 * @public
 */

import type { WorkItemStatus } from "./types.js";

/** The stages of the ladder, earliest first. `needs_triage` is stage zero. */
export const STATUS_ORDER = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_design_review",
  "needs_implement",
  "needs_implementation_review",
  "needs_validation",
  "needs_merge",
  "done",
] as const satisfies readonly WorkItemStatus[];

/** Statuses the package still reads but never enters (until every fleet node has migrated). */
export const LEGACY_STATUSES = [
  "needs_closeout",
  "blocked",
] as const satisfies readonly WorkItemStatus[];

/** Position in the ladder, or -1 for a status outside it (`blocked`, `needs_closeout`, `cancelled`). */
export function statusRank(status: WorkItemStatus): number {
  return (STATUS_ORDER as readonly WorkItemStatus[]).indexOf(status);
}

/** Whether `status` is a legacy status that no write enters. */
export function isLegacyStatus(status: WorkItemStatus): boolean {
  return (LEGACY_STATUSES as readonly WorkItemStatus[]).includes(status);
}

/**
 * The stages a forward move may reach from each stage on SOME path. The exact next stage depends on the item's path
 * (`evaluateMove`): triage routes to research, design or implement; implement goes to review or, for a story, validation;
 * a knowledge-only item skips validation.
 */
export const FORWARD_TARGETS: ReadonlyMap<WorkItemStatus, readonly WorkItemStatus[]> =
  new Map<WorkItemStatus, readonly WorkItemStatus[]>([
    ["needs_triage", ["needs_research", "needs_design", "needs_implement"]],
    ["needs_research", ["done"]],
    ["needs_design", ["needs_design_review"]],
    ["needs_design_review", ["needs_implement"]],
    ["needs_implement", ["needs_implementation_review", "needs_validation"]],
    ["needs_implementation_review", ["needs_validation", "needs_merge"]],
    ["needs_validation", ["needs_merge", "done"]],
    ["needs_merge", ["done"]],
  ]);

const BACK_OR_CANCEL = (from: WorkItemStatus): WorkItemStatus[] => {
  const rank = statusRank(from);
  return [
    ...STATUS_ORDER.filter((status) => statusRank(status) < rank),
    "cancelled",
  ];
};

/**
 * Structural moves, by current status. The keys are the board's status columns, in order; the legacy statuses follow the
 * ladder. A move listed here is only possible: a forward move also needs its exit artifact (`evaluateMove`).
 */
export const VALID_TRANSITIONS: ReadonlyMap<
  WorkItemStatus,
  readonly WorkItemStatus[]
> = new Map<WorkItemStatus, readonly WorkItemStatus[]>([
  ...STATUS_ORDER.filter((status) => status !== "done").map(
    (status): [WorkItemStatus, readonly WorkItemStatus[]] => [
      status,
      [...BACK_OR_CANCEL(status), ...(FORWARD_TARGETS.get(status) ?? [])],
    ]
  ),
  ["done", []],
  // Legacy: a move back to triage or a cancel; the placement job moves the rest.
  ["blocked", ["needs_triage", "cancelled"]],
  ["needs_closeout", ["needs_triage", "cancelled"]],
  ["cancelled", []],
]);

/** Whether the move may exist at all. Terminal states have no exits; nothing enters a legacy status. */
export function isValidTransition(
  from: WorkItemStatus,
  to: WorkItemStatus
): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed?.includes(to) ?? false;
}
