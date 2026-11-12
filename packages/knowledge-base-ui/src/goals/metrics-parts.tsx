// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metrics-parts)`
 * Purpose: The metric-level pieces of the Metrics view (story.0039): one metric
 *   (the same card and chart a KPI uses, opened by click), a KPI's list of
 *   metrics, and the flagged "not serving a KPI" group.
 * Scope: Stateful presentation over rows from `./metrics-view.ts`, mapped to the
 *   shared `MetricSubject`. Links come from the injected host (`hrefs.metric`,
 *   `hrefs.axioms`). The only reads are the history windows the card and chart
 *   share with every KPI.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT (no metric-only row or chart); STATUS_
 *   NEVER_COLOR_ONLY; NO_TARGET_NO_VERDICT; UNKNOWN_IS_NOT_ZERO ("—");
 *   ONE_COLUMN_AT_360 (rows wrap, nothing scrolls sideways); theme tokens only;
 *   METRICS_ARE_METRICS (the section is "Metrics"; a role is small metadata).
 * Side-effects: IO (via GoalsClient.fetchHistory: each open chart, and each card's one 1D read once near the viewport)
 * Links: ./metric-card.tsx, ./metric-chart.tsx, ./metrics-view.ts
 * @public
 */

"use client";

import { useId, useState } from "react";
import { useGoalsHost } from "./context.js";
import { MetricCard } from "./metric-card.js";
import { MetricChart } from "./metric-chart.js";
import { rowSubject } from "./metric-subject.js";
import { groupByRole, type MetricRow, notServingRows } from "./metrics-view.js";
import type { GoalsProgress } from "@cogni-dao/metrics/contracts";

/** One metric: the KPI card, opening the KPI chart, with a link to the metric's own page. */
export function MetricRowView({ row, nowIso }: { readonly row: MetricRow; readonly nowIso: string }) {
  const { hrefs } = useGoalsHost();
  const [open, setOpen] = useState(false);
  const chartId = useId();
  const subject = rowSubject(row);
  return (
    <li className="space-y-2" data-metric-block={row.id} {...(row.role ? { "data-role": row.role } : {})}>
      <MetricCard
        subject={subject}
        nowIso={nowIso}
        open={open}
        chartId={chartId}
        wrap
        variant="row"
        onToggle={() => setOpen(!open)}
      />
      {open && (
        <div id={chartId} className="pl-3">
          <MetricChart subject={subject} nowIso={nowIso} href={hrefs.metric(row.id)} />
        </div>
      )}
    </li>
  );
}

const PAGE_SIZE = 20;

/** One inline page of a bounded, already-fetched list. */
function usePage<T>(items: readonly T[]) {
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
  const start = current * PAGE_SIZE;
  return { current, start, setPage, visible: items.slice(start, start + PAGE_SIZE) };
}

function PageNav({
  total,
  current,
  start,
  setPage,
}: {
  readonly total: number;
  readonly current: number;
  readonly start: number;
  readonly setPage: (page: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  return (
    <nav aria-label="Serving metric pages" className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      <button type="button" className="min-h-8 rounded-md border px-3 disabled:opacity-50" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
      <span className="tabular-nums">{start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total} loaded</span>
      <button type="button" className="min-h-8 rounded-md border px-3 disabled:opacity-50" disabled={start + PAGE_SIZE >= total} onClick={() => setPage(current + 1)}>Next</button>
    </nav>
  );
}

/** The metrics that serve one KPI, in the fixed role order, worst first inside each role. */
export function KpiBranch({ rows, nowIso, complete = true }: { readonly rows: readonly MetricRow[]; readonly nowIso: string; readonly complete?: boolean }) {
  const ordered = groupByRole(rows).flatMap((group) => group.rows);
  const { current, start, setPage, visible } = usePage(ordered);

  if (rows.length === 0)
    return (
      <p
        data-branch="empty"
        className="rounded-lg border border-border/60 border-dashed px-3 py-3 text-muted-foreground text-sm"
      >
        {complete ? "No metric serves this KPI yet" : "No serving metrics found in the scanned set"}
      </p>
    );
  return (
    <section data-branch="served" aria-label="Metrics" className="min-w-0 border-border/60 border-l-2 pl-3 md:pl-4">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">Metrics</h4>
      <ul className="mt-2 space-y-2">
        {visible.map((r) => (
          <MetricRowView key={r.id} row={r} nowIso={nowIso} />
        ))}
      </ul>
      <PageNav total={rows.length} current={current} start={start} setPage={setPage} />
      {!complete && <p role="status" className="mt-2 text-muted-foreground text-xs">More metrics may exist beyond this scan.</p>}
    </section>
  );
}

/** Metrics that serve no bound KPI. Flagged: bind each to a KPI or retire it. */
export function NotServingGroup({ data }: { readonly data: GoalsProgress }) {
  const { hrefs, Link } = useGoalsHost();
  const rows = notServingRows(data);
  const { current, start, setPage, visible } = usePage(rows);
  if (rows.length === 0) return null;
  return (
    <section
      data-group="not-serving"
      aria-label="Metrics that serve no KPI"
      className="rounded-xl border border-warning/40 border-dashed px-4 pt-3 pb-3"
    >
      <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
        <span aria-hidden="true" className="text-warning">
          ⚑
        </span>
        Not serving a KPI
      </h3>
      <p className="mt-1 text-muted-foreground text-xs">
        Bind each to a KPI or retire it ·{" "}
        <Link href={hrefs.axioms} className="inline-flex min-h-6 min-w-6 items-center underline underline-offset-2">
          why
        </Link>
      </p>
      <ul className="mt-2 space-y-2">
        {visible.map((r) => (
          <MetricRowView key={r.id} row={r} nowIso={data.asOf} />
        ))}
      </ul>
      <PageNav total={rows.length} current={current} start={start} setPage={setPage} />
    </section>
  );
}
