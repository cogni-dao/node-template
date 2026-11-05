// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/HistoryChart`
 * Purpose: Dated line chart of one KPI's ranged history with a labeled target,
 *   real gaps, open-bet windows (baseline → evaluation, predicted value at the
 *   evaluation edge) and a 7d/30d/90d/All range toggle.
 * Scope: Client component. Reads GET /api/v1/metrics/{id}/history; never computes.
 * Invariants: GAPS_STAY_GAPS (connectNulls=false; missing buckets are null);
 *   the newest reading after the last closed bucket is plotted as itself, never
 *   carried into a bucket. Status never depends on the selected range.
 * Side-effects: IO (via fetchMetricHistory)
 * Links: ../lib/api.ts, packages/metrics/src/contracts.ts (MetricHistorySchema)
 * @public
 */

"use client";

import type { KpiAssessment, MetricHistory } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { fetchMetricHistory } from "../lib/api";
import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatNumber,
  formatUtcTime,
  HISTORY_RANGES,
  type HistoryRange,
  niceTicks,
  plural,
  STEP_MS,
  unitLabel,
} from "../lib/presentation";

const CHART_HEIGHT = 220;

interface Point {
  readonly t: number;
  readonly value: number | null;
  readonly latest?: boolean;
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

function toPoints(history: MetricHistory, latest: KpiAssessment | null): Point[] {
  const points: Point[] = history.buckets.map((b) => ({
    t: Date.parse(b.start),
    value: b.status === "ok" ? b.value : null,
  }));
  // The newest reading usually lands after the last closed bucket. Plot it as
  // its own point at its own time; never write it into an earlier bucket.
  const lastEnd = Date.parse(history.to);
  if (
    latest?.value != null &&
    latest.observedAt &&
    Date.parse(latest.observedAt) >= lastEnd
  )
    points.push({
      t: Date.parse(latest.observedAt),
      value: latest.value,
      latest: true,
    });
  return points;
}

function summarize(
  title: string,
  history: MetricHistory,
  points: readonly Point[],
  target: string
): string {
  const ok = points.filter((p) => p.value !== null);
  const gaps = history.buckets.filter((b) => b.status !== "ok").length;
  const unit = history.step === "1w" ? "week" : history.step === "1h" ? "hour" : "day";
  const span = `${formatDate(history.from)} to ${formatDate(history.to)}`;
  const first = ok[0];
  const last = ok.at(-1);
  if (!first || !last)
    return `${title}, ${span}: no readings in this range; target ${target}.`;
  const values = ok.map((p) => p.value as number);
  const range =
    first === last
      ? `one reading, ${formatNumber(last.value as number, history.unit)}`
      : `from ${formatNumber(first.value as number, history.unit)} to ${formatNumber(last.value as number, history.unit)}, low ${formatNumber(Math.min(...values), history.unit)}, high ${formatNumber(Math.max(...values), history.unit)}`;
  return `${title}, ${span}: ${range}; target ${target}${
    gaps ? `; ${plural(gaps, unit)} without a reading` : ""
  }.`;
}

function ticksFor(points: readonly Point[], count: number): number[] {
  if (points.length <= count) return points.map((p) => p.t);
  const out: number[] = [];
  const step = (points.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    const p = points[Math.round(i * step)];
    if (p) out.push(p.t);
  }
  return out;
}

export function HistoryChart({
  metricId,
  title,
  assessment,
  nowIso,
  bets,
}: {
  readonly metricId: string;
  readonly title: string;
  readonly assessment: KpiAssessment;
  readonly nowIso: string;
  readonly bets: readonly BetMarker[];
}) {
  const [range, setRange] = useState<HistoryRange>("30d");
  const headingId = useId();
  const nowMs = Date.parse(nowIso);
  // Re-read at most once per hour of server time; the row itself polls.
  const hourKey = Math.floor(nowMs / STEP_MS["1h"]);
  const query = useQuery({
    queryKey: ["metrics", "history", metricId, range, hourKey],
    queryFn: () => fetchMetricHistory(metricId, range, nowMs),
    staleTime: 60_000,
    retry: 1,
    placeholderData: (previous) => previous,
  });

  const target = assessment.target.value;
  const targetText = `${COMPARATOR_SYMBOL[assessment.comparator]} ${formatNumber(target, assessment.unit)}`;
  const history = query.data;
  const points = useMemo(
    () => (history ? toPoints(history, assessment) : []),
    [history, assessment]
  );
  const stepLabel =
    history?.step === "1w" ? "weekly" : history?.step === "1h" ? "hourly" : "daily";

  const fromMs = history ? Date.parse(history.from) : nowMs;
  const lastT = points.at(-1)?.t ?? nowMs;
  const span = Math.max(lastT - fromMs, STEP_MS["1d"]);
  // A bet is drawn when its window overlaps the range. The x axis stretches to
  // an evaluation date just past the last reading; farther ones are clipped.
  const betShapes = bets.flatMap((b) => {
    const atMs = Date.parse(b.at);
    const startMs = b.baselineAt ? Date.parse(b.baselineAt) : null;
    if (!Number.isFinite(atMs) || atMs < fromMs) return [];
    const inReach = atMs <= lastT + span * 0.25;
    if (!inReach && (startMs === null || startMs > lastT)) return [];
    return [{ ...b, atMs, startMs, inReach }];
  });
  const xMax = Math.max(
    lastT,
    ...betShapes.filter((b) => b.inReach).map((b) => b.atMs)
  );
  const betLabel = (b: BetMarker) =>
    `Bet: ${b.title} · predicts ${COMPARATOR_SYMBOL[b.comparator]} ${formatNumber(b.predicted, assessment.unit)} by ${formatDate(b.at)}`;

  const values = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  const predicted = betShapes.filter((b) => b.inReach).map((b) => b.predicted);
  const lo = Math.min(target, ...values, ...predicted);
  const hi = Math.max(target, ...values, ...predicted);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.2 || 1;
  const yTicks = niceTicks(lo >= 0 && lo - pad < 0 ? 0 : lo - pad, hi + pad);
  const yDomain: [number, number] = [
    yTicks[0] ?? lo,
    yTicks.at(-1) ?? hi,
  ];

  const deadline = assessment.deadline
    ? ` by ${formatDate(assessment.deadline)}`
    : "";
  const isolated = (i: number) =>
    points[i]?.value != null &&
    (points[i - 1]?.value ?? null) === null &&
    (points[i + 1]?.value ?? null) === null;

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="text-muted-foreground text-sm">
          {title}, {stepLabel} · gaps are real gaps, never filled
        </h4>
        <fieldset className="inline-flex overflow-hidden rounded-md border border-border text-xs">
          <legend className="sr-only">Chart range</legend>
          {HISTORY_RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
              className={`min-w-10 px-2.5 py-1 tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                range === r.id
                  ? "bg-accent font-semibold text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </fieldset>
      </div>

      <div style={{ height: CHART_HEIGHT }} className="relative">
        {query.isError && !history ? (
          <div className="flex h-full items-center justify-center rounded-md border border-border border-dashed px-4 text-center text-muted-foreground text-sm">
            History could not be read. This is unknown, not zero.
          </div>
        ) : !history ? (
          <div className="h-full animate-pulse rounded-md bg-muted/60" />
        ) : (
          <div
            role="img"
            aria-label={[
              summarize(title, history, points, targetText),
              ...betShapes.map(
                (b) =>
                  `${betLabel(b)}${b.baselineAt ? `, window from ${formatDate(b.baselineAt)}` : ""}.`
              ),
            ].join(" ")}
            className="h-full"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={points}
                margin={{ top: 22, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  vertical={false}
                  stroke="hsl(var(--border))"
                  strokeWidth={1}
                />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={[fromMs, xMax]}
                  ticks={ticksFor(points, 5)}
                  tickFormatter={(t: number) => formatDate(new Date(t).toISOString())}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickMargin={6}
                />
                <YAxis
                  domain={yDomain}
                  tickCount={4}
                  width={44}
                  ticks={yTicks}
                  tickFormatter={(v: number) => formatNumber(v, assessment.unit)}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                />
                {betShapes.map((b) =>
                  b.startMs !== null ? (
                    <ReferenceArea
                      key={`area-${b.id}`}
                      x1={Math.max(b.startMs, fromMs)}
                      x2={Math.min(b.atMs, xMax)}
                      ifOverflow="hidden"
                      fill="hsl(var(--chart-4))"
                      fillOpacity={0.1}
                      stroke="hsl(var(--chart-4))"
                      strokeOpacity={0.5}
                      strokeDasharray="3 3"
                      label={{
                        value: betLabel(b),
                        position: "insideTopLeft",
                        fontSize: 11,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                    />
                  ) : b.inReach ? (
                    <ReferenceLine
                      key={`line-${b.id}`}
                      x={b.atMs}
                      stroke="hsl(var(--chart-4))"
                      strokeDasharray="3 3"
                      label={{
                        value: betLabel(b),
                        position: "insideTopRight",
                        fontSize: 11,
                        fill: "hsl(var(--muted-foreground))",
                      }}
                    />
                  ) : null
                )}
                {betShapes
                  .filter((b) => b.inReach)
                  .map((b) => (
                    <ReferenceLine
                      key={`predicted-${b.id}`}
                      segment={[
                        { x: b.atMs - span * 0.03, y: b.predicted },
                        { x: b.atMs, y: b.predicted },
                      ]}
                      stroke="hsl(var(--chart-4))"
                      strokeWidth={2.5}
                    />
                  ))}
                <ReferenceLine
                  y={target}
                  stroke="hsl(var(--foreground))"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  ifOverflow="extendDomain"
                  label={{
                    value: `Target ${targetText}${deadline}`,
                    position: "insideBottomLeft",
                    fontSize: 11,
                    fontWeight: 600,
                    fill: "hsl(var(--foreground))",
                  }}
                />
                <Tooltip
                  cursor={{ stroke: "hsl(var(--border))" }}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as Point | undefined;
                    if (!active || !p) return null;
                    const iso = new Date(p.t).toISOString();
                    return (
                      <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground text-xs shadow-sm">
                        <div className="text-muted-foreground">
                          {p.latest
                            ? `Latest reading · ${formatDate(iso)}, ${formatUtcTime(iso)}`
                            : history.step === "1h"
                              ? `${formatDate(iso)}, ${formatUtcTime(iso)}`
                              : history.step === "1w"
                                ? `Week of ${formatDate(iso, true)}`
                                : formatDate(iso, true)}
                        </div>
                        <div className="font-medium tabular-nums">
                          {p.value === null
                            ? "No reading"
                            : `${formatNumber(p.value, history.unit)} ${unitLabel(p.value, history.unit)}`}
                        </div>
                      </div>
                    );
                  }}
                />
                <Line
                  type="linear"
                  dataKey="value"
                  connectNulls={false}
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={(props: { cx?: number; cy?: number; index?: number }) => {
                    const i = props.index ?? -1;
                    const last = i === points.length - 1;
                    if (props.cx == null || props.cy == null || !(last || isolated(i)))
                      return <g key={`d${i}`} />;
                    return (
                      <circle
                        key={`d${i}`}
                        cx={props.cx}
                        cy={props.cy}
                        r={last ? 4.5 : 3}
                        fill="hsl(var(--chart-1))"
                        stroke="hsl(var(--background))"
                        strokeWidth={2}
                      />
                    );
                  }}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--background))" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
