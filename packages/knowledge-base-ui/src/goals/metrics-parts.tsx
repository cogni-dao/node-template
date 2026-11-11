// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metrics-parts)`
 * Purpose: The metric-level pieces of the Metrics view (story.0039): one metric
 *   row (title, status, latest value, band meter, age), a KPI's branch of
 *   serving metrics grouped by role, and the flagged "not serving a KPI" group.
 * Scope: Stateless presentation over rows from `./metrics-view.ts`. Links come
 *   from the injected host (`hrefs.metric`, `hrefs.axioms`). No fetching.
 * Invariants: STATUS_NEVER_COLOR_ONLY (symbol + word); UNKNOWN_IS_NOT_ZERO
 *   ("—"); NO_BAND_NO_VERDICT ("No band", never a KPI status); ONE_COLUMN_AT_360
 *   (rows wrap, nothing scrolls sideways); theme tokens only.
 * Side-effects: none
 * Links: ./metrics-view.ts, ./marks.tsx
 * @public
 */

"use client";

import { useGoalsHost } from "./context.js";
import { ProgressBar, StatusPill } from "./marks.js";
import {
  bandFraction,
  bandText,
  flagText,
  formatAge,
  formatRowValue,
  groupByRole,
  type MetricFlag,
  type MetricRow,
  metricStatus,
  notServingRows,
  readingTitle,
  ROLE_META,
  rowValue,
  worstRowStatus,
} from "./metrics-view.js";
import type { GoalsProgress } from "@cogni-dao/metrics/contracts";

function FlagChip({ flag }: { readonly flag: MetricFlag }) {
  return (
    <span
      data-flag={flag.kind}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 font-medium text-[11px] text-warning leading-4"
    >
      <span aria-hidden="true">⚑</span>
      {flagText(flag)}
    </span>
  );
}

function NoBandPill() {
  return (
    <span
      data-status="no_band"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium text-[11px] text-muted-foreground leading-4"
    >
      <span aria-hidden="true">–</span>
      No band
    </span>
  );
}

/** One metric: title and status on the first line; value, band meter and age on the second. */
export function MetricRowView({ row, nowIso }: { readonly row: MetricRow; readonly nowIso: string }) {
  const { hrefs, Link } = useGoalsHost();
  const status = metricStatus(row);
  const { value, unit, observedAt } = rowValue(row);
  const band = bandText(row);
  const fraction = bandFraction(row);
  const number = value === null ? null : formatRowValue(value, unit);
  const age = observedAt ? formatAge(observedAt, nowIso) : null;
  // A reading that is not current is muted, like a delayed KPI.
  const muted = value !== null && (status === "delayed" || (status === "failing" && row.assessment?.reason !== "target_breached"));
  const label = `${row.title}: ${number ?? "no reading"}${band ? `; band ${band}` : "; no band"}${age ? `; read ${age}` : ""}`;
  return (
    <li data-metric={row.id} data-status={status} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2.5">
      <Link
        href={hrefs.metric(row.id)}
        className="min-w-0 break-words rounded-sm font-medium text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {row.title}
      </Link>
      {status === "no_band" ? <NoBandPill /> : <StatusPill status={status} />}
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span
          aria-label={number === null ? "No reading" : undefined}
          className={`font-semibold text-sm tabular-nums ${muted || number === null ? "" : "text-foreground"}`}
        >
          {number === null ? "—" : number}
          {number !== null && unit && unit !== "%" ? <span className="ml-1 font-normal text-muted-foreground text-xs">{unit}</span> : null}
        </span>
        {band && (
          <span className="flex min-w-24 flex-1 basis-32 items-center gap-2">
            <span className="w-24 shrink-0 sm:w-32">
              <ProgressBar fraction={fraction} label={label} />
            </span>
            <span className="whitespace-nowrap tabular-nums">{band}</span>
          </span>
        )}
        {age && observedAt ? (
          <span title={readingTitle(observedAt)} className="whitespace-nowrap tabular-nums">
            {age}
          </span>
        ) : (
          <span className="whitespace-nowrap">No reading</span>
        )}
        {row.flags.map((f) => (
          <FlagChip key={f.kind} flag={f} />
        ))}
      </div>
    </li>
  );
}

/** The metrics that serve one KPI, grouped by role, worst first. */
export function KpiBranch({ rows, nowIso }: { readonly rows: readonly MetricRow[]; readonly nowIso: string }) {
  if (rows.length === 0)
    return (
      <p data-branch="empty" className="rounded-lg border border-border/60 border-dashed px-3 py-3 text-muted-foreground text-sm">
        No metric serves this KPI yet
      </p>
    );
  const worst = worstRowStatus(rows);
  return (
    <div data-branch="served" className="min-w-0 border-border/60 border-l-2 pl-3 md:pl-4">
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <span className="font-medium uppercase tracking-wider">
          {rows.length} {rows.length === 1 ? "metric" : "metrics"} serve this KPI
        </span>
        {worst && <StatusPill status={worst} />}
      </p>
      {groupByRole(rows).map((g) => (
        <section key={g.role} data-role={g.role} aria-label={ROLE_META[g.role].label} className="mt-2">
          <h4 className="text-[11px] text-muted-foreground uppercase tracking-widest">
            {ROLE_META[g.role].label} <span className="normal-case tracking-normal">· {ROLE_META[g.role].hint}</span>
          </h4>
          <ul className="divide-y divide-border/60">
            {g.rows.map((r) => (
              <MetricRowView key={r.id} row={r} nowIso={nowIso} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Metrics that serve no bound KPI. Flagged: bind each to a KPI or retire it. */
export function NotServingGroup({ data }: { readonly data: GoalsProgress }) {
  const { hrefs, Link } = useGoalsHost();
  const rows = notServingRows(data);
  if (rows.length === 0) return null;
  return (
    <section
      data-group="not-serving"
      aria-label="Metrics that serve no KPI"
      className="rounded-xl border border-warning/40 border-dashed px-4 pt-3 pb-2"
    >
      <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-sm">
        <span aria-hidden="true" className="text-warning">
          ⚑
        </span>
        Not serving a KPI
        <span className="font-normal text-muted-foreground text-xs tabular-nums">{rows.length}</span>
      </h3>
      <p className="mt-1 text-muted-foreground text-xs">
        Bind each to a KPI or retire it ·{" "}
        <Link href={hrefs.axioms} className="underline underline-offset-2">
          why
        </Link>
      </p>
      <ul className="divide-y divide-border/60">
        {rows.map((r) => (
          <MetricRowView key={r.id} row={r} nowIso={data.asOf} />
        ))}
      </ul>
    </section>
  );
}
