// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (work-goals)`
 * Purpose: Which goal and KPI a work item moves (task.0112). Goal is inherited, never stored: the metric an item moves is a goal's KPI, or serves a KPI, and the KPI's goal is the item's goal. A `goal:<id>` label is only the fallback.
 * Scope: Pure functions over the goal read (`GoalsProgress`). Never reads, never derives a status.
 * Invariants:
 *   - KPI_THEN_SERVES_THEN_LABEL: a moved metric that is a KPI binding resolves to that goal; else a metric that serves a KPI resolves to that KPI's goal; else the item's first resolvable `goal:` label.
 *   - LABEL_SPELLINGS: `goal:<slug>` and `goal:goal-<slug>` name the same goal; the label resolves only against goals the read lists, so a raw label is never displayed.
 *   - FIRST_RESOLVABLE_MOVE_WINS: moves are tried in order; a metric that serves no bound KPI is skipped for the goal.
 * Side-effects: none
 * Links: ./work-moves.tsx, ../work-goals.tsx, ./metrics-view.ts
 * @public
 */

import type { GoalProgress, GoalsProgress } from "@cogni-dao/metrics/contracts";

import type { WorkGoalSubject } from "../work-goals.js";
import { type MetricRow, notServingRows, servedRows } from "./metrics-view.js";
import type { GoalKpi } from "./presentation.js";

/** Where a moved metric sits in the goal read. */
export type MoveChain =
  | { readonly kind: "kpi"; readonly goal: GoalProgress; readonly kpi: GoalKpi }
  | { readonly kind: "serves"; readonly goal: GoalProgress; readonly kpi: GoalKpi; readonly row: MetricRow }
  | { readonly kind: "unserved"; readonly row: MetricRow };

/** A KPI binding first (the metric is the KPI), then a KPI whose served list holds it, then a listed metric that serves none. */
export function locateMetric(data: GoalsProgress, metricId: string): MoveChain | null {
  for (const goal of data.goals)
    for (const kpi of goal.kpis) if (kpi.binding.metricId === metricId) return { kind: "kpi", goal, kpi };
  for (const goal of data.goals)
    for (const kpi of goal.kpis) {
      const row = servedRows(kpi, data).find((r) => r.id === metricId);
      if (row) return { kind: "serves", goal, kpi, row };
    }
  const row = notServingRows(data).find((r) => r.id === metricId);
  return row ? { kind: "unserved", row } : null;
}

const GOAL_LABEL = /^goal:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** The goal a `goal:<slug>` or `goal:goal-<slug>` label names among the goals the read lists. */
export function goalForLabels(data: Pick<GoalsProgress, "goals">, labels: readonly string[]): GoalProgress | null {
  for (const label of labels) {
    const slug = GOAL_LABEL.exec(label)?.[1];
    if (!slug) continue;
    const ids = slug.startsWith("goal-") ? [slug, slug.slice(5)] : [`goal-${slug}`, slug];
    for (const id of ids) {
      const goal = data.goals.find((g) => g.id === id);
      if (goal) return goal;
    }
  }
  return null;
}

/** The goal id a `goal:<slug>` or `goal:goal-<slug>` label names, without needing the goals read; null when no label does. */
export function goalIdFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const slug = GOAL_LABEL.exec(label)?.[1];
    if (slug) return slug.startsWith("goal-") ? slug : `goal-${slug}`;
  }
  return null;
}

export interface ResolvedWorkGoal {
  readonly goal: GoalProgress;
  readonly via: "kpi" | "serves" | "label";
}

/** The goal an item moves; null when its moves reach no goal and no label names a listed goal. */
export function resolveWorkGoal(data: GoalsProgress, item: WorkGoalSubject): ResolvedWorkGoal | null {
  for (const move of item.moves ?? []) {
    const chain = locateMetric(data, move.metricId);
    if (chain && chain.kind !== "unserved") return { goal: chain.goal, via: chain.kind };
  }
  const goal = goalForLabels(data, item.labels);
  return goal ? { goal, via: "label" } : null;
}
