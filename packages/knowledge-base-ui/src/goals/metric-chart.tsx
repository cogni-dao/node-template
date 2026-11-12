// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metric-chart)`
 * Purpose: The open metric: one big number, a range toggle and one chart drawn
 *   by display type (progress/volume = gradient area; slo = availability bars),
 *   with a single target line when the metric has a target. The same chart opens
 *   a KPI, a supporting metric and a metric's own page; only the subject differs.
 * Scope: Client component. Reads {id}/history through the injected GoalsClient; never computes.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT; GAPS_STAY_GAPS (missing buckets are
 *   null, connectNulls=false); the newest reading after the last closed bucket
 *   is its own point; the number speaks for the assessment, never for the range;
 *   the previous range stays on screen while the next one loads; the chart
 *   surface is named by the visible metric title; a collapsed readings list is
 *   the keyboard path to each observation; NO_TARGET_NO_LINE (no target, no
 *   reference line, no miss colour).
 * Side-effects: IO (via GoalsClient.fetchHistory)
 * Links: ./metric-subject.ts, ./display.ts, packages/metrics/src/contracts.ts (MetricHistorySchema)
 * @public
 */

"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip } from "./chart.js";
import { useGoalsHost } from "./context.js";
import {
  formatValue,
  MIN_DAILY_SHAPE,
  type Point,
  seriesPoints,
  targetInView,
  yDomain,
} from "./display.js";
import type { MetricSubject } from "./metric-subject.js";
import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatUtcTime,
  type HistoryRange,
  heroLabel,
  historyWindow,
  STEP_MS,
} from "./presentation.js";
import { areaGradient, barCells, CHART_CONFIG, StatusPill, useChartId } from "./marks.js";
import { RangeToggle } from "./range-toggle.js";
import { metricHistoryKey } from "./use-goals-progress.js";

/**
 * A KPI opens on the day until it has days of shape, then the week (hourly
 * cadence), or on the month. A supporting metric carries neither cadence nor
 * series in the goal read, so it always opens on the day, the series its card
 * already read: the same subject opens on the same range everywhere.
 */
export function initialRangeOf(subject: MetricSubject): HistoryRange {
  if (subject.ownSeries) return "1d";
  if (subject.cadenceSeconds === null || subject.cadenceSeconds > 3600) return "1m";
  const days = subject.trend?.buckets.filter((b) => b.status === "ok").length ?? 0;
  return days >= MIN_DAILY_SHAPE ? "1w" : "1d";
}

function when(t: number, hourly: boolean): string {
  const iso = new Date(t).toISOString();
  return hourly ? `${formatDate(iso)}, ${formatUtcTime(iso)}` : formatDate(iso);
}

export function MetricChart({
  subject,
  nowIso,
  id: figureId,
  href,
  showStatus = false,
}: {
  readonly subject: MetricSubject;
  /** Draw the status pill beside the value (a metric's own page, where no card carries it). */
  readonly showStatus?: boolean;
  readonly nowIso: string;
  /** DOM id, so the card that opens this chart can point at it. */
  readonly id?: string;
  /** The metric's own page; shown as a link beside the range when given. */
  readonly href?: string;
}) {
  const metricId = subject.id;
  const display = subject.display;
  const unit = subject.unit;
  const { client, queryKeyPrefix, hrefs, Link } = useGoalsHost();
  const [range, setRange] = useState<HistoryRange>(() => initialRangeOf(subject));
  const span = historyWindow(range, Date.parse(nowIso));
  const history = useQuery({
    queryKey: metricHistoryKey(queryKeyPrefix, metricId, span.from, span.step),
    queryFn: ({ signal }) => client.fetchHistory(metricId, span, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  const titleId = useId();
  const chartId = useChartId("kpi");

  const shown = history.data;
  const hourly = shown?.step === "1h";
  const data = shown ? seriesPoints(shown, subject) : [];
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  const goal = subject.target;
  const target = goal?.target.value ?? null;
  const showTarget = goal !== null && target !== null && targetInView(display, values, goal);
  const domain = yDomain(display, values, showTarget ? target : null, goal?.comparator);
  const from = shown ? Date.parse(shown.from) : Date.parse(span.from);
  const to = Math.max(
    (shown ? Date.parse(shown.to) : Date.parse(span.to)) + STEP_MS[shown?.step ?? span.step],
    ...data.map((d) => d.t)
  );
  const value = subject.value;
  // A metric nothing judges reads like a healthy one for labelling only: "Latest · time".
  const label = heroLabel(
    { status: subject.status ?? "on_track", value, observedAt: subject.observedAt, reason: subject.reason },
    nowIso,
    subject.viewState
  );

  const axes = [
    <CartesianGrid key="grid" vertical={false} strokeDasharray="3 3" className="stroke-border/50" />,
    <XAxis
      key="x"
      dataKey="t"
      type="number"
      scale="time"
      domain={[from, to]}
      tickLine={false}
      axisLine={false}
      minTickGap={40}
      tickMargin={8}
      tickFormatter={(t: number) =>
        range === "1d" ? formatUtcTime(new Date(t).toISOString()).replace(" UTC", "") : formatDate(new Date(t).toISOString())
      }
    />,
    <YAxis key="y" hide domain={domain} allowDataOverflow />,
    showTarget && goal && target !== null ? (
      <ReferenceLine
        key="target"
        y={target}
        stroke="hsl(var(--foreground))"
        strokeOpacity={0.5}
        strokeDasharray="4 4"
        label={{
          value: `${COMPARATOR_SYMBOL[goal.comparator]} ${formatValue(target, display, goal.target.unit)}`,
          position: "insideTopRight",
          className: "fill-muted-foreground text-[11px]",
        }}
      />
    ) : null,
    <ChartTooltip
      key="tip"
      cursor={false}
      content={({ active, payload }) => {
        const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
        if (!p) return null;
        return (
          <div className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-sm">
            <span className="text-muted-foreground">{when(p.t, hourly)} </span>
            <span className="font-medium tabular-nums">{p.v === null ? "No reading" : formatValue(p.v, display, unit)}</span>
          </div>
        );
      }}
    />,
  ];

  return (
    <figure
      id={figureId}
      aria-labelledby={titleId}
      data-chart={subject.level}
      className="space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <figcaption id={titleId} className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
            {subject.title}
          </figcaption>
          <div className="mt-1 flex items-end gap-2">
            <span className="font-semibold text-4xl tabular-nums tracking-tight">
              {value === null ? "—" : formatValue(value, display, unit)}
            </span>
            {value !== null && display !== "slo" && unit && <span className="pb-1 text-muted-foreground text-sm">{unit}</span>}
            {showStatus && subject.status && (
              <span className="pb-1">
                <StatusPill status={subject.status} />
              </span>
            )}
            {label && <span className="pb-1 text-muted-foreground text-xs">{label}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {href && (
            <Link
              href={href}
              aria-label={`Open ${subject.title}`}
              className="inline-flex min-h-6 min-w-6 items-center text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
            >
              Open ↗
            </Link>
          )}
          <RangeToggle value={range} onChange={setRange} />
        </div>
      </div>

      <div className="relative h-48">
        {history.isError && !shown ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            <button type="button" onClick={() => history.refetch()} className="underline-offset-4 hover:underline">
              Couldn’t load · Retry
            </button>
          </div>
        ) : values.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            {history.isPending ? "" : "No data"}
          </div>
        ) : (
          <ChartContainer
            config={CHART_CONFIG}
            className="aspect-auto h-48 w-full [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-foreground [&_.recharts-surface:focus-visible]:outline-solid"
          >
            {display === "slo" ? (
              <BarChart id={chartId} data={data} accessibilityLayer aria-labelledby={titleId} margin={{ top: 16, right: 0, bottom: 0, left: 0 }}>
                {axes}
                <Bar id={`${chartId}-bar`} dataKey="v" isAnimationActive={false} radius={2}>
                  {barCells(data, goal)}
                </Bar>
              </BarChart>
            ) : (
              <AreaChart id={chartId} data={data} accessibilityLayer aria-labelledby={titleId} margin={{ top: 16, right: 0, bottom: 0, left: 0 }}>
                {areaGradient(`${chartId}-fill`)}
                {axes}
                <Area
                  id={`${chartId}-area`}
                  dataKey="v"
                  type="monotone"
                  stroke="var(--color-v)"
                  strokeWidth={3}
                  fill={`url(#${chartId}-fill)`}
                  connectNulls={false}
                  dot={values.length < 3 ? { r: 4, fill: "var(--color-v)", strokeWidth: 0 } : false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            )}
          </ChartContainer>
        )}
      </div>

      <details className="text-xs">
        <summary className="inline-flex min-h-6 min-w-6 cursor-pointer items-center text-muted-foreground">Readings</summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {[...data].reverse().flatMap((d) =>
            d.v === null || !d.observationId
              ? []
              : [
                  <li key={d.t} className="flex justify-between gap-3 tabular-nums">
                    <span className="text-muted-foreground">{when(d.t, hourly)}</span>
                    <Link
                      href={hrefs.observation(metricId, d.observationId)}
                      aria-label={`Open ${subject.title} reading at ${when(d.t, hourly)}`}
                      className="inline-flex min-h-6 min-w-6 items-center hover:underline"
                    >
                      {formatValue(d.v, display, unit)} ↗
                    </Link>
                  </li>,
                ]
          )}
        </ul>
      </details>
    </figure>
  );
}
