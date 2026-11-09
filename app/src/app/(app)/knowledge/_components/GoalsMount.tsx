// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GoalsMount`
 * Purpose: This node's mount of the Goals capability published by `@cogni/knowledge-base-ui/goals` (task.0062): the board, the measurement evidence, and the Goals tab badge read.
 * Scope: Composition only. The package owns the board, chart, range control, evidence view, read client and poll contract. The node supplies the routes' base URL (the package default, `/api/v1/metrics`, with the page's cookie session), Next's `Link` for client navigation, and the `?observation=` URL value.
 * Invariants: No Goals markup, formatting or fetching lives in the app.
 * Side-effects: none beyond the package's GET reads
 * Links: task.0062, packages/knowledge-base-ui/AGENTS.md
 * @internal
 */

"use client";

import {
  GoalsBoard,
  type GoalsBoardProps,
  MetricEvidence,
  type UseGoalsProgressOptions,
  useGoalsProgress,
} from "@cogni/knowledge-base-ui/goals";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

export function KnowledgeGoalsBoard(
  props: Omit<GoalsBoardProps, "LinkComponent">
) {
  return <GoalsBoard LinkComponent={Link} {...props} />;
}

/** Evidence for a metric entry; the linked reading comes from `?observation=`. */
export function KnowledgeMetricEvidence({ id }: { readonly id: string }) {
  return (
    <MetricEvidence
      id={id}
      observationId={useSearchParams().get("observation")}
    />
  );
}

/** One cached goal-progress read shared with the board; the tab badge never polls. */
export function useKnowledgeGoalsBadge(
  options: Omit<UseGoalsProgressOptions, "poll">
) {
  return useGoalsProgress({ ...options, poll: false });
}
