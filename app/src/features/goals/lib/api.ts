// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/api`
 * Purpose: Browser reads for the Goals tab: goal progress, the weekly
 *   series-start probe and ranged metric history.
 * Scope: Cookie-session GETs parsed with the shared metrics contracts. Never computes.
 * Invariants: ONE_WIRE_CONTRACT (zod schemas from @cogni-dao/metrics/contracts);
 *   READ_ONLY (no POST from the UI; agents and the clock refresh readings);
 *   BUCKETS_LE_400 (every history read is aligned and holds at most 400 buckets).
 * Side-effects: IO (GET /api/v1/metrics/goals, GET /api/v1/metrics/{id}/history)
 * Links: packages/metrics/src/contracts.ts, ./presentation.ts
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
  type HistoryWindow,
  historyWindow,
  probeWindow,
  seriesStartFromProbe,
} from "./presentation";

export const GOALS_QUERY_KEY = ["goals", "progress"] as const;

export async function fetchGoalsProgress(): Promise<GoalsProgress> {
  const response = await fetch("/api/v1/metrics/goals", { cache: "no-store" });
  if (!response.ok) throw new Error(`goals_read_failed:${response.status}`);
  return GoalsProgressSchema.parse(await response.json());
}

async function readHistory(
  metricId: string,
  window: HistoryWindow
): Promise<MetricHistory> {
  const qs = new URLSearchParams({ ...window }).toString();
  const response = await fetch(
    `/api/v1/metrics/${encodeURIComponent(metricId)}/history?${qs}`,
    { cache: "no-store" }
  );
  if (!response.ok) throw new Error(`history_read_failed:${response.status}`);
  return MetricHistorySchema.parse(await response.json());
}

/** One 400 × 1w read: the proven start of the series (see seriesStartFromProbe). */
export async function fetchSeriesStart(
  metricId: string,
  nowMs: number
): Promise<number> {
  return seriesStartFromProbe(await readHistory(metricId, probeWindow(nowMs)));
}

/** 1D/1W hourly, 1M/3M daily; "All" from the proven start (unknown → 400 days). */
export async function fetchMetricHistory(
  metricId: string,
  range: HistoryRange,
  nowMs: number,
  seriesStart: number | null
): Promise<MetricHistory> {
  return readHistory(
    metricId,
    range === "all" ? allWindow(seriesStart, nowMs) : historyWindow(range, nowMs)
  );
}
