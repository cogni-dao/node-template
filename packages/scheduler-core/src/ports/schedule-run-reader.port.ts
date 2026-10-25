// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: scheduler-core/schedule-run-reader
 * Purpose: Read run history through schedule ownership.
 * Scope: Read-only user port; does not execute or mutate runs.
 * Invariants: Caller owns the schedule; cursor retains database timestamp precision.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import type { UserId } from "@cogni/ids";
import type { GraphRun } from "../types";

export class InvalidScheduleRunCursorError extends Error {
  constructor() {
    super("Invalid history cursor. Refresh to see the latest runs.");
    this.name = "InvalidScheduleRunCursorError";
  }
}

export interface ScheduleRunReader {
  /** Immutable slot DESC NULLS LAST, row ID DESC; fetch limit + 1. */
  listRuns: (
    caller: UserId,
    scheduleId: string,
    options: { limit: number; cursor?: string }
  ) => Promise<GraphRun[]>;
}
