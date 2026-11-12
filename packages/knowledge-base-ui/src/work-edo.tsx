// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Helps a human decide the next action from recorded work expectations and outcomes.
 * The host supplies authorized bounded reads. Knowledge/observation cache changes
 * replace in-flight generations; a visible-only refresh observes other actors.
 * Narrative remains narrative; the metrics service supplies numeric assessments.
 */
"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useState } from "react";
import type { WorkMetric } from "./work-metrics.js";

export interface WorkExpectation {
  id: string;
  title: string;
  content: string;
  predictions: { metricId: string; expected: string; observed: string }[];
  outcomes: { id: string; title: string; content: string }[];
  truncated: boolean;
}

export interface WorkExpectationPage {
  items: WorkExpectation[];
  truncated: boolean;
}

export function WorkExpectations({
  itemId,
  moves,
  load,
}: {
  readonly itemId: string;
  readonly moves: readonly WorkMetric[];
  readonly load: (
    id: string,
    signal: AbortSignal,
    moves: readonly WorkMetric[],
  ) => Promise<WorkExpectationPage>;
}): ReactElement {
  const client = useQueryClient();
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const query = useQuery({
    // Shares the knowledge mutation prefix; item and observation identities
    // also invalidate the read when the host refreshes the work item itself.
    queryKey: [
      "knowledge",
      "work-expectations",
      itemId,
      moves,
      evidenceRevision,
    ],
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          load(itemId, controller.signal, moves),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Expectations read timed out"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    retry: false,
  });
  // EDO mutations already invalidate knowledge. Observation/EDO reads that
  // publish a new cache result must refresh this composed projection too.
  // Local changes replace the query generation, including during an in-flight read.
  // A visible-only refresh also observes writes made by other actors.
  useEffect(() => {
    return client.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        (event.action.type !== "success" && event.action.type !== "invalidate")
      )
        return;
      const [domain, kind] = event.query.queryKey;
      if (
        (domain !== "knowledge" &&
          domain !== "metric" &&
          domain !== "metrics" &&
          domain !== "goals") ||
        (domain === "knowledge" && kind === "work-expectations")
      )
        return;
      setEvidenceRevision((revision) => revision + 1);
    });
  }, [client]);
  const page = query.data;
  if (query.isError) return <p role="status">Expectations unavailable.</p>;
  if (!page || query.isFetching)
    return <p role="status">Loading expectations…</p>;
  if (!page.items.length && !page.truncated)
    return (
      <p className="text-muted-foreground text-xs">No expectation recorded.</p>
    );
  return (
    <section aria-label="Expectations" className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Expectations</h3>
      {page.items.map((item) => (
        <article
          key={item.id}
          className="min-w-0 rounded-md border p-3 text-sm"
        >
          <a
            className="break-words underline"
            href={`/knowledge/${encodeURIComponent(item.id)}`}
          >
            {item.title}
          </a>
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
          {item.predictions.length > 0 && (
            <p className="whitespace-pre-wrap">
              {item.predictions
                .map(
                  (prediction) =>
                    `${prediction.metricId}: expected ${prediction.expected}; observed ${prediction.observed}`,
                )
                .join("\n")}
            </p>
          )}
          {item.outcomes.map((outcome) => (
            <div key={outcome.id}>
              <a
                className="break-words underline"
                href={`/knowledge/${encodeURIComponent(outcome.id)}`}
              >
                {outcome.title}
              </a>
              <p className="whitespace-pre-wrap break-words">
                {outcome.content}
              </p>
            </div>
          ))}
          {item.truncated && (
            <p>Some text or links are omitted; open the expectation.</p>
          )}
        </article>
      ))}
      {page.truncated && <p>More links in detail.</p>}
    </section>
  );
}
