// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/marks`
 * Purpose: The three small marks of a goal row: status pill, bullet graph and
 *   30-day sparkline. The bullet and sparkline are Recharts charts.
 * Scope: Stateless. Inputs are already-assessed contract values.
 * Invariants: Status = symbol + word (+ color). Every chart sits in a
 *   div role="img" whose aria-label states values, target and gaps. Explicit
 *   Y/X domains (the Recharts default starts at 0). Sparkline gaps are never
 *   bridged; an isolated point is a Recharts Dot; an empty sparkline draws no
 *   baseline that reads as zero. No animation (it hides dots). Every chart and
 *   series has a useId-based id, so SSR and client clip ids match.
 * Side-effects: none
 * Links: ../lib/presentation.ts
 * @public
 */

"use client";

import { ChartContainer } from "@cogni/node-ui-kit/shadcn/chart";
import type { KpiStatus, MetricHistory } from "@cogni-dao/metrics/contracts";
import { Fragment, type JSX, useId } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Dot,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import {
  bulletScale,
  COMPARATOR_SYMBOL,
  formatNumber,
  type SparkDatum,
  STATUS_META,
  type StatusTone,
  sparklineLabel,
  sparkSeries,
  unitLabel,
} from "../lib/presentation";
import { chartIds, sparkDefs } from "./chart-defs";

const TONE_CLASS: Record<StatusTone, string> = {
  success:
    "border-emerald-600/30 bg-emerald-500/10 text-emerald-800 dark:border-emerald-400/30 dark:text-emerald-300",
  warning:
    "border-amber-600/35 bg-amber-400/15 text-amber-900 dark:border-amber-300/30 dark:text-amber-200",
  danger:
    "border-red-600/30 bg-red-500/10 text-red-800 dark:border-red-400/30 dark:text-red-300",
  neutral: "border-border bg-muted/60 text-muted-foreground",
};

export function StatusPill({
  status,
  short = false,
  className = "",
}: {
  readonly status: KpiStatus;
  readonly short?: boolean;
  readonly className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-xs leading-5 ${TONE_CLASS[meta.tone]} ${className}`}
    >
      <span aria-hidden="true" className="w-3 text-center">
        {meta.symbol}
      </span>
      {short ? meta.short : meta.label}
    </span>
  );
}

const COMPARATOR_WORDS = { gte: "at least", lte: "at most", eq: "exactly" };

/**
 * Bullet graph: rounded track, shaded zone up to the target, a chart-1 value
 * bar (muted when the value is last good) and a heavy target tick. Series
 * color, never status color: the pill carries status. The wrapper reserves
 * the height, so the row never shifts while the chart measures.
 */
export function BulletGraph({
  value,
  unit,
  comparator,
  target,
  current,
  compact = false,
}: {
  readonly value: number | null;
  readonly unit: string;
  readonly comparator: "gte" | "lte" | "eq";
  readonly target: number;
  readonly current: boolean;
  readonly compact?: boolean;
}) {
  const ids = chartIds(useId());
  const { min, max } = bulletScale(comparator, target, value);
  const pos = (v: number) =>
    Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  const targetPct = pos(target);
  const h = compact ? 16 : 24;
  const label = `${
    value === null
      ? "No current value"
      : `${current ? "Current" : "Last good value"} ${formatNumber(value, unit)} ${unitLabel(value, unit)}`
  }, target ${COMPARATOR_WORDS[comparator]} ${formatNumber(target, unit)}, scale ${formatNumber(min, unit)} to ${formatNumber(max, unit)}`;
  return (
    <div>
      <div role="img" aria-label={label} style={{ height: h }} className="w-full">
        <ChartContainer config={{}} className="aspect-auto h-full w-full">
          <BarChart
            id={ids.chart}
            layout="vertical"
            data={[{ k: "value", value }]}
            margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
            barCategoryGap={0}
          >
            <XAxis
              type="number"
              dataKey="value"
              domain={[min, max]}
              allowDataOverflow
              hide
            />
            <YAxis type="category" dataKey="k" hide />
            <ReferenceArea
              x1={min}
              x2={max}
              fill="hsl(var(--muted))"
              fillOpacity={1}
              radius={4}
              ifOverflow="hidden"
            />
            <ReferenceArea
              x1={comparator === "lte" ? Math.max(0, min) : min}
              x2={target}
              fill="hsl(var(--foreground))"
              fillOpacity={0.08}
              radius={4}
              ifOverflow="hidden"
            />
            {value !== null && (
              <Bar
                id={ids.series}
                dataKey="value"
                barSize={Math.round(h * 0.5)}
                fill={
                  current
                    ? "hsl(var(--chart-1))"
                    : "hsl(var(--muted-foreground))"
                }
                fillOpacity={current ? 1 : 0.6}
                radius={3}
                isAnimationActive={false}
              />
            )}
            <ReferenceLine
              x={target}
              stroke="hsl(var(--foreground))"
              strokeWidth={3}
              ifOverflow="hidden"
            />
          </BarChart>
        </ChartContainer>
      </div>
      {!compact && (
        <div
          aria-hidden="true"
          className="relative mt-0.5 h-3.5 text-[10px] text-muted-foreground tabular-nums leading-none"
        >
          <span className="absolute left-0">{formatNumber(min, unit)}</span>
          {targetPct > 12 && targetPct < 88 && (
            <span
              className="absolute -translate-x-1/2"
              style={{ left: `${targetPct}%` }}
            >
              {formatNumber(target, unit)}
            </span>
          )}
          <span className="absolute right-0">{formatNumber(max, unit)}</span>
        </div>
      )}
    </div>
  );
}

interface SparkDotProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly index?: number;
  readonly payload?: SparkDatum;
}

/** A hidden point is a keyed Fragment; isolated and newest points are Recharts Dots. */
function sparkDot(props: SparkDotProps): JSX.Element {
  const key = `spark-dot-${props.index ?? 0}`;
  const d = props.payload;
  if (!d || d.value === null || props.cx == null || props.cy == null)
    return <Fragment key={key} />;
  if (!(d.isolated || d.last)) return <Fragment key={key} />;
  return (
    <Dot
      key={key}
      cx={props.cx}
      cy={props.cy}
      r={d.last ? 3.5 : 3}
      fill="hsl(var(--chart-1))"
      stroke="hsl(var(--background))"
      strokeWidth={1.5}
    />
  );
}

/**
 * 30-day trend at a fixed size, poly-style: a gradient area with an end dot.
 * Every non-ok bucket breaks the area; a lone reading is a Recharts Dot. The
 * target is not drawn here (the bullet shows it); the aria-label states it.
 */
export function Sparkline({
  trend,
  target,
  comparator,
  width = 150,
  height = 40,
}: {
  readonly trend: MetricHistory | null;
  readonly target: number | null;
  readonly comparator: "gte" | "lte" | "eq" | null;
  readonly width?: number;
  readonly height?: number;
}) {
  const ids = chartIds(useId());
  const s = sparkSeries(trend);
  const days = trend?.buckets.length || 30;
  const targetLabel =
    target !== null && comparator
      ? `${COMPARATOR_SYMBOL[comparator]} ${formatNumber(target, trend?.unit)}`
      : null;
  const label = trend
    ? sparklineLabel(s, days, targetLabel, trend.unit)
    : "Trend unavailable: history could not be read.";
  return (
    <div
      role="img"
      aria-label={label}
      style={{ width, height }}
      className="max-w-full"
    >
      {s.okCount > 0 && (
        <AreaChart
          id={ids.chart}
          width={width}
          height={height}
          data={s.data as SparkDatum[]}
          margin={{ top: 5, right: 5, bottom: 2, left: 2 }}
        >
          {sparkDefs(ids)}
          <XAxis
            dataKey="i"
            type="number"
            domain={[0, Math.max(s.data.length - 1, 1)]}
            hide
          />
          <YAxis domain={[s.domain[0], s.domain[1]]} allowDataOverflow hide />
          <Area
            id={ids.series}
            dataKey="value"
            type="linear"
            stroke="hsl(var(--chart-1))"
            strokeWidth={2}
            fill={`url(#${ids.fill})`}
            baseValue={s.domain[0]}
            connectNulls={false}
            isAnimationActive={false}
            dot={sparkDot}
            activeDot={false}
          />
        </AreaChart>
      )}
    </div>
  );
}
