// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (work-move-links)`
 * Purpose: The "Moves" section a work item leads with (task.0112), drawn with the
 *   existing knowledge link rows: `→ [moves ↑] <metric>`, `→ [serves] <kpi>` and
 *   `→ [goal] <goal>` (the same `CitationRow` an entry's Links section uses), then
 *   the existing `WorkMetricDetails` for baseline, latest and result. An item that
 *   moves no metric says so.
 * Scope: Read-only client component. The goal chain is inherited from the cached goals
 *   read (`useGoalsProgress`, shared with the Metrics page); without it the rows fall
 *   back to the item's own `moves` and `goal:` label, never to an error line.
 * Invariants:
 *   - ONE_ROW_RENDERER: rows are `CitationRow`; no second link style.
 *   - GOAL_IS_INHERITED: moved KPI's goal, else the serving KPI's goal, else the goal label.
 *   - NEVER_DEAD_END: a failed or pending goals read still shows the moves row and its measurement.
 * Side-effects: IO (the shared goals read)
 * Links: ./work-goals.ts, ../citation-links.tsx, ../work-metrics.tsx
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import type { ReactElement } from "react";

import {
  CITATION_HEADING_CLASS,
  CITATION_LIST_CLASS,
  type CitationLinkComponent,
  type CitationTone,
  CitationRow,
  DefaultCitationLink,
} from "../citation-links.js";
import { type WorkMetric, WorkMetricDetails, workMetricArrow } from "../work-metrics.js";
import { useGoalsHost } from "./context.js";
import { useGoalsProgress } from "./use-goals-progress.js";
import { goalIdFromLabels, locateMetric } from "./work-goals.js";

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
 * when it is a supporting metric, and the goal (inherited from the goals read when
 * it is there, else from the item's goal label).
 */
export function moveRows(
  move: Pick<WorkMetric, "metricId" | "direction">,
  data: GoalsProgress | undefined,
  labels: readonly string[],
): WorkMoveRow[] {
  const arrow = workMetricArrow(move.direction);
  const rows: WorkMoveRow[] = [
    { relation: arrow ? `moves ${arrow}` : "moves", tone: "neutral", slug: move.metricId },
  ];
  const chain = data ? locateMetric(data, move.metricId) : null;
  if (chain?.kind === "serves")
    rows.push({ relation: "serves", tone: "muted", slug: chain.kpi.binding.metricId });
  const goalId =
    chain?.kind === "kpi" || chain?.kind === "serves" ? chain.goal.id : goalIdFromLabels(labels);
  if (goalId) rows.push({ relation: "goal", tone: "muted", slug: goalId });
  return rows;
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
  const data = useGoalsProgress({ poll: false }).data;
  const heading = (
    <h3 className={CITATION_HEADING_CLASS}>Moves</h3>
  );
  const row = (r: WorkMoveRow, key = "") => (
    <CitationRow
      key={`${key}${r.relation}:${r.slug}`}
      direction="out"
      relation={r.relation}
      tone={r.tone}
      slug={r.slug}
      href={r.relation === "goal" ? hrefs.goal(r.slug) : hrefs.metric(r.slug)}
      Link={LinkComponent}
    />
  );
  if (moves.length === 0) {
    const goalId = goalIdFromLabels(labels);
    return (
      <section aria-label="Moves" data-work-moves="none" className="flex flex-col gap-1.5">
        {heading}
        <div className={CITATION_LIST_CLASS}>
          {goalId && row({ relation: "goal", tone: "muted", slug: goalId })}
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
    <section aria-label="Moves" data-work-moves="moves" className="flex flex-col gap-2">
      {heading}
      <div className={CITATION_LIST_CLASS}>
        {moves.flatMap((move) => moveRows(move, data, labels).map((r) => row(r, `${move.metricId}|`)))}
      </div>
      <WorkMetricDetails moves={moves} />
    </section>
  );
}
