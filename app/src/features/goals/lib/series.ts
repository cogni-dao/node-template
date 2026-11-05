// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/series`
 * Purpose: Pure chart model for one KPI's ranged history: points, real gaps,
 *   the proven "not yet measured" span, a Y domain that keeps the target in
 *   view, the target band, pace segments, bet shapes and a plain summary.
 * Scope: Pure function over `@cogni-dao/metrics/contracts` shapes. Never
 *   decides status (assessKpi does), never fills a bucket, never fetches.
 * Invariants: GAPS_STAY_GAPS (every non-ok bucket is a null point and a gap);
 *   CROP_ONLY_BEFORE_PROVEN_START (shade only before min(first non-missing
 *   bucket, history.to), and only when the probe proves the series began
 *   inside the range); PACE_IS_DRAWN_NEVER_ASSESSED (anchored at asOf, from
 *   assessment.pace); UNKNOWN_IS_NOT_ZERO (an empty range has no zero series).
 * Side-effects: none
 * Links: ./presentation.ts, packages/metrics/src/assess.ts, work item task.0040
 * @public
 */

import type {
  KpiAssessment,
  MetricHistory,
  MetricHistoryStep,
} from "@cogni-dao/metrics/contracts";

import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatNumber,
  formatReadingTime,
  formatSigned,
  MIN_VISIBLE_STEPS,
  niceTicks,
  plural,
  type SeriesStart,
  STEP_MS,
  stepUnit,
  unitLabel,
} from "./presentation";

const WEEK_MS = STEP_MS["1w"];
/** Right margin for forward marks (pace, bets), as a share of the visible span. */
const FORWARD_MARGIN = 0.18;

export type PointState = "ok" | "missing" | "error" | "unavailable";

export interface SeriesPoint {
  readonly t: number;
  readonly value: number | null;
  readonly state: PointState;
  readonly observationId: string | null;
  /** The newest reading, plotted at its own time after the last closed bucket. */
  readonly latest: boolean;
  /** An ok point with no ok neighbour: an Area cannot draw it without a dot. */
  readonly isolated: boolean;
  /** The last ok point (bucket or latest): hollow when the value is last good. */
  readonly lastOk: boolean;
}

export interface GapSpan {
  readonly x1: number;
  readonly x2: number;
  readonly kind: "missing" | "failed";
}

export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** One open bet's prediction on this chart's metric. */
export interface BetMarker {
  readonly id: string;
  readonly title: string;
  /** The bet's evaluation date. */
  readonly at: string;
  /** The baseline reading's window end; null draws only the evaluation line. */
  readonly baselineAt: string | null;
  readonly comparator: "gte" | "lte" | "eq";
  readonly predicted: number;
}

export interface BetShape {
  readonly id: string;
  readonly label: string;
  /** Window start, clipped to the axis; null when there is no baseline. */
  readonly x1: number | null;
  readonly x2: number;
  readonly predicted: number;
  /** The evaluation date is on the axis, so its predicted value is drawn. */
  readonly inReach: boolean;
}

export interface SeriesModel {
  readonly step: MetricHistoryStep;
  readonly unit: string;
  readonly points: readonly SeriesPoint[];
  readonly okCount: number;
  /** "sparse" (< 3 ok points) draws every dot; it never changes status. */
  readonly layout: "normal" | "sparse";
  readonly empty: boolean;
  /** Proven first attempt; null when the range was not cropped. */
  readonly firstAttemptAt: number | null;
  readonly xDomain: readonly [number, number];
  /** Proven time with no completed reading; never a gap, never shaded past history.to. */
  readonly notYetMeasured: { readonly x1: number; readonly x2: number } | null;
  readonly gaps: readonly GapSpan[];
  readonly gapBuckets: { readonly missing: number; readonly failed: number };
  readonly yDomain: readonly [number, number];
  readonly yTicks: readonly number[];
  readonly target: {
    readonly value: number;
    readonly comparator: "gte" | "lte" | "eq";
    readonly label: string;
  };
  readonly band: { readonly y1: number; readonly y2: number } | null;
  readonly deadlineX: number | null;
  readonly pace: {
    readonly needed: Segment | null;
    readonly observed: Segment | null;
  };
  readonly bets: readonly BetShape[];
  readonly summary: string;
}

export interface GoalSeriesInput {
  readonly history: MetricHistory;
  readonly assessment: KpiAssessment;
  /** The goals read's asOf: assessKpi's `now`, so pace is anchored here. */
  readonly asOf: string;
  /** Series start from the weekly probe; null when the probe failed. */
  readonly seriesStart: SeriesStart | null;
  readonly title: string;
  readonly rangeTitle: string;
  readonly bets?: readonly BetMarker[];
}

export function buildGoalSeries(input: GoalSeriesInput): SeriesModel {
  const { history, assessment: a, asOf, seriesStart } = input;
  const step = history.step;
  const stepMs = STEP_MS[step];
  const from = Date.parse(history.from);
  const to = Date.parse(history.to);
  const asOfMs = Date.parse(asOf);

  // The newest reading usually lands after the last closed bucket. Plot it as
  // its own point at its own time; never write it into an earlier bucket.
  const latestT =
    a.value !== null && a.observedAt ? Date.parse(a.observedAt) : null;
  const latest =
    latestT !== null && latestT >= to && a.value !== null
      ? {
          t: latestT,
          value: a.value,
          state: "ok" as const,
          observationId: a.observationId,
          latest: true,
        }
      : null;

  const firstIdx = history.buckets.findIndex((b) => b.status !== "missing");
  const firstBucketStart =
    firstIdx >= 0 ? Date.parse(history.buckets[firstIdx]?.start ?? "") : null;
  // The probe proves no completed attempt before seriesStart. If the range
  // starts at or before it, the range holds every attempt, so its first one
  // is the series' first attempt. Otherwise a leading run is a real gap.
  const cropped =
    seriesStart?.proven === true &&
    from <= seriesStart.at &&
    (firstBucketStart !== null || latest !== null);
  const firstAttemptAt = cropped
    ? Math.min(firstBucketStart ?? Number.POSITIVE_INFINITY, latest?.t ?? Number.POSITIVE_INFINITY)
    : null;
  // The probe proves nothing after history.to: the open period is not shaded.
  const unmeasuredEnd = cropped ? (firstBucketStart ?? to) : null;

  const included = history.buckets.filter(
    (b) => !cropped || (firstBucketStart !== null && Date.parse(b.start) >= firstBucketStart)
  );
  const raw = [
    ...included.map((b) => ({
      t: Date.parse(b.start),
      value: b.status === "ok" ? b.value : null,
      state: b.status as PointState,
      observationId: b.observationId,
      latest: false,
      end: Date.parse(b.end),
    })),
    ...(latest ? [{ ...latest, end: latest.t }] : []),
  ];
  const lastOkIdx = raw.findLastIndex((p) => p.value !== null);
  const points: SeriesPoint[] = raw.map((p, i) => ({
    t: p.t,
    value: p.value,
    state: p.state,
    observationId: p.observationId,
    latest: p.latest,
    isolated:
      p.value !== null &&
      (raw[i - 1]?.value ?? null) === null &&
      (raw[i + 1]?.value ?? null) === null,
    lastOk: i === lastOkIdx,
  }));

  // Gaps: contiguous non-ok buckets of one kind, [first start, last end).
  const gaps: GapSpan[] = [];
  const gapBuckets = { missing: 0, failed: 0 };
  for (const p of raw) {
    if (p.latest || p.value !== null) continue;
    const kind = p.state === "missing" ? "missing" : "failed";
    gapBuckets[kind] += 1;
    const prev = gaps.at(-1);
    if (prev && prev.kind === kind && prev.x2 === p.t)
      gaps[gaps.length - 1] = { ...prev, x2: p.end };
    else gaps.push({ x1: p.t, x2: p.end, kind });
  }

  const xData = Math.max(to, latest?.t ?? to);
  const xStart =
    firstAttemptAt !== null
      ? Math.min(firstAttemptAt, xData - MIN_VISIBLE_STEPS * stepMs)
      : from;
  const notYetMeasured =
    unmeasuredEnd !== null && unmeasuredEnd > xStart
      ? { x1: xStart, x2: unmeasuredEnd }
      : null;

  // Pace is drawn from the assessment only, anchored where assessKpi computed it.
  const value = a.value;
  const drawNeeded =
    a.status === "behind" && a.pace.needed !== null && value !== null;
  const drawObserved =
    (a.status === "on_track" || a.status === "behind") &&
    a.pace.observed !== null &&
    value !== null;

  const span0 = Math.max(xData - xStart, stepMs);
  const deadlineMs = a.deadline ? Date.parse(a.deadline) : null;
  const betShapes = (input.bets ?? []).flatMap((b) => {
    const atMs = Date.parse(b.at);
    const startMs = b.baselineAt ? Date.parse(b.baselineAt) : null;
    if (!Number.isFinite(atMs) || atMs < xStart) return [];
    const inReach = atMs <= xData + span0 * 0.25;
    if (!inReach && (startMs === null || startMs > xData)) return [];
    return [{ b, atMs, startMs, inReach }];
  });
  const forward = drawNeeded || drawObserved || betShapes.some((b) => b.inReach);
  const base = forward ? Math.max(xData, asOfMs) : xData;
  const xRight = Math.max(
    forward ? base + (base - xStart) * FORWARD_MARGIN : base,
    ...betShapes.filter((b) => b.inReach).map((b) => b.atMs)
  );

  const paceSegment = (perWeek: number): Segment => {
    const x2 =
      deadlineMs !== null && deadlineMs > asOfMs && deadlineMs < xRight
        ? deadlineMs
        : xRight;
    return {
      x1: asOfMs,
      y1: value as number,
      x2,
      y2: (value as number) + (perWeek * (x2 - asOfMs)) / WEEK_MS,
    };
  };
  const needed = drawNeeded ? paceSegment(a.pace.needed as number) : null;
  const observed = drawObserved ? paceSegment(a.pace.observed as number) : null;

  const okValues = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const target = a.target.value;
  const domainValues = [
    ...okValues,
    target,
    ...(needed ? [needed.y2] : []),
    ...(observed ? [observed.y2] : []),
    ...betShapes.filter((s) => s.inReach).map((s) => s.b.predicted),
  ];
  const lo = Math.min(...domainValues);
  const hi = Math.max(...domainValues);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.2 || 1;
  const yTicks = niceTicks(lo >= 0 && lo - pad < 0 ? 0 : lo - pad, hi + pad);
  const yDomain: [number, number] = [yTicks[0] ?? lo, yTicks.at(-1) ?? hi];

  const band =
    a.comparator === "gte"
      ? { y1: target, y2: yDomain[1] }
      : a.comparator === "lte"
        ? { y1: yDomain[0], y2: target }
        : null;
  const by = a.deadline ? ` by ${formatDate(a.deadline)}` : "";
  const targetLabel = `Target ${COMPARATOR_SYMBOL[a.comparator]} ${formatNumber(target, a.unit)}${by}`;

  const bets: BetShape[] = betShapes.map(({ b, atMs, startMs, inReach }) => ({
    id: b.id,
    label: `Bet: ${b.title} · predicts ${COMPARATOR_SYMBOL[b.comparator]} ${formatNumber(b.predicted, a.unit)} by ${formatDate(b.at)}`,
    x1: startMs !== null ? Math.max(startMs, xStart) : null,
    x2: Math.min(atMs, xRight),
    predicted: b.predicted,
    inReach,
  }));

  const okCount = okValues.length;
  const model = {
    step,
    unit: history.unit,
    points,
    okCount,
    layout: okCount < 3 ? ("sparse" as const) : ("normal" as const),
    empty: okCount === 0,
    firstAttemptAt,
    xDomain: [xStart, xRight] as const,
    notYetMeasured,
    gaps,
    gapBuckets,
    yDomain,
    yTicks,
    target: { value: target, comparator: a.comparator, label: targetLabel },
    band,
    deadlineX:
      deadlineMs !== null && deadlineMs >= xStart && deadlineMs <= xRight
        ? deadlineMs
        : null,
    pace: { needed, observed },
    bets,
  };
  return { ...model, summary: describeSeries(model, input) };
}

function describeSeries(
  m: Omit<SeriesModel, "summary">,
  input: GoalSeriesInput
): string {
  const a = input.assessment;
  const unit = m.unit;
  const v = (n: number) => `${formatNumber(n, unit)} ${unitLabel(n, unit)}`;
  const ok = m.points.filter((p) => p.value !== null);
  const first = ok[0];
  const last = ok.at(-1);
  const values = ok.map((p) => p.value as number);
  const readings =
    !first || !last
      ? "no readings in this range"
      : first === last
        ? `one reading, ${v(last.value as number)}`
        : `from ${v(first.value as number)} to ${v(last.value as number)}, low ${v(Math.min(...values))}, high ${v(Math.max(...values))}`;
  const word = stepUnit(m.step);
  const parts = [
    `${input.title}, ${input.rangeTitle}: ${readings}`,
    `${m.target.label.replace(/^Target/, "target")}`,
  ];
  if (m.gapBuckets.missing)
    parts.push(`${plural(m.gapBuckets.missing, word)} without a reading`);
  if (m.gapBuckets.failed)
    parts.push(`${plural(m.gapBuckets.failed, word)} with a failed read`);
  if (m.firstAttemptAt !== null)
    parts.push(
      `measured since ${formatReadingTime(new Date(m.firstAttemptAt).toISOString(), input.asOf)}`
    );
  if (m.pace.needed && a.pace.needed !== null)
    parts.push(`needed pace ${formatSigned(a.pace.needed, unit)} per week`);
  if (a.status === "on_track" || a.status === "behind")
    parts.push(
      a.pace.observed !== null
        ? `observed pace ${formatSigned(a.pace.observed, unit)} per week`
        : "observed pace unknown"
    );
  return `${parts.join("; ")}.`;
}
