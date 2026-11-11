// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metrics-view)`
 * Purpose: Pure presentation for the Metrics view (story.0039): one row type for
 *   every metric the goal read lists (served, orphan, unbound), the fixed
 *   worst-first order for goals, KPIs, role groups and rows, the "not serving a
 *   KPI" group with its flags, counts, and the age of a reading.
 * Scope: Pure functions over `@cogni-dao/metrics/contracts` shapes. The server
 *   already joined each metric to its KPI; nothing here joins, derives a status
 *   or reads a clock (callers pass the read's `asOf`).
 * Invariants: SERVER_GROUPS_BROWSER_DRAWS (rows come from `served`, `orphans`
 *   and `unbound` as sent); RED_FIRST (one rank, `STATUS_RANK`, orders every
 *   level; ties keep server order, then title); NO_BAND_NO_VERDICT (a metric
 *   without a band is "No band", or the state of a bad latest reading, never a
 *   KPI status); UNKNOWN_IS_NOT_ZERO (no value stays null).
 * Side-effects: none
 * Links: ./presentation.ts, packages/metrics/src/contracts.ts
 * @public
 */

import type {
  GoalProgress,
  GoalsProgress,
  KpiAssessment,
  KpiStatus,
  MetricLatest,
  MetricOrphan,
  MetricServesRole,
} from "@cogni-dao/metrics/contracts";

import { formatDate, formatNumber, STATUS_RANK, type GoalKpi } from "./presentation.js";

/** Input moves the KPI, a guardrail keeps it honest, a diagnostic explains it. */
export const ROLE_ORDER: readonly MetricServesRole[] = ["input", "guardrail", "diagnostic"];

export const ROLE_META = {
  input: { label: "Inputs", hint: "move the KPI" },
  guardrail: { label: "Guardrails", hint: "keep it honest" },
  diagnostic: { label: "Diagnostics", hint: "explain it" },
} as const satisfies Record<MetricServesRole, { label: string; hint: string }>;

type OrphanReason = MetricOrphan["reason"];

/** Why a metric sits in the "not serving a KPI" group, or carries a warning chip. */
export type MetricFlag =
  | { readonly kind: "unbound" }
  | { readonly kind: "serves_unknown_kpi"; readonly kpi: string | null }
  | { readonly kind: "serves_invalid" }
  | { readonly kind: "band_invalid" };

/** One metric as the view draws it, whichever list it came from. */
export interface MetricRow {
  readonly id: string;
  readonly title: string;
  readonly calculatorId: string;
  readonly role: MetricServesRole | null;
  readonly assessment: KpiAssessment | null;
  readonly latest: MetricLatest | null;
  readonly flags: readonly MetricFlag[];
}

/** A KPI status, or "no_band": a healthy latest reading with no band to judge. */
export type MetricStatus = KpiStatus | "no_band";

/** Worst-first position of a KPI status. Unknown statuses sort last. */
export function statusRank(status: KpiStatus): number {
  const i = STATUS_RANK.indexOf(status);
  return i < 0 ? STATUS_RANK.length : i;
}

/**
 * What a row shows as its status. A band's assessment wins. Without a band the
 * latest reading's state speaks: an error or missing reading is red (absent is
 * red), a stale one is delayed, a pending one is building; a good reading is "no_band".
 */
export function metricStatus(row: Pick<MetricRow, "assessment" | "latest">): MetricStatus {
  if (row.assessment) return row.assessment.status;
  switch (row.latest?.viewState) {
    case "error":
    case "unavailable":
      return "failing";
    case "stale":
      return "delayed";
    case "pending":
      return "building";
    default:
      return "no_band";
  }
}

/** A row with no band and a good reading is unjudged: after every problem, before healthy. */
export function metricRank(row: Pick<MetricRow, "assessment" | "latest">): number {
  const s = metricStatus(row);
  return statusRank(s === "no_band" ? "not_measured" : s);
}

function compareRows(a: MetricRow, b: MetricRow): number {
  return metricRank(a) - metricRank(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function sortMetricRows(rows: readonly MetricRow[]): MetricRow[] {
  return [...rows].sort(compareRows);
}

/** Goals, worst KPI first; a goal with no KPIs last. Ties keep server order. */
export function sortGoals(goals: readonly GoalProgress[]): GoalProgress[] {
  const rank = (g: GoalProgress) =>
    g.kpis.length ? Math.min(...g.kpis.map((k) => statusRank(k.assessment.status))) : STATUS_RANK.length + 1;
  return goals
    .map((goal, i) => ({ goal, i, r: rank(goal) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.goal);
}

/** A KPI with its position in the goal's bindings, which is its stable key. */
export interface RankedKpi {
  readonly kpi: GoalKpi;
  readonly index: number;
}

/** KPIs, worst status first. The original index stays the card's key, so a reorder never swaps cards. */
export function sortKpis(kpis: readonly GoalKpi[]): RankedKpi[] {
  return kpis
    .map((kpi, index) => ({ kpi, index }))
    .sort((a, b) => statusRank(a.kpi.assessment.status) - statusRank(b.kpi.assessment.status) || a.index - b.index);
}

function flagsFor(orphans: readonly MetricOrphan[] | undefined): Map<string, MetricFlag[]> {
  const byId = new Map<string, MetricFlag[]>();
  for (const o of orphans ?? []) {
    const flag: MetricFlag =
      o.reason === "serves_unknown_kpi"
        ? { kind: "serves_unknown_kpi", kpi: o.kpi }
        : { kind: o.reason };
    const list = byId.get(o.metricId) ?? [];
    if (!list.some((f) => f.kind === flag.kind)) list.push(flag);
    byId.set(o.metricId, list);
  }
  return byId;
}

/** A KPI's served metrics as rows, each with the warning chips the orphan list holds for it. */
export function servedRows(kpi: GoalKpi, data: Pick<GoalsProgress, "orphans">): MetricRow[] {
  const flags = flagsFor(data.orphans);
  return (kpi.served ?? []).map((s) => ({
    id: s.metric.id,
    title: s.metric.title,
    calculatorId: s.metric.calculatorId,
    role: s.metric.role,
    assessment: s.assessment,
    latest: s.latest ?? null,
    flags: flags.get(s.metric.id) ?? [],
  }));
}

export interface RoleGroup {
  readonly role: MetricServesRole;
  readonly rows: readonly MetricRow[];
}

/** Rows grouped by role in `ROLE_ORDER`, worst first inside each group; empty roles are dropped. */
export function groupByRole(rows: readonly MetricRow[]): RoleGroup[] {
  return ROLE_ORDER.flatMap((role) => {
    const inRole = rows.filter((r) => r.role === role);
    return inRole.length ? [{ role, rows: sortMetricRows(inRole) }] : [];
  });
}

/** The worst status among rows that have one; null when none is judged. */
export function worstRowStatus(rows: readonly MetricRow[]): KpiStatus | null {
  let worst: KpiStatus | null = null;
  for (const r of rows) {
    const s = metricStatus(r);
    if (s === "no_band") continue;
    if (worst === null || statusRank(s) < statusRank(worst)) worst = s;
  }
  return worst;
}

/**
 * Metrics that serve no bound KPI: no `serves` at all, a `serves` that names a
 * KPI no goal binds, or an invalid `serves`. Sorted worst first. A metric with
 * only an invalid band still serves its KPI and shows there with a chip.
 */
export function notServingRows(data: Pick<GoalsProgress, "orphans" | "unbound">): MetricRow[] {
  const flags = flagsFor(data.orphans);
  const rows = new Map<string, MetricRow>();
  for (const o of data.orphans ?? []) {
    if (o.reason === "band_invalid" || rows.has(o.metricId)) continue;
    rows.set(o.metricId, {
      id: o.metricId,
      title: o.title ?? o.metricId,
      calculatorId: "",
      role: null,
      assessment: o.assessment,
      latest: o.latest ?? null,
      flags: flags.get(o.metricId) ?? [],
    });
  }
  for (const u of data.unbound ?? []) {
    if (rows.has(u.metric.id)) continue;
    rows.set(u.metric.id, {
      id: u.metric.id,
      title: u.metric.title,
      calculatorId: u.metric.calculatorId,
      role: null,
      assessment: u.assessment,
      latest: u.latest,
      flags: [{ kind: "unbound" }],
    });
  }
  return sortMetricRows([...rows.values()]);
}

/** Plain words for each flag. Exhaustive by kind. */
export function flagText(flag: MetricFlag): string {
  switch (flag.kind) {
    case "unbound":
      return "Serves no KPI";
    case "serves_unknown_kpi":
      return flag.kpi ? `Names an unbound KPI: ${flag.kpi}` : "Names an unbound KPI";
    case "serves_invalid":
      return "Invalid serves";
    case "band_invalid":
      return "Invalid band";
  }
}

export interface MetricsSummary {
  /** Distinct metrics the read lists: the KPIs' own metrics, the metrics that serve them and the ones that serve none. */
  readonly metrics: number;
  /** Metrics that serve no bound KPI. */
  readonly notServing: number;
}

export function summarizeMetrics(data: GoalsProgress): MetricsSummary {
  const ids = new Set<string>();
  for (const g of data.goals)
    for (const k of g.kpis) {
      ids.add(k.binding.metricId);
      for (const r of servedRows(k, data)) ids.add(r.id);
    }
  const not = notServingRows(data);
  for (const r of not) ids.add(r.id);
  return { metrics: ids.size, notServing: not.length };
}

/** True when the read carries metric detail (`orphans`, `unbound`); false on a server older than 0.10.0 or after an outage. */
export function hasMetricDetail(data: GoalsProgress): boolean {
  return data.orphans !== undefined && data.unbound !== undefined;
}

// ---------------------------------------------------------------- reading

/** "just now", "12m ago", "5h ago", "3d ago": the age of a reading against the read's own `asOf`. */
export function formatAge(observedAt: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(observedAt);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The value a row shows: the band's value, else the last good reading; null is "—", never 0. */
export function rowValue(row: MetricRow): { value: number | null; unit: string; observedAt: string | null } {
  const a = row.assessment;
  if (a && a.value !== null) return { value: a.value, unit: a.unit, observedAt: a.observedAt };
  const l = row.latest;
  if (l) return { value: l.value, unit: l.unit, observedAt: l.observedAt };
  return { value: null, unit: a?.unit ?? "", observedAt: null };
}

export function formatRowValue(value: number, unit: string): string {
  return unit === "%" ? `${formatNumber(value)}%` : formatNumber(value, unit);
}

/** The band as words: "≥ 90 items". Null without a band. */
export function bandText(row: MetricRow): string | null {
  const a = row.assessment;
  if (!a) return null;
  const sym = { gte: "≥", lte: "≤", eq: "=" }[a.comparator];
  return `${sym} ${formatRowValue(a.target.value, a.target.unit)}${a.target.unit === "%" ? "" : ` ${a.target.unit}`}`;
}

/** Meter fill 0..1 toward the band; null without a band or a value. */
export function bandFraction(row: MetricRow): number | null {
  const a = row.assessment;
  const { value } = rowValue(row);
  if (!a || value === null) return null;
  const t = a.target.value;
  const meets = a.comparator === "gte" ? value >= t : a.comparator === "lte" ? value <= t : value === t;
  if (meets) return 1;
  if (a.comparator === "lte") return value > 0 ? Math.max(0, t / value) : 0;
  return t > 0 ? Math.max(0, Math.min(1, value / t)) : 0;
}

/** Hover title for a reading's time: the exact UTC date. */
export function readingTitle(observedAt: string): string {
  return `Read ${formatDate(observedAt, true)} ${new Date(observedAt).toISOString().slice(11, 16)} UTC`;
}
