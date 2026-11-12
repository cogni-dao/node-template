// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (metric-evidence)
 * Purpose: Measurement evidence for one metric: its latest readings and, when the page links one, that immutable observation pinned ahead of newer rolling readings.
 * Scope: Client component over the injected GoalsClient. The node reads `?observation=` from its URL and passes it as `observationId`; this package imports no router.
 * Invariants: PINNED_BEFORE_ROLLING (a linked reading is shown first and alone, never replaced by a newer one); NO_MANUAL_COMPUTE (evidence is read-only; the clock and agents compute); HOST_QUERY_CLIENT; INDEPENDENT_READS (rolling failure cannot hide authorized pinned evidence).
 * Side-effects: IO (GoalsClient.fetchMetric, fetchObservation); refetches every 15 s while mounted.
 * Links: ./client.ts
 * @public
 */

"use client";

import { useQuery } from "@tanstack/react-query";

import { useGoalsHost } from "./context.js";
import { metricEvidenceKey } from "./use-goals-progress.js";

export interface MetricEvidenceProps {
  /** The metric (or the knowledge entry id of a metric definition). */
  readonly id: string;
  /** The `?observation=` value of the page URL, when a reading is linked. */
  readonly observationId?: string | null | undefined;
}

/** Evidence inspection lives with its owning knowledge atom, never a manual compute control. */
export function MetricEvidence({ id, observationId = null }: MetricEvidenceProps) {
  const { client, queryKeyPrefix } = useGoalsHost();
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
  return (
    <section aria-label="Measurement evidence" className="space-y-3 rounded-lg border p-4 text-sm">
      <h2 className="font-medium">Measurement evidence</h2>
      <p className="text-muted-foreground">
        Readings are recorded automatically. Each keeps its source time and definition.
      </p>
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
    </section>
  );
}
