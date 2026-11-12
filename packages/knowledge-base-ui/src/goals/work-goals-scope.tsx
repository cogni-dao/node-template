// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (work-goals-scope)`
 * Purpose: Feeds the work table and board their goal titles (task.0112): one wrapper that resolves each item's goal from the cached goals read and hands it to the root `WorkGoalsProvider`.
 * Scope: Client component. Reads `useGoalsProgress({ poll: false })`, the same cache entry the Metrics page and the work detail use, so a table of any size costs one read and no per-row requests.
 * Invariants:
 *   - ONE_READ_FOR_ALL_ROWS: rows resolve against one in-memory read; nothing here fetches per item.
 *   - QUIET_WHEN_UNAVAILABLE: while the read is loading or failed every item resolves to no goal ("—"); the table never shows a raw label instead.
 * Side-effects: IO (the shared goals read)
 * Links: ./work-goals.ts, ../work-goals.tsx
 * @public
 */

"use client";

import { type ReactNode, useMemo } from "react";

import { type WorkGoalResolver, WorkGoalsProvider } from "../work-goals.js";
import { useGoalsProgress } from "./use-goals-progress.js";
import { resolveWorkGoal } from "./work-goals.js";

export function WorkGoalsScope({ children }: { readonly children: ReactNode }) {
  const data = useGoalsProgress({ poll: false }).data;
  const resolve = useMemo<WorkGoalResolver>(
    () => (item) => {
      const found = data ? resolveWorkGoal(data, item) : null;
      return found ? { id: found.goal.id, title: found.goal.title } : null;
    },
    [data],
  );
  return <WorkGoalsProvider resolve={resolve}>{children}</WorkGoalsProvider>;
}
