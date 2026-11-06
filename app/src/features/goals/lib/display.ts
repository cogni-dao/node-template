// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/display`
 * Purpose: One KPI card's numbers by display type. progress = value against a
 *   target; slo = availability % and error budget; volume = an amount and its
 *   change. The metric author picks the type; absent, it follows the unit.
 * Scope: Pure. Reads contract values only; never re-derives status.
 * Invariants: UNKNOWN_IS_NOT_ZERO (no value → null, never 0); a delta needs two
 *   real readings; hints stay ≤ 3 words.
 * Side-effects: none
 * Links: packages/metrics/src/contracts.ts (MetricDisplaySchema)
 * @public
 */

import type { MetricDisplay, MetricHistory } from "@cogni-dao/metrics/contracts";

import { formatNumber, formatSigned, type GoalKpi, targetText } from "./presentation";

export type { MetricDisplay };

const PERCENT_UNITS = new Set(["%", "percent", "pct"]);

/** The author's choice wins; otherwise ratios read as progress, percents as SLOs. */
export function displayOf(kpi: GoalKpi): MetricDisplay {
  const chosen = kpi.metric?.display;
  if (chosen) return chosen;
  const unit = kpi.assessment.unit ?? kpi.binding.target.unit;
  if (PERCENT_UNITS.has(unit)) return "slo";
  if (unit === "ratio") return "progress";
  return "volume";
}

export interface CardNumber {
  /** Formatted value, or null when there is no reading. */
  readonly value: string | null;
  /** Short unit beside the value ("%" is glued on for SLOs). */
  readonly unit: string;
}

export function cardNumber(kpi: GoalKpi, display: MetricDisplay): CardNumber {
  const { value, unit } = kpi.assessment;
  const u = unit ?? kpi.binding.target.unit;
  if (value === null) return { value: null, unit: display === "slo" ? "" : u };
  if (display === "slo") return { value: `${formatSlo(value)}%`, unit: "" };
  return { value: compact(value, u), unit: u === "ratio" ? "" : u };
}

/** 99.95 keeps its nines; 87.5 reads 87.5. */
export function formatSlo(value: number): string {
  if (value >= 99) return value.toFixed(value >= 99.99 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(1).replace(/\.0$/, "");
}

/** 12,400 → 12.4k; small and fractional values keep formatNumber. */
export function compact(value: number, unit?: string): string {
  if (Math.abs(value) >= 10_000)
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return formatNumber(value, unit);
}

/** Real readings from a trend, oldest first. Gaps are skipped, never filled. */
export function trendReadings(trend: MetricHistory | null): number[] {
  if (!trend) return [];
  return trend.buckets
    .filter((b) => b.status === "ok" && b.value !== null)
    .map((b) => b.value as number);
}

/** "24h" for 24 hourly buckets, "30d" for 30 daily ones. */
export function seriesSpan(series: MetricHistory): string {
  const n = series.buckets.length;
  return series.step === "1h" ? `${n}h` : series.step === "1w" ? `${n}w` : `${n}d`;
}

/** The one muted hint beside the number, ≤ 3 words. `series` is what the mark draws. */
export function cardHint(
  kpi: GoalKpi,
  display: MetricDisplay,
  series: MetricHistory | null = kpi.trend
): string | null {
  const { value } = kpi.assessment;
  const target = kpi.binding.target;
  if (display === "slo") {
    if (value === null || target.value >= 100) return `target ${formatSlo(target.value)}%`;
    const budget = (value - target.value) / (100 - target.value);
    return `budget ${Math.round(Math.max(-1, Math.min(1, budget)) * 100)}%`;
  }
  if (display === "volume") {
    const readings = trendReadings(series);
    const first = readings[0];
    if (value !== null && series && first !== undefined && readings.length >= 2)
      return `${formatSigned(value - first, target.unit)} · ${seriesSpan(series)}`;
  }
  return targetText(kpi.binding.comparator, target);
}

/** Progress bar fill 0..1 toward the target; null without a value. */
export function progressFraction(kpi: GoalKpi): number | null {
  const { value } = kpi.assessment;
  const t = kpi.binding.target.value;
  if (value === null) return null;
  if (kpi.binding.comparator === "lte") {
    if (value <= t) return 1;
    return Math.max(0, Math.min(1, t / value));
  }
  if (t <= 0) return value >= t ? 1 : 0;
  return Math.max(0, Math.min(1, value / t));
}
