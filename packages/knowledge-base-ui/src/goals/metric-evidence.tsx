// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (metric-evidence)
 * Purpose: A metric's own page, led by the same chart a KPI opens (value, unit, trend, 1D/1W/1M/3M history). Behind a collapsed "Evidence" disclosure sit its raw readings: observation ids, definition hashes and exact times, and, when the page links one, that immutable observation pinned ahead of newer rolling readings.
 * Scope: Client component over the injected GoalsClient. The node reads `?observation=` from its URL and passes it as `observationId`; this package imports no router.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT (the lead is `MetricChart`, never a second chart); CHART_BEFORE_EVIDENCE; PINNED_BEFORE_ROLLING (a linked reading is shown first and alone, never replaced by a newer one; its disclosure opens); NO_MANUAL_COMPUTE (evidence is read-only; the clock and agents compute); HOST_QUERY_CLIENT; INDEPENDENT_READS (rolling failure cannot hide authorized pinned evidence).
 * Side-effects: IO (GoalsClient.fetchMetric, fetchObservation, and the chart's fetchHistory); refetches the evidence every 15 s while mounted.
 * Links: ./client.ts, ./metric-chart.tsx, ./metric-subject.ts
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";

import { useGoalsHost } from "./context.js";
import { MetricChart } from "./metric-chart.js";
import { kpiSubject, type MetricSubject, readSubject } from "./metric-subject.js";
import { metricEvidenceKey, useGoalsProgress } from "./use-goals-progress.js";

/** How this metric relates to the goals: a KPI of a goal, or a metric serving a KPI. */
type Relation =
  | { readonly kind: "kpi"; readonly goalId: string; readonly goalTitle: string; readonly subject: MetricSubject }
  | { readonly kind: "serves"; readonly kpiId: string; readonly kpiTitle: string };

function relationOf(data: GoalsProgress | undefined, id: string, servesKpi: string | null): Relation | null {
  if (!data) return servesKpi ? { kind: "serves", kpiId: servesKpi, kpiTitle: servesKpi } : null;
  for (const goal of data.goals) {
    const kpi = goal.kpis.find((k) => k.binding.metricId === id);
    if (kpi) return { kind: "kpi", goalId: goal.id, goalTitle: goal.title, subject: kpiSubject(kpi) };
  }
  if (!servesKpi) return null;
  const served = data.goals.flatMap((g) => g.kpis).find((k) => k.binding.metricId === servesKpi);
  return { kind: "serves", kpiId: servesKpi, kpiTitle: served?.metric?.title ?? servesKpi };
}

export interface MetricEvidenceProps {
  /** The metric (or the knowledge entry id of a metric definition). */
  readonly id: string;
  /** The `?observation=` value of the page URL, when a reading is linked. */
  readonly observationId?: string | null | undefined;
}

/** Evidence inspection lives with its owning knowledge atom, never a manual compute control. */
export function MetricEvidence({ id, observationId = null }: MetricEvidenceProps) {
  const { client, queryKeyPrefix, hrefs, Link } = useGoalsHost();
  // The page shows what the metric is to the goals (a KPI of a goal, or serving a KPI) from the cached goal read.
  const goals = useGoalsProgress({ poll: false });
  const query = useQuery({
    queryKey: metricEvidenceKey(queryKeyPrefix, id, observationId),
    refetchInterval: 15000,
    queryFn: async ({ signal }) => {
      const [current, pinned] = await Promise.allSettled([
        client.fetchMetric(id, signal),
        observationId ? client.fetchObservation(id, observationId, signal) : Promise.resolve(null),
      ]);
      return {
        current: current.status === "fulfilled" ? current.value : null,
        pinned: pinned.status === "fulfilled" ? pinned.value?.observation ?? null : null,
        currentFailed: current.status === "rejected",
        pinnedFailed: pinned.status === "rejected",
      };
    },
  });
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-warning">
        Measurement evidence is unavailable.
      </p>
    );
  if (!query.data) return <p className="text-sm text-muted-foreground">Loading evidence…</p>;
  const { current, pinned, currentFailed, pinnedFailed } = query.data;
  const history = observationId ? (pinned ? [pinned] : []) : current?.history ?? [];
  const definition = current?.definition as { serves?: { kpi: string } } | undefined;
  const relation = current ? relationOf(goals.data, id, definition?.serves?.kpi ?? null) : null;
  // History windows end at a server time, never the browser clock: the goal read's own `asOf`, or, when that
  // read failed, the last good reading's time. The header waits for the goal read so it never jumps subject.
  const serverNow = goals.isPending ? null : (goals.data?.asOf ?? current?.lastGood?.observedAt ?? null);
  return (
    <div className="space-y-4">
      {current && serverNow && (
        <div className="space-y-2">
          {relation && (
            <p data-relation={relation.kind} className="text-muted-foreground text-xs">
              {relation.kind === "kpi" ? (
                <>
                  KPI of goal{" "}
                  <Link href={hrefs.goal(relation.goalId)} className="underline underline-offset-2">
                    {relation.goalTitle}
                  </Link>
                </>
              ) : (
                <>
                  Metric serving KPI{" "}
                  <Link href={hrefs.metric(relation.kpiId)} className="underline underline-offset-2">
                    {relation.kpiTitle}
                  </Link>
                </>
              )}
            </p>
          )}
          <MetricChart
            subject={relation?.kind === "kpi" ? relation.subject : readSubject(current, id)}
            nowIso={serverNow}
            showStatus
          />
        </div>
      )}
      {currentFailed && (
        <p role="alert" className="text-sm text-warning">
          {observationId ? "Current measurement evidence is unavailable." : "Measurement evidence is unavailable."}
        </p>
      )}
      {pinnedFailed && (
        <p role="alert" className="text-sm text-warning">
          Linked measurement evidence is unavailable.
        </p>
      )}
      <details
        data-evidence=""
        {...(observationId ? { open: true } : {})}
        className="space-y-3 rounded-lg border p-4 text-sm"
      >
        <summary className="inline-flex min-h-6 cursor-pointer items-center font-medium">Evidence</summary>
        <div className="mt-3 space-y-3">
          <p className="text-muted-foreground">
            Readings are recorded automatically. Each keeps its source time and definition.
          </p>
          {pinned && <p>Linked immutable evidence; its definition may differ from the current metric.</p>}
          {history.slice(0, pinned ? 1 : 3).map((r) => (
            <article id={`observation-${r.id}`} key={r.id} className="space-y-1 rounded border p-3">
              <p className="font-medium">
                {r.value ?? "Unknown"} {r.unit} · {r.status}
              </p>
              <p className="text-xs text-muted-foreground">{r.window.end}</p>
              <p className="break-all text-xs">Observation {r.id}</p>
              <p className="break-all text-xs text-muted-foreground">
                Definition {r.definitionHash} · {r.calculatorVersion}
              </p>
              <p className="break-all text-xs text-muted-foreground">{r.reason ?? r.evidenceRefs.join(" · ")}</p>
            </article>
          ))}
          {current && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                Measurement history · {current.history.length} recent readings
              </summary>
              <ol className="mt-2 space-y-1 text-xs">
                {current.history.map((r) => (
                  <li key={r.id}>
                    {r.window.end} · {r.value ?? "Unknown"} {r.unit} · {r.status}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
