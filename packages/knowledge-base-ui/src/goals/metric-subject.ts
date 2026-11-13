// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metric-subject)`
 * Purpose: The one shape the metric card and the metric chart draw. A KPI is a
 *   metric bound to a goal with a target; a supporting metric is a metric bound
 *   to a KPI, with an optional band; a metric's own page is the same metric
 *   read directly. Each maps into `MetricSubject`, so there is one foundation
 *   and one component, never a KPI view and a second metric view.
 * Scope: Pure mapping from `@cogni-dao/metrics/contracts` shapes. Never derives
 *   a status (assessKpi did) and never invents a target or a reading.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT; NO_TARGET_NO_VERDICT (a healthy metric
 *   with nothing to judge it against has `status: null`, drawn neutrally, never
 *   as a failed or missing state); UNKNOWN_IS_NOT_ZERO (no value stays null).
 * Side-effects: none
 * Links: ./metric-card.tsx, ./metric-chart.tsx, ./metrics-view.ts
 * @public
 */

import type {
  KpiBinding,
  KpiReason,
  KpiStatus,
  MetricBrief,
  MetricDisplay,
  MetricHistory,
  MetricReadResponse,
  MetricServesRole,
} from "@cogni-dao/metrics/contracts";

import { type MetricFlag, type MetricRow, metricStatus, rowValue } from "./metrics-view.js";
import type { GoalKpi } from "./presentation.js";

/** Which level of the goal -> KPI -> metric hierarchy a subject is. */
export type MetricLevel = "kpi" | "metric";

/** What a reading is judged against: a KPI's binding or a metric's band. */
export type SubjectTarget = Pick<KpiBinding, "comparator" | "target">;

export interface MetricSubject {
  readonly level: MetricLevel;
  readonly id: string;
  readonly title: string;
  readonly display: MetricDisplay;
  readonly unit: string;
  /** Null when nothing judges this metric (a metric without a band). */
  readonly target: SubjectTarget | null;
  /** The verdict against `target`. Null when there is no target and the latest reading is healthy. */
  readonly status: KpiStatus | null;
  readonly reason: KpiReason | null;
  readonly value: number | null;
  readonly observedAt: string | null;
  readonly observationId: string | null;
  readonly viewState: GoalKpi["viewState"];
  readonly cadenceSeconds: number | null;
  /** The 30-day daily series the goal read carries; null when it carries none. */
  readonly trend: MetricHistory | null;
  /** The last 24 hourly buckets the goal read carries, when it does. */
  readonly recent: MetricHistory | null;
  /**
   * True when the goal read carries no series for this metric (a supporting
   * metric): the card reads it through the same history route the chart uses.
   */
  readonly ownSeries: boolean;
  /** How a supporting metric relates to its KPI, as secondary metadata only. */
  readonly role: MetricServesRole | null;
  /** What it is, how it is computed, why it matters and how it accrues; null when none is declared. */
  readonly brief: MetricBrief | null;
  readonly flags: readonly MetricFlag[];
}

/** A supporting metric has no author-chosen display in the goal read; it reads as an amount over time. */
export const DEFAULT_METRIC_DISPLAY: MetricDisplay = "volume";

/** A KPI: the metric bound to a goal, judged against the binding's target. */
export function kpiSubject(kpi: GoalKpi): MetricSubject {
  const a = kpi.assessment;
  return {
    level: "kpi",
    id: kpi.metric?.id ?? kpi.binding.metricId,
    title: kpi.metric?.title ?? kpi.binding.metricId,
    display: kpi.metric?.display ?? "progress",
    unit: kpi.binding.target.unit,
    target: { comparator: kpi.binding.comparator, target: kpi.binding.target },
    status: a.status,
    reason: a.reason,
    value: a.value,
    observedAt: a.observedAt,
    observationId: a.observationId,
    viewState: kpi.viewState,
    cadenceSeconds: kpi.metric?.cadenceSeconds ?? null,
    trend: kpi.trend,
    recent: kpi.recent ?? null,
    ownSeries: false,
    role: null,
    brief: kpi.metric?.brief ?? null,
    flags: [],
  };
}

/** A metric the goal read lists (serving a KPI, flagged, or unbound): judged by its band when it has one. */
export function rowSubject(row: MetricRow): MetricSubject {
  const a = row.assessment;
  const { value, unit, observedAt } = rowValue(row);
  const status = metricStatus(row);
  return {
    level: "metric",
    id: row.id,
    title: row.title,
    display: DEFAULT_METRIC_DISPLAY,
    unit,
    target: a ? { comparator: a.comparator, target: a.target } : null,
    status: status === "no_band" ? null : status,
    reason: a?.reason ?? null,
    value,
    observedAt,
    observationId: a && a.value !== null ? a.observationId : null,
    viewState: row.latest?.viewState,
    cadenceSeconds: null,
    trend: null,
    recent: null,
    ownSeries: true,
    role: row.role,
    brief: row.brief,
    flags: row.flags,
  };
}

/**
 * A metric read directly (its own page): the same subject, from the metric read
 * response. `definition.band` and `bandAssessment` judge it when it has a band.
 * Missing fields read as "no reading" or "no target", never as zero.
 */
export function readSubject(read: MetricReadResponse, fallbackId: string): MetricSubject {
  // A failed or partial read may lack the definition; never throw on it.
  const definition = read.definition as MetricReadResponse["definition"] | undefined;
  const good = read.lastGood ?? null;
  const band = read.bandAssessment ?? null;
  const value = band && band.value !== null ? band.value : (good?.value ?? null);
  const bandTarget = band ? { comparator: band.comparator, target: band.target } : null;
  const state = read.viewState;
  const status: KpiStatus | null = band
    ? band.status
    : state === "pending"
      ? "building"
      : state === "error" || state === "unavailable"
        ? "failing"
        : state === "stale"
          ? "delayed"
          : null;
  return {
    level: "metric",
    id: definition?.id ?? fallbackId,
    title: definition?.title ?? fallbackId,
    display: definition?.display ?? DEFAULT_METRIC_DISPLAY,
    unit: good?.unit ?? band?.unit ?? "",
    target: bandTarget,
    status,
    reason: band?.reason ?? null,
    value,
    observedAt: band && band.value !== null ? band.observedAt : (good?.observedAt ?? null),
    observationId: band && band.value !== null ? band.observationId : (good?.id ?? null),
    viewState: state,
    cadenceSeconds: definition?.spec?.cadenceSeconds ?? null,
    trend: null,
    recent: null,
    ownSeries: true,
    role: definition?.serves?.role ?? null,
    brief: definition?.brief ?? null,
    flags: [],
  };
}
