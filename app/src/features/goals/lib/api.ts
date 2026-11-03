// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/api`
 * Purpose: Browser reads for the Goals tab: goal progress and ranged metric history.
 * Scope: Cookie-session GETs parsed with the shared metrics contracts. Never computes.
 * Invariants: ONE_WIRE_CONTRACT (zod schemas from @cogni-dao/metrics/contracts);
 *   READ_ONLY (no POST from the UI; agents and the clock refresh readings).
 * Side-effects: IO (GET /api/v1/metrics/goals, GET /api/v1/metrics/{id}/history)
 * Links: packages/metrics/src/contracts.ts
 * @public
 */

import {
  type GoalsProgress,
  GoalsProgressSchema,
  type MetricHistory,
  MetricHistorySchema,
} from "@cogni-dao/metrics/contracts";

import {
  allWindow,
  type HistoryRange,
  historyWindow,
  trimLeadingMissing,
} from "./presentation";

export const GOALS_QUERY_KEY = ["goals", "progress"] as const;

export async function fetchGoalsProgress(): Promise<GoalsProgress> {
  const response = await fetch("/api/v1/metrics/goals", { cache: "no-store" });
  if (!response.ok) throw new Error(`goals_read_failed:${response.status}`);
  return GoalsProgressSchema.parse(await response.json());
}

async function readHistory(
  metricId: string,
  window: { from: string; to: string; step: string }
): Promise<MetricHistory> {
  const qs = new URLSearchParams(window).toString();
  const response = await fetch(
    `/api/v1/metrics/${encodeURIComponent(metricId)}/history?${qs}`,
    { cache: "no-store" }
  );
  if (!response.ok) throw new Error(`history_read_failed:${response.status}`);
  return MetricHistorySchema.parse(await response.json());
}

/**
 * 7d/30d/90d read daily buckets. "All" reads 400 daily buckets and widens to
 * 400 weekly buckets only when the series is older than that, so buckets ≤ 400.
 */
export async function fetchMetricHistory(
  metricId: string,
  range: HistoryRange,
  nowMs: number
): Promise<MetricHistory> {
  if (range !== "all")
    return readHistory(metricId, historyWindow(range, nowMs));
  const daily = await readHistory(metricId, allWindow(nowMs, "1d"));
  if (daily.buckets[0]?.status === "missing" || daily.buckets.length === 0)
    return trimLeadingMissing(daily);
  return trimLeadingMissing(
    await readHistory(metricId, allWindow(nowMs, "1w"))
  );
}
