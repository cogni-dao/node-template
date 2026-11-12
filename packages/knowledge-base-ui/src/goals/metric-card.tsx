// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (metric-card)`
 * Purpose: The one card every measured thing is drawn with: title, big value and
 *   unit, status pill, one mark by display type (sparkline, progress bar or
 *   availability strip). A KPI (a metric bound to a goal) and a supporting metric
 *   (a metric bound to a KPI) use this same component; `subject.level` only sets
 *   emphasis. Clicking the card toggles the same history chart.
 * Scope: Client component over a `MetricSubject`. Reads a series only for a
 *   subject whose goal read carries none (`useMetricSeries`); no router import.
 * Invariants: ONE_SUBJECT_ONE_COMPONENT; STATUS_NEVER_COLOR_ONLY (pill = symbol +
 *   word); NO_TARGET_NO_VERDICT (a metric nothing judges draws no pill and the
 *   hint "No target", never a failed or missing look); UNKNOWN_IS_NOT_ZERO
 *   ("—"); NO_SENTENCES_ON_CARDS (the reason is the accessible description and
 *   hover title); the whole card is one toggle button.
 * Side-effects: IO (via GoalsClient.fetchHistory, for a supporting metric's mark)
 * Links: ./metric-subject.ts, ./metric-chart.tsx, ./use-metric-series.ts
 * @public
 */

"use client";

import { ChevronRight } from "lucide-react";
import { useId, useRef } from "react";

import { formatValue, subjectFraction, subjectHint, targetText } from "./display.js";
import { AvailabilityStrip, ProgressBar, Sparkline, StatusPill } from "./marks.js";
import type { MetricSubject } from "./metric-subject.js";
import { flagText, formatAge, type MetricFlag, readingTitle, ROLE_META } from "./metrics-view.js";
import { isDeadlineStatus, reasonText, STATUS_META } from "./presentation.js";
import { useMetricSeriesRead, useNearViewport } from "./use-metric-series.js";

/** Why a metric is flagged, as a wrapping chip. */
export function FlagChip({ flag }: { readonly flag: MetricFlag }) {
  return (
    <span
      data-flag={flag.kind}
      className="inline-flex max-w-full items-start gap-1 break-words rounded-xl border border-warning/40 bg-warning/15 px-2 py-0.5 font-medium text-[11px] text-warning leading-4 [overflow-wrap:anywhere]"
    >
      <span aria-hidden="true">⚑</span>
      <span className="min-w-0">{flagText(flag)}</span>
    </span>
  );
}


export function MetricCard({
  subject,
  nowIso,
  open,
  chartId,
  wrap = false,
  variant = "card",
  compact = false,
  onToggle,
}: {
  readonly subject: MetricSubject;
  /** The read's own clock (`asOf`): windows and ages never use the browser clock. */
  readonly nowIso: string;
  readonly open: boolean;
  /** DOM id of the chart this card opens. */
  readonly chartId: string;
  /** Metrics view: the title and hint wrap instead of clipping. */
  readonly wrap?: boolean;
  readonly variant?: "card" | "row";
  /** Row variant in a narrow container (a side sheet): always the stacked layout, never the wide three-column one. */
  readonly compact?: boolean;
  readonly onToggle: () => void;
}) {
  const row = variant === "row";
  const kpi = subject.level === "kpi";
  const describedBy = useId();
  const { display, unit, title, status, target } = subject;
  // A supporting metric reads its own series, but only once its card is near the viewport.
  const cardRef = useRef<HTMLDivElement>(null);
  const { series, pending: seriesPending } = useMetricSeriesRead(subject, nowIso, useNearViewport(cardRef));
  const hint = row ? (targetText(subject) ?? "No target") : subjectHint(subject, series);
  const pending = subject.viewState === "pending";
  const number = subject.value === null ? null : formatValue(subject.value, display, unit);
  const reason = reasonText(subject.reason);
  // A breached target is a fresh reading, so it stays at full strength.
  const muted =
    subject.value !== null && (pending || status === "delayed" || (status === "failing" && subject.reason !== "target_breached"));
  const markLabel = `${title}: ${number ?? "no reading"}; ${hint}`;
  const age = !kpi && subject.observedAt ? formatAge(subject.observedAt, nowIso) : null;
  const roleTag = subject.role && subject.role !== "diagnostic" ? ROLE_META[subject.role].label : null;
  // A KPI is found by `data-kpi`, a supporting metric by `data-metric` and its own status word.
  const attrs = kpi ? { "data-kpi": subject.id } : { "data-metric": subject.id, "data-status": status ?? "no_band" };
  return (
    <div
      ref={cardRef}
      {...attrs}
      data-card={subject.level}
      data-display={display}
      className={`relative ${row ? `rounded-md border ${kpi ? "px-3 py-3" : "px-3 py-2.5"}` : "flex min-h-40 flex-col gap-3 rounded-xl border bg-muted/10 p-4"} transition-colors hover:bg-muted/30 ${open ? "border-foreground/40" : kpi ? "border-border/60" : "border-border/40"}`}
    >
      {/* The whole card is the toggle; its visible content stays outside the button. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? chartId : undefined}
        aria-describedby={describedBy}
        title={reason ?? undefined}
        onClick={onToggle}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="sr-only">{title}</span>
      </button>
      <span id={describedBy} className="sr-only">
        {[
          number ?? "No reading",
          status ? STATUS_META[status].label : "No target",
          hint,
          reason,
          roleTag,
          ...subject.flags.map(flagText),
        ]
          .filter(Boolean)
          .join(". ")}
      </span>
      <div
        aria-hidden="true"
        className={
          row
            ? `pointer-events-none grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 ${compact ? "" : "md:grid-cols-[minmax(0,1fr)_auto_minmax(8rem,12rem)]"}`
            : "pointer-events-none flex flex-1 flex-col gap-3"
        }
      >
        <span
          className={
            row
              ? `col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 break-words text-sm ${compact ? "" : "md:col-span-1"} ${kpi ? "font-medium" : "font-normal"}`
              : `${wrap ? "break-words" : "line-clamp-1"} font-medium text-muted-foreground text-xs uppercase tracking-wider`
          }
        >
          {row && <ChevronRight aria-hidden="true" className={`size-4 shrink-0 ${open ? "rotate-90" : ""}`} />}
          {title}
          {kpi && row && (
            <span className="shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] text-muted-foreground uppercase leading-4 tracking-wide">
              KPI
            </span>
          )}
          {roleTag && (
            <span className="shrink-0 rounded border border-border/60 px-1 font-normal text-[10px] text-muted-foreground uppercase leading-4 tracking-wide">
              {roleTag}
            </span>
          )}
        </span>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={`font-semibold ${row ? (kpi ? "text-xl" : "text-lg") : "text-3xl"} tabular-nums tracking-tight ${muted ? "text-muted-foreground" : ""}`}
            >
              {number ?? "—"}
            </span>
            {number !== null && display !== "slo" && unit && <span className="text-muted-foreground text-xs">{unit}</span>}
          </div>
          {status && <StatusPill status={status} />}
        </div>
        <span className={`${row ? `col-span-2 pl-6 ${compact ? "" : "md:col-span-1"}` : "-mt-2"} ${wrap ? "" : "whitespace-nowrap"} text-muted-foreground text-xs tabular-nums`}>
          {pending
            ? `${hint} · ${(status && isDeadlineStatus(status)) || subject.value === null ? "Pending refresh" : "Pending, historical reading"}`
            : hint}
          {age && subject.observedAt && (
            <span title={readingTitle(subject.observedAt)}>
              {" · "}
              {age}
            </span>
          )}
        </span>
        {subject.flags.length > 0 && (
          <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1 pl-6">
            {subject.flags.map((f) => (
              <FlagChip key={f.kind} flag={f} />
            ))}
          </div>
        )}
        <div className={row ? `col-start-2 row-start-2 min-w-0 ${compact ? "" : "md:col-start-3 md:row-span-2 md:row-start-1"}` : "mt-auto"}>
          {display === "progress" && !row ? (
            <ProgressBar fraction={subjectFraction(subject)} label={markLabel} />
          ) : display === "slo" ? (
            <AvailabilityStrip series={series} binding={target} label={markLabel} loading={seriesPending} />
          ) : (
            <Sparkline series={series} label={markLabel} loading={seriesPending} {...(subject.ownSeries ? { latest: subject } : {})} />
          )}
        </div>
      </div>
    </div>
  );
}
