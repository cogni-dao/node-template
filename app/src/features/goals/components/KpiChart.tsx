// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/KpiChart`
 * Purpose: The open KPI: one big number, a range toggle and one chart drawn by
 *   display type (progress/volume = gradient area; slo = availability bars),
 *   with a single target line. Nothing else.
 * Scope: Client component. Reads GET /api/v1/metrics/{id}/history; never computes.
 * Invariants: GAPS_STAY_GAPS (missing buckets are null, connectNulls=false);
 *   the newest reading after the last closed bucket is its own point; the
 *   number speaks for the assessment, never for the range; the chart surface is
 *   named by the visible metric title; a collapsed readings list is the
 *   keyboard path to evidence.
 * Side-effects: IO (via fetchMetricHistory)
 * Links: ../lib/display.ts, packages/metrics/src/contracts.ts (MetricHistorySchema)
 * @public
 */

"use client";

import { ChartContainer, ChartTooltip } from "@cogni/node-ui-kit/shadcn/chart";
import { ToggleGroup, ToggleGroupItem } from "@cogni/node-ui-kit/shadcn/toggle-group";
import type { MetricHistory } from "@cogni-dao/metrics/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts";

import { fetchMetricHistory } from "../lib/api";
import { cardNumber, compact, displayOf, formatSlo, type MetricDisplay, trendReadings } from "../lib/display";
import {
  COMPARATOR_SYMBOL,
  formatDate,
  formatNumber,
  formatUtcTime,
  type GoalKpi,
  heroLabel,
  type HistoryRange,
  historyWindow,
  observationHref,
  STEP_MS,
} from "../lib/presentation";
import { BELOW_TARGET, sloFloor, useChartId } from "./marks";

type Range = Exclude<HistoryRange, "all">;
const RANGES: readonly { id: Range; label: string }[] = [
  { id: "1d", label: "1D" },
  { id: "1w", label: "1W" },
  { id: "1m", label: "1M" },
  { id: "3m", label: "3M" },
];

/** A young hourly series opens on the day it has; a mature one on the week. */
export function initialRange(kpi: GoalKpi): Range {
  const hourly = (kpi.metric?.cadenceSeconds ?? 86_400) <= 3600;
  if (!hourly) return "1m";
  return trendReadings(kpi.trend).length >= 3 ? "1w" : "1d";
}

interface Point {
  readonly t: number;
  readonly v: number | null;
  readonly observationId: string | null;
}

export function chartPoints(history: MetricHistory, kpi: GoalKpi): Point[] {
  const points: Point[] = history.buckets.map((b) => ({
    t: Date.parse(b.start),
    v: b.status === "ok" ? b.value : null,
    observationId: b.status === "ok" ? b.observationId : null,
  }));
  const a = kpi.assessment;
  if (a.value !== null && a.observedAt && Date.parse(a.observedAt) >= Date.parse(history.to))
    points.push({ t: Date.parse(a.observedAt), v: a.value, observationId: a.observationId });
  return points;
}

export function yDomain(display: MetricDisplay, values: number[], target: number): [number, number] {
  if (display === "slo") {
    return [sloFloor(values, target), 100];
  }
  if (display === "progress") {
    const hi = Math.max(target, ...values, 0);
    return [0, hi * 1.15 || 1];
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.2, Math.abs(hi) * 0.02, 1);
  return [lo - pad, hi + pad];
}

function tickText(t: number, range: Range): string {
  const iso = new Date(t).toISOString();
  return range === "1d" ? formatUtcTime(iso).replace(" UTC", "") : formatDate(iso);
}

export function KpiChart({ kpi, nowIso }: { readonly kpi: GoalKpi; readonly nowIso: string }) {
  const metricId = kpi.metric?.id ?? kpi.binding.metricId;
  const display = displayOf(kpi);
  const [range, setRange] = useState<Range>(() => initialRange(kpi));
  const window = historyWindow(range, Date.parse(nowIso));
  const history = useQuery({
    queryKey: ["goals", "history", metricId, window.from, window.step],
    queryFn: () => fetchMetricHistory(metricId, window),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  const titleId = useId();
  const id = useChartId("kpi");
  const target = kpi.binding.target.value;
  const num = cardNumber(kpi, display);
  const label = heroLabel(kpi.assessment, nowIso);

  const data = useMemo(
    () => (history.data && !history.isPlaceholderData ? chartPoints(history.data, kpi) : []),
    [history.data, history.isPlaceholderData, kpi]
  );
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  const showTarget =
    display !== "volume" || (values.length > 0 && target <= Math.max(...values) * 1.5 && target >= Math.min(...values) / 1.5);
  const domain = yDomain(display, showTarget ? [...values, target] : values, target);
  const fmt = (v: number) => (display === "slo" ? `${formatSlo(v)}%` : compact(v, kpi.binding.target.unit));
  const from = Date.parse(window.from);
  const to = Math.max(Date.parse(window.to) + STEP_MS[window.step], ...data.map((d) => d.t));

  // Recharts 2 only renders its own element types as direct children: an array, never a Fragment.
  const axis = [
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
      tickFormatter={(t: number) => tickText(t, range)}
    />,
    <YAxis key="y" hide domain={domain} allowDataOverflow />,
    showTarget ? (
      <ReferenceLine
        key="target"
        y={target}
        stroke="hsl(var(--foreground))"
        strokeOpacity={0.5}
        strokeDasharray="4 4"
        label={{
          value: `${COMPARATOR_SYMBOL[kpi.binding.comparator]} ${fmt(target)}`,
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
        const iso = new Date(p.t).toISOString();
        return (
          <div className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-sm">
            <span className="text-muted-foreground">
              {window.step === "1h" ? `${formatDate(iso)}, ${formatUtcTime(iso)}` : formatDate(iso)}{" "}
            </span>
            <span className="font-medium tabular-nums">{p.v === null ? "No reading" : fmt(p.v)}</span>
          </div>
        );
      }}
    />,
  ];

  return (
    <figure aria-labelledby={titleId} className="space-y-4 rounded-xl border border-border/60 bg-muted/10 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <figcaption id={titleId} className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
            {kpi.metric?.title ?? metricId}
          </figcaption>
          <div className="mt-1 flex items-end gap-2">
            <span className="font-semibold text-4xl tabular-nums tracking-tight">{num.value ?? "—"}</span>
            {num.value !== null && num.unit && <span className="pb-1 text-muted-foreground text-sm">{num.unit}</span>}
            {label && <span className="pb-1 text-muted-foreground text-xs">{label}</span>}
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={range}
          onValueChange={(v) => v && setRange(v as Range)}
          aria-label="Chart range"
          className="rounded-lg border border-border/70 p-1"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.id} value={r.id} size="sm" className="h-7 px-2.5 text-xs">
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="relative h-48">
        {history.isError && !history.data ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            <button type="button" onClick={() => history.refetch()} className="underline-offset-4 hover:underline">
              Couldn’t load · Retry
            </button>
          </div>
        ) : values.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            {history.isPending || history.isPlaceholderData ? "" : "No data"}
          </div>
        ) : (
          <ChartContainer
            config={{ v: { label: kpi.metric?.title ?? metricId, color: "hsl(var(--chart-1))" } }}
            className="aspect-auto h-48 w-full [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-foreground [&_.recharts-surface:focus-visible]:outline-solid"
          >
            {display === "slo" ? (
              <BarChart id={id} data={data} accessibilityLayer aria-labelledby={titleId} margin={{ top: 16, right: 0, bottom: 0, left: 0 }}>
                {axis}
                <Bar id={`${id}-bar`} dataKey="v" isAnimationActive={false} radius={2}>
                  {data.map((d) => (
                    <Cell key={d.t} fill={d.v !== null && d.v < target ? BELOW_TARGET : "var(--color-v)"} />
                  ))}
                </Bar>
              </BarChart>
            ) : (
              <AreaChart id={id} data={data} accessibilityLayer aria-labelledby={titleId} margin={{ top: 16, right: 0, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-v)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--color-v)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                {axis}
                <Area
                  id={`${id}-area`}
                  dataKey="v"
                  type="monotone"
                  stroke="var(--color-v)"
                  strokeWidth={3}
                  fill={`url(#${id}-fill)`}
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
        <summary className="cursor-pointer text-muted-foreground">Readings</summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {[...data].reverse().flatMap((d) =>
            d.v === null || !d.observationId
              ? []
              : [
                  <li key={d.t} className="flex justify-between gap-3 tabular-nums">
                    <span className="text-muted-foreground">
                      {formatDate(new Date(d.t).toISOString())}, {formatUtcTime(new Date(d.t).toISOString())}
                    </span>
                    <Link href={observationHref(metricId, d.observationId)} className="hover:underline">
                      {display === "slo" ? `${formatSlo(d.v)}%` : formatNumber(d.v, kpi.binding.target.unit)} ↗
                    </Link>
                  </li>,
                ]
          )}
        </ul>
      </details>
    </figure>
  );
}
