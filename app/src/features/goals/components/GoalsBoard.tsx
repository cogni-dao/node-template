// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/GoalsBoard`
 * Purpose: The Goals view, read at a glance. A count strip, then each measured
 *   goal as a row of KPI cards (label, number, one hint, status, one mark by
 *   display type). A card opens its chart. Unmeasured goals collapse to one line.
 * Scope: Reusable client component. Reads GET /api/v1/metrics/goals; no
 *   Knowledge-specific imports; no compute or write controls. Every card comes
 *   from the read model, so adding or removing a metric or binding needs no UI change.
 * Invariants: STATUS_NEVER_COLOR_ONLY (pill = symbol + word); UNKNOWN_IS_NOT_ZERO
 *   ("—", never 0); NO_SENTENCES_ON_CARDS (the reason is the card's accessible
 *   description and hover title); QUIET_REFRESH (a failed poll keeps the data;
 *   repeated failures mark it stale; a 401 says signed out);
 *   POLL_ONLY_WHILE_MOUNTED (30s, never in a background tab); IDS_BEHIND_EVIDENCE.
 * Side-effects: IO (via fetchGoalsProgress)
 * Links: ./KpiChart.tsx, ../lib/display.ts, packages/metrics/src/contracts.ts
 * @public
 */

"use client";

import type { GoalProgress, GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { fetchGoalsProgress, GOALS_QUERY_KEY, GoalsReadError } from "../lib/api";
import { cardHint, cardSeries, displayOf, formatValue, progressFraction } from "../lib/display";
import {
  formatDate,
  formatUtcTime,
  type GoalKpi,
  isMeasured,
  reasonText,
  STATUS_META,
  summarize,
} from "../lib/presentation";
import { KpiChart } from "./KpiChart";
import { AvailabilityStrip, ProgressBar, Sparkline, StatusPill } from "./marks";

export const GOALS_POLL_MS = 30_000;
/** Consecutive failed polls before the data is marked stale. */
export const STALE_AFTER_FAILURES = 3;
const CARD_GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3";

export interface GoalsBoardProps {
  /** SSR seed with the exact wire shape of GET /api/v1/metrics/goals. */
  readonly initialData?: GoalsProgress | undefined;
  /** Show one goal only (goal entry page): no strip, first KPI open. */
  readonly goalId?: string | undefined;
}

export function GoalsBoard({ initialData, goalId }: GoalsBoardProps) {
  const query = useQuery({
    queryKey: GOALS_QUERY_KEY,
    queryFn: fetchGoalsProgress,
    initialData,
    staleTime: 15_000,
    refetchInterval: GOALS_POLL_MS,
    refetchIntervalInBackground: false,
    retry: 2,
  });
  const failures = useFailedPolls(query.errorUpdatedAt, query.dataUpdatedAt);
  const data = query.data;
  const goals = data ? (goalId ? data.goals.filter((g) => g.id === goalId) : data.goals) : [];
  const signedOut = query.error instanceof GoalsReadError && query.error.status === 401;
  const stale = !!data && (signedOut || failures >= STALE_AFTER_FAILURES);
  const measured = goals.filter(isMeasured);
  const unmeasured = goals.filter((g) => !isMeasured(g));

  return (
    <section aria-label={goalId ? "Goal progress" : "Goals"} aria-busy={!data && query.isPending} className="space-y-6">
      {!goalId && (
        <Strip goals={goals} asOf={data?.asOf ?? null} stale={stale} signedOut={signedOut} onRetry={() => query.refetch()} />
      )}
      {!data ? (
        query.isError ? (
          <p role="alert" className="text-muted-foreground text-sm">
            {signedOut ? (
              <ReloadLink />
            ) : (
              <button type="button" onClick={() => query.refetch()} className="underline underline-offset-2">
                Goals unavailable · retry
              </button>
            )}
          </p>
        ) : (
          <div aria-hidden="true" className={CARD_GRID}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        )
      ) : goals.length === 0 ? (
        <p className="rounded-xl border border-border/60 border-dashed px-5 py-8 text-center text-muted-foreground text-sm">
          {goalId ? "Not an active goal" : "No goals yet"} ·{" "}
          <Link href="/knowledge/dao-goals-design" className="underline underline-offset-2">
            how goals work
          </Link>
        </p>
      ) : (
        <div className={stale ? "space-y-6 opacity-70" : "space-y-6"}>
          {measured.map((goal) => (
            <GoalSection key={goal.id} goal={goal} nowIso={data.asOf} openFirst={!!goalId} />
          ))}
          {unmeasured.length > 0 &&
            (goalId ? (
              <p className="text-muted-foreground text-sm">No KPI yet</p>
            ) : (
              <details className="text-sm" data-unmeasured>
                <summary className="cursor-pointer text-muted-foreground">
                  {unmeasured.length} {unmeasured.length === 1 ? "goal" : "goals"} without KPIs
                </summary>
                <ul className="mt-2 space-y-1 pl-4">
                  {unmeasured.map((g) => (
                    <li key={g.id} data-goal={g.id}>
                      <Link href={`/knowledge/${encodeURIComponent(g.id)}`} className="hover:underline">
                        {g.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
        </div>
      )}
    </section>
  );
}

/** Failed polls since the last success; a success resets the count. */
function useFailedPolls(errorAt: number, dataAt: number): number {
  const [state, setState] = useState({ count: 0, errorAt, dataAt });
  useEffect(() => {
    setState((s) =>
      dataAt !== s.dataAt
        ? { count: 0, errorAt, dataAt }
        : errorAt !== s.errorAt && errorAt > dataAt
          ? { count: s.count + 1, errorAt, dataAt }
          : s
    );
  }, [errorAt, dataAt]);
  return state.count;
}

function ReloadLink() {
  return (
    <button type="button" onClick={() => window.location.reload()} className="text-warning underline underline-offset-2">
      Signed out · reload
    </button>
  );
}

function Strip({
  goals,
  asOf,
  stale,
  signedOut,
  onRetry,
}: {
  readonly goals: readonly GoalProgress[];
  readonly asOf: string | null;
  readonly stale: boolean;
  readonly signedOut: boolean;
  readonly onRetry: () => void;
}) {
  const s = summarize(goals);
  const cells = [
    { label: "Goals", value: s.active, tone: "" },
    { label: STATUS_META.behind.short, value: s.behind, tone: "text-warning" },
    ...(s.missed ? [{ label: STATUS_META.missed.short, value: s.missed, tone: "text-destructive" }] : []),
    { label: STATUS_META.failing.short, value: s.failing, tone: "text-destructive" },
  ];
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <dl className="flex gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60">
        {cells.map((c) => (
          <div key={c.label} className="flex min-w-24 flex-col gap-1 bg-background px-4 py-3">
            <dt className="text-[11px] text-muted-foreground uppercase tracking-widest">{c.label}</dt>
            <dd className={`font-semibold text-2xl tabular-nums leading-none ${c.value ? c.tone : ""}`}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs" {...(stale ? { role: "status" } : {})}>
        {signedOut ? (
          <ReloadLink />
        ) : stale ? (
          <button type="button" onClick={onRetry} className="text-warning underline underline-offset-2">
            Stale · {asOf ? formatUtcTime(asOf) : "—"}
          </button>
        ) : asOf ? (
          `Updated ${formatUtcTime(asOf)}`
        ) : null}
      </p>
    </div>
  );
}

function GoalSection({
  goal,
  nowIso,
  openFirst,
}: {
  readonly goal: GoalProgress;
  readonly nowIso: string;
  readonly openFirst: boolean;
}) {
  // A goal may bind one metric twice (a floor and a ceiling): cards are keyed by position.
  const [open, setOpen] = useState<number | null>(openFirst && goal.kpis.length ? 0 : null);
  const chartId = useId();
  const openKpi = open === null ? undefined : goal.kpis[open];
  return (
    <div data-goal={goal.id} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-sm">
          <Link href={`/knowledge/${encodeURIComponent(goal.id)}`} className="hover:underline">
            {goal.title}
          </Link>
        </h3>
        {goal.evaluateAt && (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatDate(goal.evaluateAt, true)}</span>
        )}
      </div>
      <div className={CARD_GRID}>
        {goal.kpis.map((kpi, i) => (
          <KpiCard
            // biome-ignore lint/suspicious/noArrayIndexKey: bindings are positional; a metric may repeat
            key={i}
            kpi={kpi}
            open={open === i}
            chartId={chartId}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </div>
      {openKpi && open !== null && <KpiChart key={open} id={chartId} kpi={openKpi} nowIso={nowIso} />}
    </div>
  );
}

function KpiCard({
  kpi,
  open,
  chartId,
  onToggle,
}: {
  readonly kpi: GoalKpi;
  readonly open: boolean;
  readonly chartId: string;
  readonly onToggle: () => void;
}) {
  const describedBy = useId();
  const display = displayOf(kpi);
  const series = cardSeries(kpi);
  const hint = cardHint(kpi, display, series);
  const a = kpi.assessment;
  const unit = kpi.binding.target.unit;
  const title = kpi.metric?.title ?? kpi.binding.metricId;
  const number = a.value === null ? null : formatValue(a.value, display, unit);
  const reason = reasonText(a.reason);
  const muted = a.value !== null && (a.status === "delayed" || a.status === "failing");
  const markLabel = `${title}: ${number ?? "no reading"}; ${hint}`;
  return (
    <div
      data-kpi={kpi.binding.metricId}
      data-display={display}
      className={`relative flex min-h-40 flex-col gap-3 rounded-xl border bg-muted/10 p-4 transition-colors hover:bg-muted/30 ${open ? "border-foreground/40" : "border-border/60"}`}
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
        {[number ?? "No reading", STATUS_META[a.status].label, hint, reason].filter(Boolean).join(". ")}
      </span>
      <div aria-hidden="true" className="pointer-events-none flex flex-1 flex-col gap-3">
        <span className="line-clamp-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">{title}</span>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className={`font-semibold text-3xl tabular-nums tracking-tight ${muted ? "text-muted-foreground" : ""}`}>
              {number ?? "—"}
            </span>
            {number !== null && display !== "slo" && <span className="text-muted-foreground text-xs">{unit}</span>}
          </div>
          <StatusPill status={a.status} />
        </div>
        <span className="-mt-2 whitespace-nowrap text-muted-foreground text-xs tabular-nums">{hint}</span>
        <div className="mt-auto">
          {display === "progress" ? (
            <ProgressBar fraction={progressFraction(kpi)} label={markLabel} />
          ) : display === "slo" ? (
            <AvailabilityStrip series={series} binding={kpi.binding} label={markLabel} />
          ) : (
            <Sparkline series={series} label={markLabel} />
          )}
        </div>
      </div>
    </div>
  );
}
