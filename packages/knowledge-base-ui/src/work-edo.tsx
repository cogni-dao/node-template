// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
"use client";

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
  const [page, setPage] = useState<WorkExpectationPage | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      if (active) setError(true);
      controller.abort();
    }, 5000);
    setPage(null);
    setError(false);
    load(itemId, controller.signal, moves)
      .then((result) => {
        if (active) setPage(result);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [itemId, moves, load]);
  if (error) return <p role="status">Expectations unavailable.</p>;
  if (!page) return <p role="status">Loading expectations…</p>;
  if (!page.items.length && !page.truncated)
    return <p className="text-muted-foreground text-xs">No expectation recorded.</p>;
  return (
    <section aria-label="Expectations" className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Expectations</h3>
      {page.items.map((item) => (
        <article key={item.id} className="min-w-0 rounded-md border p-3 text-sm">
          <a className="break-words underline" href={`/knowledge/${encodeURIComponent(item.id)}`}>
            {item.title}
          </a>
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
          {item.predictions.map((prediction, i) => (
            <p key={`${prediction.metricId}-${i}`}>
              {prediction.metricId}: expected {prediction.expected}; observed {prediction.observed}
            </p>
          ))}
          {item.outcomes.map((outcome) => (
            <div key={outcome.id}>
              <a
                className="break-words underline"
                href={`/knowledge/${encodeURIComponent(outcome.id)}`}
              >
                {outcome.title}
              </a>
              <p className="whitespace-pre-wrap break-words">{outcome.content}</p>
            </div>
          ))}
          {item.truncated && <p>Some text or links are omitted; open the expectation.</p>}
        </article>
      ))}
      {page.truncated && <p>More links in detail.</p>}
    </section>
  );
}
