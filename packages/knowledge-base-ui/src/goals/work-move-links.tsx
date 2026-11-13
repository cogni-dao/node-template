// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (work-move-links)`
 * Purpose: The "Moves" section a work item leads with (task.0112): the standard knowledge
 *   link rows (`CitationRow`, the row an entry's Links section draws) `→ [moves ↑] <metric>`,
 *   `→ [serves] <kpi>` and `→ [goal] <goal>`, then the moved metric itself as the one
 *   `MetricCard` row the Metrics page uses, whose mark follows the metric's display type and
 *   whose click opens the same `MetricChart`, exactly as /metrics draws it (no work-item text
 *   in the card). An item that moves no metric says so.
 * Scope: Read-only client component: GET reads only, it never computes or refreshes a metric
 *   (the scheduler owns refresh). The card's subject and its server clock come from the cached
 *   goals read (`useGoalsProgress`, shared with the Metrics page); when that read is unavailable
 *   the rows still show, with `serves` from the metric's own read (`client.fetchMetric`), and no
 *   card is drawn because ages and history windows need a server clock.
 * Invariants:
 *   - ONE_ROW_RENDERER: link rows are `CitationRow`; the measurement is `MetricCard`; no bespoke layout.
 *   - GOAL_IS_INHERITED: moved KPI's goal, else the serving KPI's goal, else the goal label.
 *   - NEVER_DEAD_END: a failed or pending read still shows the moves row.
 * Side-effects: IO (the shared goals read; the metric read only when the goals read cannot place it)
 * Links: ./work-goals.ts, ../citation-links.tsx, ./metric-card.tsx
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactElement, useId, useState } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  type CitationTone,
  CitationRow,
  DefaultCitationLink,
} from "../citation-links.js";
import { type WorkMetric, workMetricArrow } from "../work-metrics.js";
import { useGoalsHost } from "./context.js";
import { MetricCard } from "./metric-card.js";
import { MetricChart } from "./metric-chart.js";
import { kpiSubject, type MetricSubject, rowSubject } from "./metric-subject.js";
import { useGoalsProgress } from "./use-goals-progress.js";
import { goalIdFromLabels, locateMetric, type MoveChain } from "./work-goals.js";

/** Why a measured delivery path matters: the hub guide an item without moves links to. */
export const KPI_THROUGH_DELIVERY_HREF =
  "https://node-template.cognidao.org/knowledge/kpi-through-delivery";

export interface WorkMoveRow {
  readonly relation: string;
  readonly tone: CitationTone;
  readonly slug: string;
}

/**
 * The rows for one move: the metric it moves (with direction), the KPI it serves
 * when it is a supporting metric (from the goals read, else the metric's own
 * `serves`), and the goal (inherited from the goals read when it is there, else
 * from the item's goal label).
 */
export function moveRows(
  move: Pick<WorkMetric, "metricId" | "direction">,
  chain: MoveChain | null,
  labels: readonly string[],
  servesKpi: string | null = null,
): WorkMoveRow[] {
  const arrow = workMetricArrow(move.direction);
  const rows: WorkMoveRow[] = [
    { relation: arrow ? `moves ${arrow}` : "moves", tone: "neutral", slug: move.metricId },
  ];
  const kpi = chain?.kind === "serves" ? chain.kpi.binding.metricId : chain ? null : servesKpi;
  if (kpi) rows.push({ relation: "serves", tone: "muted", slug: kpi });
  const goalId =
    chain?.kind === "kpi" || chain?.kind === "serves" ? chain.goal.id : goalIdFromLabels(labels);
  if (goalId) rows.push({ relation: "goal", tone: "muted", slug: goalId });
  return rows;
}

/** One moved metric: the Metrics page's `MetricCard` row, opening the same chart on click. */
function MovedMetric({ subject, nowIso }: { readonly subject: MetricSubject; readonly nowIso: string }) {
  const { hrefs } = useGoalsHost();
  const [open, setOpen] = useState(false);
  const chartId = useId();
  return (
    <div data-moved-metric={subject.id} className="space-y-2">
      <MetricCard subject={subject} nowIso={nowIso} open={open} chartId={chartId} wrap variant="row" onToggle={() => setOpen(!open)} />
      {open && (
        <div id={chartId} className="pl-3">
          <MetricChart subject={subject} nowIso={nowIso} href={hrefs.metric(subject.id)} />
        </div>
      )}
    </div>
  );
}

function MoveEntry({
  move,
  labels,
  goals,
  LinkComponent,
}: {
  readonly move: WorkMetric;
  readonly labels: readonly string[];
  readonly goals: { readonly data: GoalsProgress | undefined; readonly pending: boolean };
  readonly LinkComponent: CitationLinkComponent;
}) {
  const { client, queryKeyPrefix, hrefs } = useGoalsHost();
  const chain = goals.data ? locateMetric(goals.data, move.metricId) : null;
  // The metric's own read places it when the goals read cannot (failed, or it lists no such metric).
  const read = useQuery({
    queryKey: [...queryKeyPrefix, "metric", "read", move.metricId],
    queryFn: ({ signal }) => client.fetchMetric(move.metricId, signal),
    enabled: !chain && !goals.pending,
    staleTime: 30_000,
    retry: 1,
  });
  const servesKpi = read.data?.definition?.serves?.kpi ?? null;
  const subject: MetricSubject | null = chain
    ? chain.kind === "kpi"
      ? kpiSubject(chain.kpi)
      : rowSubject(chain.row)
    : null;
  // Ages and history windows need a server clock: the goals read's `asOf`. Never a reading's own time
  // (that makes every age "just now") and never the browser clock; without it no card is drawn.
  const nowIso = goals.data?.asOf ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className={CITATION_LIST_CLASS}>
        {moveRows(move, chain, labels, servesKpi).map((r) => (
          <CitationRow
            key={`${r.relation}:${r.slug}`}
            direction="out"
            relation={r.relation}
            tone={r.tone}
            slug={r.slug}
            href={r.relation === "goal" ? hrefs.goal(r.slug) : hrefs.metric(r.slug)}
            Link={LinkComponent}
          />
        ))}
      </div>
      {subject && nowIso && <MovedMetric subject={subject} nowIso={nowIso} />}
    </div>
  );
}

export function WorkMoveLinks({
  moves,
  labels,
  LinkComponent = DefaultCitationLink,
  gapHref = KPI_THROUGH_DELIVERY_HREF,
}: {
  readonly moves: readonly WorkMetric[];
  /** The item's labels: the goal fallback when the chain cannot be inherited. */
  readonly labels: readonly string[];
  /** The node's link (for example one that peeks an entry in a side sheet). Default `<a>`. */
  readonly LinkComponent?: CitationLinkComponent;
  readonly gapHref?: string;
}): ReactElement {
  const { hrefs } = useGoalsHost();
  const goals = useGoalsProgress({ poll: false });
  const heading = <h3 className={CITATION_HEADING_CLASS}>Moves</h3>;
  if (moves.length === 0) {
    const goalId = goalIdFromLabels(labels);
    return (
      <section aria-label="Moves" data-work-moves="none" className="flex flex-col gap-1.5">
        {heading}
        <div className={CITATION_LIST_CLASS}>
          {goalId && (
            <CitationRow direction="out" relation="goal" tone="muted" slug={goalId} href={hrefs.goal(goalId)} Link={LinkComponent} />
          )}
          <p className="flex min-h-8 items-center gap-x-2 text-sm">
            <span aria-hidden="true" className="text-warning">
              ⚑
            </span>
            <span>Names no KPI — measurement gap</span>
            <a
              href={gapHref}
              className="inline-flex min-h-6 items-center text-muted-foreground text-xs underline underline-offset-2"
            >
              why
            </a>
          </p>
        </div>
      </section>
    );
  }
  return (
    <section aria-label="Moves" data-work-moves="moves" className="flex flex-col gap-3">
      {heading}
      {moves.map((move, i) => (
        <MoveEntry
          key={`${move.metricId}:${i}`}
          move={move}
          labels={labels}
          goals={{ data: goals.data, pending: goals.isPending }}
          LinkComponent={LinkComponent}
        />
      ))}
    </section>
  );
}
