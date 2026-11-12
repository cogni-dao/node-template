// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-goals`
 * Purpose: How the work table and board learn an item's goal without reading it themselves: a host supplies one resolver (the `./goals` entry's `WorkGoalsScope` builds it from the cached goals read) and each cell asks it for the goal title (task.0112).
 * Scope: A context, a provider and a hook. No fetching and no goals imports, so the root entry stays free of the `@cogni-dao/metrics` peer.
 * Invariants:
 *   - GOAL_IS_INHERITED: the goal is never stored on the item; the resolver derives it from the item's moves, else a `goal:` label.
 *   - NO_RESOLVER_NO_GOAL: without a provider every item resolves to no goal ("—"), never to a raw label.
 * Side-effects: none
 * Links: ./goals/work-goals.ts, ./goals/work-goals-scope.tsx
 * @public
 */

"use client";

import { createContext, type ReactNode, useContext } from "react";

/** The structural subset of a work item a goal is resolved from. */
export interface WorkGoalSubject {
  readonly labels: readonly string[];
  readonly moves?: readonly { readonly metricId: string }[] | null | undefined;
}

/** A goal as the work views show it: its id and its title. */
export interface WorkGoalRef {
  readonly id: string;
  readonly title: string;
}

export type WorkGoalResolver = (item: WorkGoalSubject) => WorkGoalRef | null;

const NO_GOALS: WorkGoalResolver = () => null;
const WorkGoalsContext = createContext<WorkGoalResolver>(NO_GOALS);

export function WorkGoalsProvider({
  resolve,
  children,
}: {
  readonly resolve: WorkGoalResolver;
  readonly children: ReactNode;
}) {
  return <WorkGoalsContext.Provider value={resolve}>{children}</WorkGoalsContext.Provider>;
}

/** The goal an item moves (else its normalized `goal:` label), or null. */
export function useWorkGoal(item: WorkGoalSubject): WorkGoalRef | null {
  return useContext(WorkGoalsContext)(item);
}
