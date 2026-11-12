// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (kpi-chart)`
 * Purpose: The open KPI chart: a KPI is a metric bound to a goal, so it opens the
 *   one metric chart with its binding as the target. No second chart exists.
 * Scope: Client component; maps a goal KPI to a `MetricSubject` and renders `MetricChart`.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT (see ./metric-chart.tsx).
 * Side-effects: IO (via GoalsClient.fetchHistory, inside MetricChart)
 * Links: ./metric-chart.tsx, ./metric-subject.ts
 * @public
 */

"use client";

import { initialRangeOf, MetricChart } from "./metric-chart.js";
import { kpiSubject } from "./metric-subject.js";
import type { GoalKpi, HistoryRange } from "./presentation.js";

/** Hourly metrics open on the day until they have days of shape, then the week. */
export function initialRange(kpi: GoalKpi): HistoryRange {
  return initialRangeOf(kpiSubject(kpi));
}

export function KpiChart({
  kpi,
  nowIso,
  id,
}: {
  readonly kpi: GoalKpi;
  readonly nowIso: string;
  /** DOM id, so the card that opens this chart can point at it. */
  readonly id?: string;
}) {
  return <MetricChart subject={kpiSubject(kpi)} nowIso={nowIso} {...(id ? { id } : {})} />;
}
