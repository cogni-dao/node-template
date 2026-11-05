// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/HistoryChart`
 * Purpose: The KPI history card container: reads the weekly series-start probe
 *   and the selected range (1D/1W hourly, 1M/3M daily, All), builds the pure
 *   series model and renders TimeSeriesCard with the hero stat.
 * Scope: Client component. Reads GET /api/v1/metrics/{id}/history; never computes.
 * Invariants: HERO_SPEAKS_FOR_ASSESSMENT (hero, its label and the status pill
 *   read only the assessment, so they never change with the range);
 *   CROP_ONLY_BEFORE_PROVEN_START (no model until the probe settles; a failed
 *   probe only turns cropping off); ≤ 2 GETs per view; REFETCH_KEEPS_FRAME
 *   (week-keyed probe and range reads keep their previous data and title).
 * Side-effects: IO (via fetchSeriesStart, fetchMetricHistory)
 * Links: ../lib/series.ts, ../lib/api.ts, ./TimeSeriesCard.tsx
 * @public
 */

"use client";

import type { KpiAssessment } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { fetchMetricHistory, fetchSeriesStart } from "../lib/api";
import {
  cadenceText,
  defaultRange,
  floorToStep,
  formatDate,
  formatNumber,
  formatReadingTime,
  formatSigned,
  HISTORY_RANGES,
  type HistoryRange,
  heroLabel,
  isHistoryRange,
  nextReadingAt,
  observationHref,
  rangeWindow,
  STEP_MS,
  statusCaption,
  unitLabel,
  valueIsCurrent,
} from "../lib/presentation";
import { type BetMarker, buildGoalSeries } from "../lib/series";
import { StatusPill } from "./marks";
import { TimeSeriesCard } from "./TimeSeriesCard";

export type { BetMarker } from "../lib/series";

export function HistoryChart({
  metricId,
  title,
  assessment,
  asOf,
  cadenceSeconds,
  maxAgeSeconds,
  bets,
}: {
  readonly metricId: string;
  readonly title: string;
  readonly assessment: KpiAssessment;
  /** The goals read's asOf: the server clock that assessKpi used. */
  readonly asOf: string;
  readonly cadenceSeconds: number | null;
  readonly maxAgeSeconds: number | null;
  readonly bets: readonly BetMarker[];
}) {
  const [range, setRange] = useState<HistoryRange>(() =>
    defaultRange(cadenceSeconds)
  );
  const nowMs = Date.parse(asOf);
  // Re-read at most once per hour of server time; the row itself polls.
  const hourKey = Math.floor(nowMs / STEP_MS["1h"]);
  // The probe window only changes weekly; key it on the week and keep the
  // last result while a new week's probe loads, so the chart never blanks.
  const probe = useQuery({
    queryKey: ["metrics", "series-start", metricId, floorToStep(nowMs, "1w")],
    queryFn: () => fetchSeriesStart(metricId, nowMs),
    staleTime: STEP_MS["1h"],
    retry: 1,
    placeholderData: (previous) => previous,
  });
  const probeSettled = !probe.isPending;
  const seriesStart = probe.data ?? null;
  const query = useQuery({
    queryKey: [
      "metrics",
      "history",
      metricId,
      range,
      hourKey,
      range === "all" ? seriesStart : null,
    ],
    // The title travels with its data, so placeholder data keeps its own title.
    queryFn: async () => {
      const window = rangeWindow(range, nowMs, seriesStart);
      return {
        history: await fetchMetricHistory(metricId, window),
        title: window.title,
      };
    },
    enabled: range !== "all" || probeSettled,
    staleTime: 60_000,
    retry: 1,
    placeholderData: (previous) => previous,
  });

  const history = query.data?.history;
  // The title travels with its data; with no data (loading, failed read) it
  // still names the selected range.
  const rangeTitle =
    query.data?.title ?? rangeWindow(range, nowMs, seriesStart).title;
  const model =
    history && probeSettled
      ? buildGoalSeries({
          history,
          assessment,
          asOf,
          seriesStart,
          title,
          rangeTitle,
          bets,
        })
      : null;

  const a = assessment;
  const by = a.deadline ? ` by ${formatDate(a.deadline)}` : "";
  return (
    <TimeSeriesCard
      eyebrow={title}
      description={[cadenceText(cadenceSeconds), "gaps are real gaps, never filled"]
        .filter(Boolean)
        .join(" · ")}
      header={
        <HeroStat
          assessment={a}
          asOf={asOf}
          cadenceSeconds={cadenceSeconds}
          maxAgeSeconds={maxAgeSeconds}
        />
      }
      chartTitle={rangeTitle ? `${title} · ${rangeTitle}` : title}
      ranges={HISTORY_RANGES}
      range={range}
      onRangeChange={(id) => {
        if (isHistoryRange(id)) setRange(id);
      }}
      model={model}
      status={query.isError ? "error" : model ? "ready" : "loading"}
      stale={query.isPlaceholderData || (query.isFetching && !query.isError)}
      onRetry={() => {
        void query.refetch();
      }}
      inspectHref={(observationId) => observationHref(metricId, observationId)}
      nowIso={asOf}
      latestIsCurrent={valueIsCurrent(a.status)}
      paceLabels={{
        needed:
          a.pace.needed !== null
            ? `Needed pace ${formatSigned(a.pace.needed, a.unit)} / wk to reach ${formatNumber(a.target.value, a.target.unit)} ${unitLabel(a.target.value, a.target.unit)}${by}`
            : null,
        observed:
          a.pace.observed !== null
            ? `Observed pace ${formatSigned(a.pace.observed, a.unit)} / wk`
            : null,
      }}
    />
  );
}

/** The hero speaks for the assessment, never for the chart range. */
function HeroStat({
  assessment: a,
  asOf,
  cadenceSeconds,
  maxAgeSeconds,
}: {
  readonly assessment: KpiAssessment;
  readonly asOf: string;
  readonly cadenceSeconds: number | null;
  readonly maxAgeSeconds: number | null;
}) {
  const current = valueIsCurrent(a.status);
  const label = heroLabel(a, asOf);
  const next = nextReadingAt(a.observedAt, cadenceSeconds, asOf);
  return (
    <div data-hero="" className="space-y-1.5">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div
          className={`font-semibold text-4xl tabular-nums tracking-tight ${
            a.value !== null && current ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {a.value === null ? "—" : formatNumber(a.value, a.unit)}
        </div>
        {a.value !== null && (
          <div className="pb-1 text-muted-foreground text-sm">
            {unitLabel(a.value, a.unit)}
          </div>
        )}
        <div className="pb-1 text-muted-foreground text-sm tabular-nums">
          {label ?? "No reading. This is unknown, not zero."}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <StatusPill status={a.status} />
        <span className="text-muted-foreground tabular-nums">
          {statusCaption(a, asOf, maxAgeSeconds)}
        </span>
        {next && (
          <span className="text-muted-foreground tabular-nums">
            · next reading ≈ {formatReadingTime(next, asOf)}
          </span>
        )}
      </div>
    </div>
  );
}
