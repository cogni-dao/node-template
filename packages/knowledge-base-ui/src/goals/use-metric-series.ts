// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (use-metric-series)`
 * Purpose: The series a metric card draws. A KPI arrives with its 30-day daily
 *   `trend` (and 24-hour `recent`) inside the goal read; a supporting metric
 *   does not, so its card reads the same aligned history windows the open chart
 *   reads, through the same client and the same query keys.
 * Scope: Client hook over the injected GoalsClient. Reads only; never computes.
 * Invariants: SAME_HISTORY_ENDPOINT (one `fetchHistory`, one `metricHistoryKey`,
 *   so the card and the chart share one cache entry per window); HOURLY_ONLY_
 *   WHEN_YOUNG (the hourly window is read only while the daily series has no
 *   shape yet); GAPS_STAY_GAPS.
 * Side-effects: IO (via GoalsClient.fetchHistory)
 * Links: ./metric-subject.ts, ./use-goals-progress.ts
 * @public
 */

"use client";

import type { MetricHistory } from "@cogni-dao/metrics/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useState } from "react";

import { useGoalsHost } from "./context.js";
import { hasDailyShape, subjectSeries } from "./display.js";
import type { MetricSubject } from "./metric-subject.js";
import { historyWindow } from "./presentation.js";
import { metricHistoryKey } from "./use-goals-progress.js";

/**
 * True once `ref`'s element is near the viewport (and stays true). Where the
 * browser cannot observe visibility (no IntersectionObserver: SSR, jsdom) it
 * stays false, so a long list never fires one read per row up front.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/**
 * The card series of a subject: its own from the goal read, or read when the
 * read carries none and the card is `visible` (near the viewport).
 */
export function useMetricSeries(subject: MetricSubject, nowIso: string, visible = true): MetricHistory | null {
  const { client, queryKeyPrefix } = useGoalsHost();
  const now = Date.parse(nowIso);
  const daily = historyWindow("1m", now);
  const hourly = historyWindow("1d", now);
  const dailyRead = useQuery({
    queryKey: metricHistoryKey(queryKeyPrefix, subject.id, daily.from, daily.step),
    queryFn: ({ signal }) => client.fetchHistory(subject.id, daily, signal),
    enabled: subject.ownSeries && visible,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  const young = subject.ownSeries && dailyRead.isSuccess && !hasDailyShape(dailyRead.data);
  const hourlyRead = useQuery({
    queryKey: metricHistoryKey(queryKeyPrefix, subject.id, hourly.from, hourly.step),
    queryFn: ({ signal }) => client.fetchHistory(subject.id, hourly, signal),
    enabled: young,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  if (!subject.ownSeries) return subjectSeries(subject);
  return subjectSeries({ trend: dailyRead.data ?? null, recent: young ? (hourlyRead.data ?? null) : null });
}
