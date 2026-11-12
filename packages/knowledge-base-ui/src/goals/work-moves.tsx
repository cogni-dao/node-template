// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (work-moves)`
 * Purpose: The block a work item leads with (task.0112): for each metric the item moves, the goal it serves, the KPI and (when the metric serves one) the supporting metric, each drawn with the one `MetricCard` row, then the item's own direction, pinned baseline, latest reading and result. An item that moves no metric says so.
 * Scope: Read-only client component over the cached goals read (`useGoalsProgress`, one entry shared with the Metrics page) and `MetricCard`'s own bounded history read. No edit controls; no per-item reads.
 * Invariants:
 *   - ONE_SUBJECT_ONE_COMPONENT: KPI and supporting metric are `MetricCard variant="row"` over `kpiSubject` / `rowSubject`; a click opens the same `MetricChart`.
 *   - GOAL_IS_INHERITED: the goal title comes from the goals read via `resolveWorkGoal`, never from a raw label.
 *   - GAP_IS_VISIBLE: no moves renders "Names no KPI — measurement gap" with a link to why; it is a notice, not an error.
 *   - DEGRADES_TO_READOUT: while the goals read is unavailable each move still shows its metric, direction, baseline, latest and result.
 * Side-effects: IO (the shared goals read; MetricCard's history read)
 * Links: ./work-goals.ts, ./metric-card.tsx, ../work-metrics.tsx
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import { type ReactElement, useId, useState } from "react";

import {
  type WorkMetric,
  workMetricArrow,
  workMetricVerdict,
} from "../work-metrics.js";
import { useGoalsHost } from "./context.js";
import { MetricCard } from "./metric-card.js";
import { MetricChart } from "./metric-chart.js";
import { kpiSubject, type MetricSubject, rowSubject } from "./metric-subject.js";
import { formatNumber } from "./presentation.js";
import { useGoalsProgress } from "./use-goals-progress.js";
import { goalForLabels, locateMetric } from "./work-goals.js";

/** Why a measured delivery path matters: the hub guide an item without moves links to. */
export const KPI_THROUGH_DELIVERY_HREF =
  "https://node-template.cognidao.org/knowledge/kpi-through-delivery";

type Reading = WorkMetric["baseline"];

function readingText(reading: Reading): string {
  if (!reading || reading.value === null || reading.value === undefined) return "—";
  return `${formatNumber(reading.value, reading.unit)}${reading.unit && reading.unit !== "ratio" ? ` ${reading.unit}` : ""}`;
}

/** Direction, pinned baseline → latest reading and the result, from the move the work item carries. */
export function WorkMoveReadout({ move }: { readonly move: WorkMetric }): ReactElement {
  const { hrefs, Link } = useGoalsHost();
  const arrow = workMetricArrow(move.direction);
  const reading = (value: Reading | WorkMetric["current"], label: string) => {
    const text = readingText(value);
    const when = value?.observedAt ?? undefined;
    return value?.id ? (
      <Link
        href={hrefs.observation(move.metricId, value.id)}
        className="inline-flex min-h-6 items-center underline underline-offset-2"
        aria-label={`${label} reading ${text}`}
      >
        <span {...(when ? { title: when } : {})}>{text}</span>
      </Link>
    ) : (
      <span {...(when ? { title: when } : {})}>{text}</span>
    );
  };
  return (
    <p
      data-move-readout={move.metricId}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs tabular-nums"
    >
      {arrow && (
        <span
          title={move.direction === "up" ? "Expected to rise" : "Expected to fall"}
          aria-label={move.direction === "up" ? "Expected to rise" : "Expected to fall"}
          className="font-semibold text-foreground text-sm"
        >
          {arrow}
        </span>
      )}
      <span>
        Baseline {reading(move.baseline, "Baseline")} → Latest {reading(move.current, "Latest")}
      </span>
      <span className="font-medium text-foreground">
        {workMetricVerdict(move)}
        {move.unknownReason ? ` · ${move.unknownReason.replace(/_/g, " ")}` : ""}
      </span>
    </p>
  );
}

/** One `MetricCard` row that opens its chart on click, with an optional line below it. */
function ChainCard({
  subject,
  nowIso,
  moved,
  children,
}: {
  readonly subject: MetricSubject;
  readonly nowIso: string;
  readonly moved: boolean;
  readonly children?: ReactElement | undefined;
}) {
  const { hrefs } = useGoalsHost();
  const [open, setOpen] = useState(false);
  const chartId = useId();
  return (
    <div data-chain={subject.level} data-chain-id={subject.id} {...(moved ? { "data-moved": "true" } : {})} className="space-y-2">
      <MetricCard
        subject={subject}
        nowIso={nowIso}
        open={open}
        chartId={chartId}
        wrap
        variant="row"
        compact
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <div id={chartId} className="pl-3">
          <MetricChart subject={subject} nowIso={nowIso} href={hrefs.metric(subject.id)} />
        </div>
      )}
      {children}
    </div>
  );
}

function GoalHeading({ goal }: { readonly goal: { readonly id: string; readonly title: string } }) {
  const { hrefs, Link } = useGoalsHost();
  return (
    <Link
      href={hrefs.goal(goal.id)}
      className="inline-flex min-h-6 min-w-0 max-w-full items-center break-words font-medium text-sm underline-offset-2 hover:underline"
    >
      {goal.title}
    </Link>
  );
}

function MoveView({ move, data, labels }: { readonly move: WorkMetric; readonly data: GoalsProgress; readonly labels: readonly string[] }) {
  const { hrefs, Link } = useGoalsHost();
  const chain = locateMetric(data, move.metricId);
  const readout = <WorkMoveReadout move={move} />;
  if (chain?.kind === "kpi" || chain?.kind === "serves") {
    const supporting = chain.kind === "serves";
    return (
      <li data-move={move.metricId} className="space-y-2">
        <GoalHeading goal={chain.goal} />
        <div className="space-y-2 border-border/60 border-l-2 pl-3 md:pl-4">
          <ChainCard subject={kpiSubject(chain.kpi)} nowIso={data.asOf} moved={!supporting}>
            {supporting ? undefined : readout}
          </ChainCard>
          {chain.kind === "serves" && (
            <div className="space-y-2 border-border/60 border-l-2 pl-3 md:pl-4">
              <ChainCard subject={rowSubject(chain.row)} nowIso={data.asOf} moved>
                {readout}
              </ChainCard>
            </div>
          )}
        </div>
      </li>
    );
  }
  // The metric serves no bound KPI: its goal can only come from a label.
  const labelGoal = goalForLabels(data, labels);
  return (
    <li data-move={move.metricId} className="space-y-2">
      {labelGoal && <GoalHeading goal={labelGoal} />}
      <div className="space-y-2 border-border/60 border-l-2 pl-3 md:pl-4">
        {chain?.kind === "unserved" ? (
          <ChainCard subject={rowSubject(chain.row)} nowIso={data.asOf} moved>
            {readout}
          </ChainCard>
        ) : (
          <>
            <Link href={hrefs.metric(move.metricId)} className="inline-flex min-h-6 items-center break-all text-sm underline">
              {move.current?.metricTitle ?? move.metricId}
            </Link>
            {readout}
          </>
        )}
        <p className="text-muted-foreground text-xs">Serves no goal KPI</p>
      </div>
    </li>
  );
}

/** Plain, card-less rows for while the goals read is loading or unavailable. */
function MoveFallback({ moves }: { readonly moves: readonly WorkMetric[] }) {
  const { hrefs, Link } = useGoalsHost();
  return (
    <ul className="space-y-3">
      {moves.map((move) => (
        <li key={move.metricId} data-move={move.metricId} className="space-y-1">
          <Link href={hrefs.metric(move.metricId)} className="inline-flex min-h-6 items-center break-all text-sm underline">
            {move.current?.metricTitle ?? move.metricId}
          </Link>
          <WorkMoveReadout move={move} />
        </li>
      ))}
    </ul>
  );
}

export function WorkMoves({
  moves,
  labels,
  gapHref = KPI_THROUGH_DELIVERY_HREF,
}: {
  readonly moves: readonly WorkMetric[];
  /** The item's labels: the goal fallback for an item that names no KPI. */
  readonly labels: readonly string[];
  readonly gapHref?: string;
}): ReactElement {
  const query = useGoalsProgress({ poll: false });
  const data = query.data;
  const labelGoal = data ? goalForLabels(data, labels) : null;
  if (moves.length === 0)
    return (
      <section aria-label="Moves" data-work-moves="none" className="space-y-2">
        {labelGoal && <GoalHeading goal={labelGoal} />}
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-warning/40 border-dashed px-3 py-2 text-sm">
          <span aria-hidden="true" className="text-warning">
            ⚑
          </span>
          <span>Names no KPI — measurement gap</span>
          <a href={gapHref} className="inline-flex min-h-6 items-center text-muted-foreground text-xs underline underline-offset-2">
            why
          </a>
        </p>
      </section>
    );
  return (
    <section aria-label="Moves" data-work-moves="moves" className="space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">Moves</h3>
      {data ? (
        <ul className="space-y-4">
          {moves.map((move) => (
            <MoveView key={move.metricId} move={move} data={data} labels={labels} />
          ))}
        </ul>
      ) : query.isError ? (
        <>
          <MoveFallback moves={moves} />
          <p role="status" className="text-muted-foreground text-xs">Goal and KPI unavailable</p>
        </>
      ) : (
        <div role="status" aria-label="Loading moves" className="h-24 animate-pulse rounded-md bg-primary/10" />
      )}
    </section>
  );
}
