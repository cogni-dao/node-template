// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/marks`
 * Purpose: The three small marks of a goal row: status pill, bullet graph, sparkline.
 * Scope: Stateless SVG/HTML. Inputs are already-assessed contract values.
 * Invariants: Status = symbol + word (+ color). Every SVG has role="img" and an
 *   aria-label stating values, target and gaps. Sparkline gaps are never bridged.
 * Side-effects: none
 * Links: ../lib/presentation.ts
 * @public
 */

import type { KpiStatus, MetricHistory } from "@cogni-dao/metrics/contracts";

import {
  bulletScale,
  COMPARATOR_SYMBOL,
  formatNumber,
  STATUS_META,
  type StatusTone,
  sparkline,
  sparklineLabel,
  unitLabel,
} from "../lib/presentation";

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
 * Bullet graph: track, shaded zone up to the target, value bar, target tick.
 * The value bar is ink, not status color: the pill carries status.
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
  const { min, max } = bulletScale(comparator, target, value);
  const pos = (v: number) =>
    Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  const targetPct = pos(target);
  const zero = pos(0);
  const valuePct = value === null ? null : pos(value);
  const h = compact ? 14 : 22;
  const label = `${
    value === null
      ? "No current value"
      : `${current ? "Current" : "Last good value"} ${formatNumber(value, unit)} ${unitLabel(value, unit)}`
  }, target ${COMPARATOR_WORDS[comparator]} ${formatNumber(target, unit)}, scale ${formatNumber(min, unit)} to ${formatNumber(max, unit)}`;
  return (
    <div>
      <svg
        role="img"
        aria-label={label}
        width="100%"
        height={h}
        viewBox={`0 0 100 ${h}`}
        preserveAspectRatio="none"
        className="block overflow-visible"
      >
        <rect
          x="0"
          y={h * 0.18}
          width="100"
          height={h * 0.64}
          rx="1.5"
          className="fill-muted"
        />
        <rect
          x={comparator === "lte" ? zero : 0}
          y={h * 0.18}
          width={Math.max(0, comparator === "lte" ? targetPct - zero : targetPct)}
          height={h * 0.64}
          rx="1.5"
          className="fill-foreground/10"
        />
        {valuePct !== null && (
          <rect
            x={Math.min(zero, valuePct)}
            y={h * 0.38}
            width={Math.max(0.6, Math.abs(valuePct - zero))}
            height={h * 0.24}
            rx="1"
            className={current ? "fill-foreground" : "fill-muted-foreground/70"}
          />
        )}
        <line
          x1={targetPct}
          x2={targetPct}
          y1="0"
          y2={h}
          vectorEffect="non-scaling-stroke"
          strokeWidth="2.5"
          className="stroke-foreground"
        />
      </svg>
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

/** 30-day trend: breaks at every non-ok bucket; dashed target; end dot. */
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
  const s = sparkline(trend, target, width, height);
  const days = trend?.buckets.length || 30;
  const targetLabel =
    target !== null && comparator
      ? `${COMPARATOR_SYMBOL[comparator]} ${formatNumber(target, trend?.unit)}`
      : null;
  const label = trend
    ? sparklineLabel(s, days, targetLabel, trend.unit)
    : "Trend unavailable: history could not be read.";
  if (!s.last)
    return (
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block max-w-full"
      >
        <line
          x1="0"
          x2={width}
          y1={height / 2}
          y2={height / 2}
          strokeDasharray="3 4"
          strokeWidth="1"
          className="stroke-border"
        />
      </svg>
    );
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block max-w-full overflow-visible"
    >
      {s.targetY !== null && (
        <line
          x1="0"
          x2={width}
          y1={s.targetY}
          y2={s.targetY}
          strokeDasharray="2 3"
          strokeWidth="1"
          className="stroke-muted-foreground/70"
        />
      )}
      {s.segments.map((seg) =>
        seg.length === 1 ? (
          <circle
            key={seg[0]?.start}
            cx={seg[0]?.x}
            cy={seg[0]?.y}
            r="1.6"
            fill="hsl(var(--chart-1))"
          />
        ) : (
          <polyline
            key={seg[0]?.start}
            fill="none"
            stroke="hsl(var(--chart-1))"
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
          />
        )
      )}
      <circle
        cx={s.last.x}
        cy={s.last.y}
        r="2.8"
        fill="hsl(var(--chart-1))"
        strokeWidth="1.5"
        className="stroke-background"
      />
    </svg>
  );
}
