// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/goals-preview/GoalsPreviewClient`
 * Purpose: Seed a local query cache with production goals (snapshot 2026-11-06)
 *   and their hourly/daily history, plus fixture "GitHub stars" (volume) and
 *   "Uptime" (slo) KPIs, then render the real GoalsBoard.
 * Scope: Development preview only. Network reads are disabled for goals.
 * Invariants: Fixture KPIs are titled "(fixture)"; production values are unedited.
 * Side-effects: local query cache only
 * Links: features/goals/components/GoalsBoard.tsx
 * @internal
 */
"use client";
import {
  type GoalsProgress,
  GoalsProgressSchema,
  type MetricHistory,
} from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { GOALS_QUERY_KEY, GoalsBoard } from "@/features/goals";
import { historyWindow } from "@/features/goals/lib/presentation";
import prodGoals from "./fixture/prod-goals.json";
import prodHistory from "./fixture/prod-history.json";

const DEADLINE = "2027-01-31T00:00:00.000Z";

function synth(
  metricId: string,
  unit: string,
  w: { from: string; to: string; step: MetricHistory["step"] },
  value: (i: number, n: number) => number | null
): MetricHistory {
  const size = { "1h": 3_600_000, "1d": 86_400_000, "1w": 604_800_000 }[w.step];
  const from = Date.parse(w.from);
  const n = Math.round((Date.parse(w.to) - from) / size);
  return {
    metricId,
    unit,
    step: w.step,
    from: w.from,
    to: w.to,
    buckets: Array.from({ length: n }, (_, i) => {
      const v = value(i, n);
      return {
        start: new Date(from + i * size).toISOString(),
        end: new Date(from + (i + 1) * size).toISOString(),
        status: v === null ? ("missing" as const) : ("ok" as const),
        value: v,
        observationId: v === null ? null : `00000000-0000-4000-8000-${String(900000 + i).padStart(12, "0")}`,
      };
    }),
  };
}

const stars = (i: number, n: number) => (i === n - 9 ? null : Math.round(40 + (i / n) * 22 + Math.sin(i) * 1.5));
const uptime = (i: number) => (i % 11 === 7 ? 99.62 : i === 5 ? null : 99.9 + (i % 5) * 0.02);

function buildData(): { data: GoalsProgress; histories: MetricHistory[] } {
  const base = GoalsProgressSchema.parse(prodGoals);
  const now = Date.parse(base.asOf);
  const m1 = historyWindow("1m", now);
  const fixtureKpi = (
    id: string,
    title: string,
    unit: string,
    display: "volume" | "slo",
    value: number,
    target: number,
    trend: MetricHistory
  ) => ({
    binding: { metricId: id, comparator: "gte" as const, target: { value: target, unit } },
    metric: { id, title, calculatorId: "fixture@1", cadenceSeconds: 86_400, maxAgeSeconds: 172_800, display },
    assessment: {
      status: "on_track" as const,
      reason: null,
      value,
      unit,
      observationId: "00000000-0000-4000-8000-000000000999",
      observedAt: base.asOf,
      comparator: "gte" as const,
      target: { value: target, unit },
      deadline: DEADLINE,
      pace: { observed: null, needed: null },
    },
    trend,
  });
  const starTrend = synth("github-stars", "stars", m1, stars);
  const upTrend = synth("uptime", "%", m1, uptime);
  const data: GoalsProgress = {
    ...base,
    goals: [
      ...base.goals.slice(0, 1),
      {
        id: "goal-fixture-adoption",
        title: "Goal: Forks adopt the template (fixture)",
        evaluateAt: DEADLINE,
        configurationError: false,
        kpis: [
          fixtureKpi("github-stars", "GitHub stars (fixture)", "stars", "volume", 62, 100, starTrend),
          fixtureKpi("uptime", "Uptime (fixture)", "%", "slo", 99.94, 99.9, upTrend),
        ],
        hypotheses: [],
        moreHypotheses: false,
        hypothesesUnavailable: false,
      },
      ...base.goals.slice(1),
    ],
  };
  const histories: MetricHistory[] = Object.values(prodHistory as Record<string, Record<string, MetricHistory>>).flatMap(
    (byRange) => Object.values(byRange)
  );
  for (const range of ["1d", "1w", "1m", "3m"] as const) {
    const w = historyWindow(range, now);
    histories.push(synth("github-stars", "stars", w, stars), synth("uptime", "%", w, uptime));
  }
  return { data, histories };
}

export function GoalsPreviewClient() {
  const [client] = useState(() => {
    const { data, histories } = buildData();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryDefaults(["goals"], { enabled: false, staleTime: Number.POSITIVE_INFINITY });
    qc.setQueryData(GOALS_QUERY_KEY, data);
    for (const h of histories) qc.setQueryData(["goals", "history", h.metricId, h.from, h.step], h);
    return qc;
  });
  return (
    <QueryClientProvider client={client}>
      <GoalsBoard initialData={client.getQueryData(GOALS_QUERY_KEY)} />
    </QueryClientProvider>
  );
}
