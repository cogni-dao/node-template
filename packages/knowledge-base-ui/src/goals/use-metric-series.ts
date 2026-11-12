// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (use-metric-series)`
 * Purpose: The series a metric card draws. A KPI arrives with its 30-day daily
 *   `trend` (and 24-hour `recent`) inside the goal read; a supporting metric
 *   does not, so its card reads one history window, the 1D window the open chart
 *   starts on, through the same client and the same query key.
 * Scope: Client hook over the injected GoalsClient. Reads only; never computes.
 * Invariants: SAME_HISTORY_ENDPOINT (one `fetchHistory`, one `metricHistoryKey`,
 *   so the card and the chart share one cache entry); ONE_READ_PER_CARD (never
 *   a second window); GAPS_STAY_GAPS.
 * Side-effects: IO (via GoalsClient.fetchHistory)
 * Links: ./metric-subject.ts, ./use-goals-progress.ts
 * @public
 */

"use client";

import type { MetricHistory } from "@cogni-dao/metrics/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useState } from "react";

import { useGoalsHost } from "./context.js";
import { subjectSeries } from "./display.js";
import type { MetricSubject } from "./metric-subject.js";
import { historyWindow } from "./presentation.js";
import { metricHistoryKey } from "./use-goals-progress.js";

/** How far below the fold a row still counts as near, so rows just off-screen are read before they scroll in. */
export const NEAR_VIEWPORT_MARGIN_PX = 600;

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
      { rootMargin: `${NEAR_VIEWPORT_MARGIN_PX}px` }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/**
 * The card series of a subject: its own from the goal read, or, when the read
 * carries none, one read of the 1D window (the series the 1D chart draws) once
 * the card is `visible` (near the viewport).
 */
export function useMetricSeries(subject: MetricSubject, nowIso: string, visible = true): MetricHistory | null {
  return useMetricSeriesRead(subject, nowIso, visible).series;
}

/**
 * The same series plus whether its read is still to come. `pending` is true from
 * mount until the history read has resolved or failed (including while the card
 * is not yet near the viewport), so a card draws a loading mark, never the
 * "not enough readings" mark, for a series it has not read yet. `failed` is
 * true when the read errored and left no series: the card says "Unavailable".
 */
export function useMetricSeriesRead(
  subject: MetricSubject,
  nowIso: string,
  visible = true
): { readonly series: MetricHistory | null; readonly pending: boolean; readonly failed: boolean } {
  const { client, queryKeyPrefix } = useGoalsHost();
  const day = historyWindow("1d", Date.parse(nowIso));
  const read = useQuery({
    queryKey: metricHistoryKey(queryKeyPrefix, subject.id, day.from, day.step),
    queryFn: ({ signal }) => client.fetchHistory(subject.id, day, signal),
    enabled: subject.ownSeries && visible,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });
  if (!subject.ownSeries) return { series: subjectSeries(subject), pending: false, failed: false };
  return { series: read.data ?? null, pending: read.isPending, failed: read.isError && !read.data };
}
