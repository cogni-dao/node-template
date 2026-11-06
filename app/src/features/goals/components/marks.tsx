// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/marks`
 * Purpose: The small marks on a KPI card: status pill, progress bar (progress),
 *   gradient sparkline (volume) and availability strip (slo).
 * Scope: Stateless. Inputs are already-assessed contract values.
 * Invariants: Status = symbol + word (+ color). Every mark sits in a
 *   div role="img" whose aria-label states the values. Sparkline gaps are never
 *   bridged; no reading draws nothing (never a zero line). Charts carry a
 *   useId-based id so SSR and client clip ids match. No animation.
 * Side-effects: none
 * Links: ../lib/display.ts, ../lib/presentation.ts
 * @public
 */

"use client";

import { ChartContainer } from "@cogni/node-ui-kit/shadcn/chart";
import type { KpiStatus, MetricHistory } from "@cogni-dao/metrics/contracts";
import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, Cell, YAxis } from "recharts";

import { formatSlo } from "../lib/display";
import { STATUS_META, type StatusTone } from "../lib/presentation";

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
  title,
}: {
  readonly status: KpiStatus;
  /** Plain-words reason, shown on hover; never on the card. */
  readonly title?: string | undefined;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      data-status={status}
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-medium text-[11px] leading-4 ${TONE_CLASS[meta.tone]}`}
    >
      <span aria-hidden="true">{meta.symbol}</span>
      {meta.short}
    </span>
  );
}

/** Stable, selector-safe chart id (React 19 ids contain « » or colons). */
export function useChartId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^\w-]/g, "")}`;
}

/** Fill toward the target. Series colour; the pill carries status. */
export function ProgressBar({
  fraction,
  label,
}: {
  readonly fraction: number | null;
  readonly label: string;
}) {
  return (
    <div role="img" aria-label={label} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {fraction !== null && (
        <div
          className="h-full rounded-full bg-[hsl(var(--chart-1))]"
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      )}
    </div>
  );
}

interface SparkPoint {
  readonly t: number;
  readonly v: number | null;
}

function sparkPoints(trend: MetricHistory | null): SparkPoint[] {
  if (!trend) return [];
  return trend.buckets.map((b) => ({
    t: Date.parse(b.start),
    v: b.status === "ok" ? b.value : null,
  }));
}

export function sparkDomain(values: readonly number[]): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(hi - lo, Math.abs(hi) * 0.1, 1) * 0.6;
  return [lo - pad, hi + pad * 0.3];
}

/** Volume: poly-style gradient area over the trend; gaps break the line. */
export function Sparkline({
  trend,
  label,
}: {
  readonly trend: MetricHistory | null;
  readonly label: string;
}) {
  const id = useChartId("spark");
  const data = sparkPoints(trend);
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  return (
    <div role="img" aria-label={label} className="h-10 w-full">
      {values.length >= 2 && (
        <ChartContainer config={{ v: { label, color: "hsl(var(--chart-1))" } }} className="aspect-auto h-10 w-full">
          <AreaChart id={id} data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-v)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--color-v)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {/* Padded so a small change reads small; the area never implies zero. */}
            <YAxis hide domain={sparkDomain(values)} />
            <Area
              id={`${id}-area`}
              dataKey="v"
              type="monotone"
              stroke="var(--color-v)"
              strokeWidth={2}
              fill={`url(#${id}-fill)`}
              connectNulls={false}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  );
}

/** SLO: one bar per bucket, red below target, empty where there is no reading. */
export function AvailabilityStrip({
  trend,
  target,
  label,
}: {
  readonly trend: MetricHistory | null;
  readonly target: number;
  readonly label: string;
}) {
  const id = useChartId("slo");
  const data = sparkPoints(trend);
  const values = data.flatMap((d) => (d.v === null ? [] : [d.v]));
  const floor = sloFloor(values, target);
  return (
    <div role="img" aria-label={label} className="h-10 w-full">
      {values.length > 0 && (
        <ChartContainer config={{ v: { label, color: "hsl(var(--chart-1))" } }} className="aspect-auto h-10 w-full">
          <BarChart id={id} data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
            <YAxis hide domain={[Math.max(0, floor), 100]} allowDataOverflow />
            <Bar id={`${id}-bar`} dataKey="v" isAnimationActive={false} radius={1}>
              {data.map((d) => (
                <Cell
                  key={d.t}
                  fill={d.v !== null && d.v < target ? BELOW_TARGET : "var(--color-v)"}
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}

/** Red that reads on dark and light; the dark --destructive token is too dim for a 2px bar. */
export const BELOW_TARGET = "hsl(0 84% 60%)";

/** Lowest bar still shows: the floor sits below the worst reading and the target. */
export function sloFloor(values: readonly number[], target: number): number {
  const worst = Math.min(target, ...values);
  return Math.max(0, worst - Math.max(100 - worst, 0.05) * 0.5);
}

export function sloLabel(value: number | null, target: number): string {
  return value === null
    ? `No reading; target ${formatSlo(target)}%`
    : `${formatSlo(value)}% available; target ${formatSlo(target)}%`;
}
