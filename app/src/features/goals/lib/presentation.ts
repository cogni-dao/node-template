// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/presentation`
 * Purpose: Pure presentation for the Goals tab: status words and symbols, plain
 *   reason text, number/unit/date formatting, summary counts, sparkline data,
 *   history ranges (hourly 1D/1W, daily 1M/3M, All from the proven series
 *   start) and the hero label.
 * Scope: Pure functions over `@cogni-dao/metrics/contracts` shapes. Never
 *   decides status (assessKpi does); never fills, bridges or invents readings.
 * Invariants: STATUS_HAS_WORD_AND_SYMBOL (color is never the only signal);
 *   EVERY_REASON_HAS_PLAIN_TEXT (exhaustive over KpiReason); GAPS_STAY_GAPS.
 * Side-effects: none
 * Links: packages/metrics/src/contracts.ts, .context/design-0024/goals-visual.html
 * @public
 */

import type {
  GoalProgress,
  KpiAssessment,
  KpiReason,
  KpiStatus,
  MetricHistory,
  MetricHistoryStep,
} from "@cogni-dao/metrics/contracts";

export type GoalKpi = GoalProgress["kpis"][number];
export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** One word and one symbol per status. Color is a third, redundant signal. */
export const STATUS_META = {
  on_track: { symbol: "●", label: "On track", short: "On track", tone: "success" },
  behind: { symbol: "▼", label: "Behind pace", short: "Behind", tone: "warning" },
  met: { symbol: "✓", label: "Met", short: "Met", tone: "success" },
  missed: { symbol: "✕", label: "Missed", short: "Missed", tone: "danger" },
  delayed: { symbol: "◷", label: "Delayed", short: "Delayed", tone: "warning" },
  failing: { symbol: "!", label: "Failing", short: "Failing", tone: "danger" },
  building: { symbol: "…", label: "Building", short: "Building", tone: "neutral" },
  not_measured: {
    symbol: "○",
    label: "Not measured",
    short: "Not measured",
    tone: "neutral",
  },
  evaluating: {
    symbol: "◌",
    label: "Evaluating",
    short: "Evaluating",
    tone: "neutral",
  },
  unresolved: {
    symbol: "?",
    label: "Unresolved",
    short: "Unresolved",
    tone: "neutral",
  },
} as const satisfies Record<
  KpiStatus,
  { symbol: string; label: string; short: string; tone: StatusTone }
>;

/** Every machine reason in one sentence a person can act on. */
export const REASON_TEXT = {
  no_binding: "No metric is bound to this goal yet.",
  calculator_unavailable: "Its calculator is not installed on this node.",
  metric_unavailable: "Its metric definition is missing or unreadable.",
  metric_authority_unavailable: "The metric store cannot be reached right now.",
  insufficient_history: "Not enough history yet to cover the KPI window.",
  zero_denominator: "Nothing to divide by yet: the denominator is zero.",
  history_unavailable: "The source history could not be read.",
  source_failed: "The data source returned an error.",
  source_timeout: "The data source timed out.",
  incomplete_or_invalid_source: "The source returned incomplete or invalid data.",
  unit_mismatch: "The reading's unit does not match the target's unit.",
  no_reading_at_evaluation: "No reading existed at the deadline.",
  evaluation_not_due: "The evaluation date has not arrived yet.",
  baseline_unavailable_or_incompatible:
    "The baseline reading is missing or incompatible.",
  fixed_prediction_and_baseline_required:
    "This bet needs a fixed prediction and baseline.",
} as const satisfies Record<KpiReason, string>;

export function reasonText(reason: KpiReason | null): string | null {
  return reason ? REASON_TEXT[reason] : null;
}

/** Statuses that make a goal need attention (tab badge, summary). */
export const ATTENTION_STATUSES: ReadonlySet<KpiStatus> = new Set([
  "behind",
  "failing",
  "missed",
]);

export function goalNeedsAttention(goal: GoalProgress): boolean {
  return goal.kpis.some((k) => ATTENTION_STATUSES.has(k.assessment.status));
}

export function attentionCount(goals: readonly GoalProgress[]): number {
  return goals.filter(goalNeedsAttention).length;
}

/** The row speaks for its primary KPI (the first binding). */
export function primaryStatus(goal: GoalProgress): KpiStatus {
  return goal.kpis[0]?.assessment.status ?? "not_measured";
}

export function isMeasured(goal: GoalProgress): boolean {
  return goal.kpis.some((k) => k.assessment.status !== "not_measured");
}

// ---------------------------------------------------------------- formatting

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const COMPARATOR_SYMBOL = { gte: "≥", lte: "≤", eq: "=" } as const;

/** Units read with fixed precision so a value, its target and its axis align. */
const FIXED_DECIMALS: Record<string, number> = { ratio: 2 };

/** Integers stay integers; fractions get two places; a ratio always reads 0.80 and 1.00. */
export function formatNumber(value: number, unit?: string): string {
  const fixed = unit ? FIXED_DECIMALS[unit] : undefined;
  if (value === 0) return "0";
  if (fixed !== undefined)
    return new Intl.NumberFormat("en", {
      minimumFractionDigits: fixed,
      maximumFractionDigits: fixed,
    }).format(value);
  if (Number.isInteger(value))
    return new Intl.NumberFormat("en").format(value);
  const abs = Math.abs(value);
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: abs < 100 ? 2 : 0,
    maximumFractionDigits: abs < 100 ? 2 : 1,
  }).format(value);
}

/** Signed change; small paces keep two significant digits (+0.014, not +0.01). */
export function formatSigned(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const body =
    abs > 0 && abs < 0.1
      ? new Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(abs)
      : formatNumber(abs, unit);
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${body}`;
}

/** "1 item" / "2 items"; units that are not countable nouns pass through. */
export function unitLabel(value: number | null, unit: string): string {
  if (value === 1 && unit.endsWith("s") && unit.length > 2)
    return unit.slice(0, -1);
  return unit;
}

export function targetText(
  comparator: keyof typeof COMPARATOR_SYMBOL,
  target: { value: number; unit: string }
): string {
  return `${COMPARATOR_SYMBOL[comparator]} ${formatNumber(target.value, target.unit)}`;
}

const DAY_MS = 86_400_000;

export function formatDate(iso: string, withYear = false): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatUtcTime(iso: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso))} UTC`;
}

/** "10:00 UTC" today; "Oct 30, 10:00 UTC" otherwise. */
export function formatReadingTime(iso: string, nowIso: string): string {
  const sameDay =
    new Date(iso).toISOString().slice(0, 10) ===
    new Date(nowIso).toISOString().slice(0, 10);
  return sameDay
    ? formatUtcTime(iso)
    : `${formatDate(iso)}, ${formatUtcTime(iso)}`;
}

export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function daysLeft(deadline: string | null, nowIso: string): number | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - Date.parse(nowIso);
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / DAY_MS) : null;
}

/** The one-line caption under a status pill. Plain words, no IDs. */
export function statusCaption(
  a: KpiAssessment,
  nowIso: string,
  maxAgeSeconds: number | null
): string {
  const left = daysLeft(a.deadline, nowIso);
  const leftText = left === null ? null : `${plural(left, "day")} left`;
  const join = (...parts: (string | null)[]) =>
    parts.filter(Boolean).join(" · ");
  switch (a.status) {
    case "on_track":
      return join(
        a.pace.observed !== null && a.pace.observed !== 0
          ? `${formatSigned(a.pace.observed, a.unit)} / wk`
          : "At target",
        leftText
      );
    case "behind": {
      const gap =
        a.value !== null ? a.target.value - a.value : null;
      const needs =
        a.pace.needed !== null
          ? `Needs ${formatSigned(a.pace.needed, a.unit)} / wk`
          : gap !== null
            ? `Needs ${formatSigned(gap, a.unit)}`
            : "Behind target";
      return join(needs, leftText);
    }
    case "met":
    case "missed":
      return a.deadline
        ? `Final · ${formatDate(a.deadline, true)}`
        : "Final reading";
    case "delayed":
      return a.observedAt
        ? `${formatAge(Date.parse(nowIso) - Date.parse(a.observedAt))} old`
        : "Reading is late";
    case "evaluating": {
      if (!a.deadline || maxAgeSeconds === null) return "Deciding";
      const by = new Date(Date.parse(a.deadline) + maxAgeSeconds * 1000);
      return `Deciding · final by ${formatReadingTime(by.toISOString(), nowIso)}`;
    }
    case "unresolved":
      return reasonText(a.reason) ?? "No reading at the deadline.";
    case "failing":
      return reasonText(a.reason) ?? "The newest attempt failed.";
    case "building":
      return reasonText(a.reason) ?? "Collecting the first window.";
    case "not_measured":
      return reasonText(a.reason) ?? "No metric is bound to this goal yet.";
  }
}

/** A value is "current" only when the assessment speaks about a fresh reading. */
export function valueIsCurrent(status: KpiStatus): boolean {
  return (
    status === "on_track" ||
    status === "behind" ||
    status === "met" ||
    status === "missed" ||
    status === "evaluating"
  );
}

// ---------------------------------------------------------------- summary

export interface GoalsSummary {
  readonly active: number;
  readonly measured: number;
  readonly notMeasured: number;
  readonly behind: number;
  readonly failing: number;
  readonly missed: number;
  readonly deadlines: readonly string[];
  readonly lastReadingAt: string | null;
}

export function summarize(goals: readonly GoalProgress[]): GoalsSummary {
  const statuses = goals.map(
    (g) => new Set(g.kpis.map((k) => k.assessment.status))
  );
  const count = (s: KpiStatus) => statuses.filter((set) => set.has(s)).length;
  const deadlines = [
    ...new Set(goals.map((g) => g.evaluateAt).filter((d): d is string => !!d)),
  ].sort();
  let lastReadingAt: string | null = null;
  for (const g of goals)
    for (const k of g.kpis) {
      const at = k.assessment.observedAt;
      if (at && (!lastReadingAt || Date.parse(at) > Date.parse(lastReadingAt)))
        lastReadingAt = at;
    }
  const measured = goals.filter(isMeasured).length;
  return {
    active: goals.length,
    measured,
    notMeasured: goals.length - measured,
    behind: count("behind"),
    failing: count("failing"),
    missed: count("missed"),
    deadlines,
    lastReadingAt,
  };
}

export function deadlineText(
  deadlines: readonly string[],
  total: number,
  nowIso: string
): string | null {
  // A passed deadline is never "next": report it separately as past due.
  const now = Date.parse(nowIso);
  const upcoming = deadlines.filter((d) => Date.parse(d) > now);
  const pastDue = deadlines.length - upcoming.length;
  const pastText = pastDue ? `${pastDue} past due` : "";
  const first = upcoming[0];
  if (!first) return pastText || null;
  const left = daysLeft(first, nowIso);
  const leftText = left === null ? "" : ` (${plural(left, "day")})`;
  const dueText =
    upcoming.length === 1 && !pastDue
      ? `${total === 1 ? "due" : "all due"} ${formatDate(first, true)}${leftText}`
      : `next due ${formatDate(first, true)}${leftText}`;
  return pastText ? `${dueText} · ${pastText}` : dueText;
}

// ---------------------------------------------------------------- bullet

export interface BulletScale {
  readonly min: number;
  readonly max: number;
}

/** 0..max(target, value)×1.5 for gte/eq; lte keeps headroom above the ceiling. */
export function bulletScale(
  comparator: "gte" | "lte" | "eq",
  target: number,
  value: number | null
): BulletScale {
  const v = value ?? 0;
  const min = Math.min(0, v, target);
  const top =
    comparator === "lte"
      ? Math.max(target * 2, v * 1.25)
      : Math.max(target, v) * 1.5;
  const max = top > min ? niceCeil(top) : min + 1;
  return { min, max };
}

/** Round axis ticks: about `count` steps of 1, 2, 2.5 or 5 × 10^k covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const raw = (hi - lo) / Math.max(1, count - 1) || Math.abs(hi) || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw - 1e-12) ?? 10) * mag;
  const start = Math.floor(lo / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step * 0.999; t += step)
    ticks.push(Math.round(t / step) * step);
  return ticks;
}

function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10])
    if (step * mag >= n - 1e-9) return step * mag;
  return 10 * mag;
}

// ---------------------------------------------------------------- sparkline

export interface SparkDatum {
  readonly i: number;
  readonly value: number | null;
  /** An ok point with no ok neighbour: a Line draws nothing for it, so it needs a dot. */
  readonly isolated: boolean;
  readonly last: boolean;
  readonly start: string;
}

export interface SparkSeries {
  readonly data: readonly SparkDatum[];
  /** Explicit Y domain: ok values plus the target, never the Recharts [0, auto] default. */
  readonly domain: readonly [number, number];
  readonly okCount: number;
  readonly gapCount: number;
  readonly first: SparkDatum | null;
  readonly last: SparkDatum | null;
}

/** Break the line at every non-ok bucket. A missing bucket is never filled. */
export function sparkSeries(
  trend: MetricHistory | null,
  target: number | null
): SparkSeries {
  const buckets = trend?.buckets ?? [];
  const values = buckets.map((b) =>
    b.status === "ok" && b.value !== null ? b.value : null
  );
  const okIdx = values.flatMap((v, i) => (v === null ? [] : [i]));
  const lastOk = okIdx.at(-1) ?? -1;
  const data = buckets.map((b, i) => {
    const value = values[i] ?? null;
    return {
      i,
      value,
      isolated:
        value !== null &&
        (values[i - 1] ?? null) === null &&
        (values[i + 1] ?? null) === null,
      last: i === lastOk,
      start: b.start,
    };
  });
  const domainValues = [
    ...okIdx.map((i) => values[i] as number),
    ...(target !== null ? [target] : []),
  ];
  let lo = domainValues.length ? Math.min(...domainValues) : 0;
  let hi = domainValues.length ? Math.max(...domainValues) : 1;
  if (hi === lo) {
    lo -= Math.abs(lo) * 0.1 || 1;
    hi += Math.abs(hi) * 0.1 || 1;
  }
  const pad = (hi - lo) * 0.08;
  const ok = data.filter((d) => d.value !== null);
  return {
    data,
    domain: [lo - pad, hi + pad],
    okCount: ok.length,
    gapCount: buckets.length - ok.length,
    first: ok[0] ?? null,
    last: ok.at(-1) ?? null,
  };
}

export function sparklineLabel(
  s: SparkSeries,
  days: number,
  target: string | null,
  unit?: string
): string {
  if (!s.first || !s.last)
    return `Last ${days} days: no readings${target ? `; target ${target}` : ""}.`;
  const range =
    s.first === s.last
      ? `one reading, ${formatNumber(s.last.value as number, unit)} on ${formatDate(s.last.start)}`
      : `from ${formatNumber(s.first.value as number, unit)} on ${formatDate(s.first.start)} to ${formatNumber(s.last.value as number, unit)} on ${formatDate(s.last.start)}`;
  const gaps =
    s.gapCount > 0 ? `; ${plural(s.gapCount, "day")} without a reading` : "";
  return `Last ${days} days: ${range}${target ? `; target ${target}` : ""}${gaps}.`;
}

// ---------------------------------------------------------------- history range

export type HistoryRange = "1d" | "1w" | "1m" | "3m" | "all";

interface FixedRange {
  readonly id: Exclude<HistoryRange, "all">;
  readonly label: string;
  readonly title: string;
  readonly step: MetricHistoryStep;
  readonly count: number;
}

const FIXED_RANGES: readonly FixedRange[] = [
  { id: "1d", label: "1D", title: "past day", step: "1h", count: 24 },
  { id: "1w", label: "1W", title: "past week", step: "1h", count: 168 },
  { id: "1m", label: "1M", title: "past month", step: "1d", count: 30 },
  { id: "3m", label: "3M", title: "past 3 months", step: "1d", count: 90 },
];

export const HISTORY_RANGES: readonly {
  readonly id: HistoryRange;
  readonly label: string;
  readonly title: string;
}[] = [...FIXED_RANGES, { id: "all", label: "All", title: "all time" }];

export function isHistoryRange(v: string): v is HistoryRange {
  return HISTORY_RANGES.some((r) => r.id === v);
}

/** Hourly metrics open on the hourly week; everything else on the daily month. */
export function defaultRange(cadenceSeconds: number | null): HistoryRange {
  return cadenceSeconds !== null && cadenceSeconds <= 3600 ? "1w" : "1m";
}

export const STEP_MS: Record<MetricHistoryStep, number> = {
  "1h": 3_600_000,
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
};
export const STEP_WORD: Record<MetricHistoryStep, string> = {
  "1h": "hourly",
  "1d": "daily",
  "1w": "weekly",
};
const STEP_UNIT: Record<MetricHistoryStep, string> = {
  "1h": "hour",
  "1d": "day",
  "1w": "week",
};
export function stepUnit(step: MetricHistoryStep): string {
  return STEP_UNIT[step];
}
/** Weekly buckets align to Monday 2000-01-03T00:00Z (the server's origin). */
const WEEK_ORIGIN = Date.UTC(2000, 0, 3);
/** MAX_HISTORY_BUCKETS in @cogni-dao/metrics: the server rejects more. */
export const MAX_BUCKETS = 400;
/** A cropped or very young axis still shows at least this many steps. */
export const MIN_VISIBLE_STEPS = 12;

export function floorToStep(ms: number, step: MetricHistoryStep): number {
  const size = STEP_MS[step];
  const origin = step === "1w" ? WEEK_ORIGIN : 0;
  return origin + Math.floor((ms - origin) / size) * size;
}

export interface HistoryWindow {
  readonly from: string;
  readonly to: string;
  readonly step: MetricHistoryStep;
}

function windowOf(fromMs: number, toMs: number, step: MetricHistoryStep): HistoryWindow {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    step,
  };
}

/** `to` is the last closed step boundary (the server rejects to > now). */
export function historyWindow(
  range: Exclude<HistoryRange, "all">,
  nowMs: number
): HistoryWindow {
  const r = FIXED_RANGES.find((x) => x.id === range) as FixedRange;
  const to = floorToStep(nowMs, r.step);
  return windowOf(to - r.count * STEP_MS[r.step], to, r.step);
}

/**
 * The series-start probe: 400 weekly buckets ending at the last closed week.
 * It never includes the open week, because the server rejects to > now.
 */
export function probeWindow(nowMs: number): HistoryWindow {
  const to = floorToStep(nowMs, "1w");
  return windowOf(to - MAX_BUCKETS * STEP_MS["1w"], to, "1w");
}

/**
 * Proven series start: the start of the first non-missing probe week. When
 * every closed week is missing, no completed attempt exists before the open
 * week, so the start is the probe's `to`.
 */
export function seriesStartFromProbe(probe: MetricHistory): number {
  const first = probe.buckets.find((b) => b.status !== "missing");
  return Date.parse(first ? first.start : probe.to);
}

/**
 * "All": from the proven start to the last closed step, with the finest step
 * that fits 400 buckets. `from` is at least 12 steps before `to`, so the read
 * is never empty (from == to is invalid_range), and at most 400 steps.
 */
export function allWindow(
  seriesStart: number | null,
  nowMs: number
): HistoryWindow {
  if (seriesStart === null) {
    const to = floorToStep(nowMs, "1d");
    return windowOf(to - MAX_BUCKETS * DAY_MS, to, "1d");
  }
  const steps: MetricHistoryStep[] = ["1h", "1d", "1w"];
  const step =
    steps.find(
      (s) => floorToStep(nowMs, s) - seriesStart <= MAX_BUCKETS * STEP_MS[s]
    ) ?? "1w";
  const size = STEP_MS[step];
  const to = floorToStep(nowMs, step);
  const from = Math.max(
    Math.min(floorToStep(seriesStart, step), to - MIN_VISIBLE_STEPS * size),
    to - MAX_BUCKETS * size
  );
  return windowOf(from, to, step);
}

// ---------------------------------------------------------------- header

/**
 * The hero speaks for the assessment, never for the chart range. Its label
 * says which reading it is: final, at the deadline, latest or last good.
 */
export function heroLabel(
  a: Pick<KpiAssessment, "status" | "value" | "observedAt">,
  nowIso: string
): string | null {
  if (a.value === null || !a.observedAt) return null;
  const time = formatReadingTime(a.observedAt, nowIso);
  switch (a.status) {
    case "met":
    case "missed":
      return `Final · ${time}`;
    case "evaluating":
      return `At deadline · ${time}`;
    case "on_track":
    case "behind":
      return `Latest · ${time}`;
    default:
      return `Last good · ${time}`;
  }
}

/** Next scheduled reading, only when it is still ahead of `nowIso`. */
export function nextReadingAt(
  observedAt: string | null,
  cadenceSeconds: number | null,
  nowIso: string
): string | null {
  if (!observedAt || cadenceSeconds === null) return null;
  const next = Date.parse(observedAt) + cadenceSeconds * 1000;
  return next > Date.parse(nowIso) ? new Date(next).toISOString() : null;
}

/** "hourly reading", "every 6 hours", "daily reading"; null when unscheduled. */
export function cadenceText(cadenceSeconds: number | null | undefined): string | null {
  if (cadenceSeconds == null) return null;
  if (cadenceSeconds % 86_400 === 0)
    return cadenceSeconds === 86_400
      ? "daily reading"
      : `every ${plural(cadenceSeconds / 86_400, "day")}`;
  if (cadenceSeconds % 3_600 === 0)
    return cadenceSeconds === 3_600
      ? "hourly reading"
      : `every ${plural(cadenceSeconds / 3_600, "hour")}`;
  return `every ${plural(cadenceSeconds / 60, "minute")}`;
}
