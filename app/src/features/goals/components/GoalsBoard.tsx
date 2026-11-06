// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/GoalsBoard`
 * Purpose: The Goals view, read at a glance. A three-number strip, then each
 *   measured goal as a row of KPI cards (label, number, one hint, status, one
 *   mark by display type). A card opens its chart. Unmeasured goals collapse to
 *   one line.
 * Scope: Reusable client component. Reads GET /api/v1/metrics/goals; no
 *   Knowledge-specific imports; no compute or write controls.
 * Invariants: STATUS_NEVER_COLOR_ONLY (pill = symbol + word); UNKNOWN_IS_NOT_ZERO
 *   ("—", never 0); NO_SENTENCES_ON_CARDS (reasons live in the pill tooltip);
 *   QUIET_REFRESH (a failed poll keeps the data; only repeated failures mark it
 *   stale, a 401 says signed out); POLL_ONLY_WHILE_MOUNTED (30s, never in a
 *   background tab); IDS_BEHIND_EVIDENCE.
 * Side-effects: IO (via fetchGoalsProgress)
 * Links: ./KpiChart.tsx, ../lib/display.ts, packages/metrics/src/contracts.ts
 * @public
 */

"use client";

import type { GoalProgress, GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { fetchGoalsProgress, GOALS_QUERY_KEY } from "../lib/api";
import { cardHint, cardNumber, displayOf, progressFraction, seriesSpan } from "../lib/display";
import {
  formatDate,
  formatUtcTime,
  type GoalKpi,
  isMeasured,
  reasonText,
  summarize,
} from "../lib/presentation";
import { KpiChart } from "./KpiChart";
import { AvailabilityStrip, ProgressBar, Sparkline, StatusPill, sloLabel } from "./marks";

export const GOALS_POLL_MS = 30_000;
/** Consecutive failed polls before the data is marked stale. */
export const STALE_AFTER_FAILURES = 3;

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
  const failures = useConsecutiveFailures(query.errorUpdatedAt, query.dataUpdatedAt);
  const data = query.data;
  const goals = data ? (goalId ? data.goals.filter((g) => g.id === goalId) : data.goals) : [];
  const signedOut = query.isError && /:401$/.test(String(query.error?.message));
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
            {signedOut ? "Signed out · reload" : "Goals unavailable · "}
            {!signedOut && (
              <button type="button" onClick={() => query.refetch()} className="underline underline-offset-2">
                Retry
              </button>
            )}
          </p>
        ) : (
          <CardsSkeleton />
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
                        {goalTitle(g.title)}
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

/** Count failed polls since the last success. */
function useConsecutiveFailures(errorAt: number, dataAt: number): number {
  const count = useRef(0);
  const [value, setValue] = useState(0);
  const lastError = useRef(errorAt);
  useEffect(() => {
    if (errorAt && errorAt !== lastError.current && errorAt > dataAt) {
      lastError.current = errorAt;
      count.current += 1;
      setValue(count.current);
    }
  }, [errorAt, dataAt]);
  useEffect(() => {
    count.current = 0;
    setValue(0);
  }, [dataAt]);
  return value;
}

/** "Goal: AI work converges" reads as "AI work converges". */
function goalTitle(title: string): string {
  return title.replace(/^Goal:\s*/i, "");
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
    { label: "Behind", value: s.behind + s.missed, tone: s.behind + s.missed ? "text-amber-600 dark:text-amber-300" : "" },
    { label: "Failing", value: s.failing, tone: s.failing ? "text-red-600 dark:text-red-400" : "" },
  ];
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60">
        {cells.map((c) => (
          <div key={c.label} className="flex min-w-24 flex-col gap-1 bg-background px-4 py-3">
            <dt className="text-[11px] text-muted-foreground uppercase tracking-widest">{c.label}</dt>
            <dd className={`font-semibold text-2xl tabular-nums leading-none ${c.tone}`}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs" {...(stale ? { role: "status" } : {})}>
        {signedOut ? (
          <button type="button" onClick={() => window.location.reload()} className="text-amber-600 underline underline-offset-2 dark:text-amber-300">
            Signed out · reload
          </button>
        ) : stale ? (
          <button type="button" onClick={onRetry} className="text-amber-600 underline underline-offset-2 dark:text-amber-300">
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
  const kpis = goal.kpis;
  const [open, setOpen] = useState<string | null>(openFirst ? (kpis[0]?.binding.metricId ?? null) : null);
  const openKpi = kpis.find((k) => k.binding.metricId === open);
  return (
    <div data-goal={goal.id} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-sm">
          <Link href={`/knowledge/${encodeURIComponent(goal.id)}`} className="hover:underline">
            {goalTitle(goal.title)}
          </Link>
        </h3>
        {goal.evaluateAt && (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatDate(goal.evaluateAt, true)}</span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.binding.metricId}
            kpi={kpi}
            open={open === kpi.binding.metricId}
            onToggle={() => setOpen(open === kpi.binding.metricId ? null : kpi.binding.metricId)}
          />
        ))}
      </div>
      {openKpi && <KpiChart key={openKpi.binding.metricId} kpi={openKpi} nowIso={nowIso} />}
    </div>
  );
}

function KpiCard({
  kpi,
  open,
  onToggle,
}: {
  readonly kpi: GoalKpi;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const display = displayOf(kpi);
  const series = kpi.trend;
  const num = cardNumber(kpi, display);
  const hint = cardHint(kpi, display);
  const a = kpi.assessment;
  const title = kpi.metric?.title ?? kpi.binding.metricId;
  const muted = a.value !== null && (a.status === "delayed" || a.status === "failing");
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      data-kpi={kpi.binding.metricId}
      data-display={display}
      className={`flex min-h-40 flex-col gap-3 rounded-xl border bg-muted/10 p-4 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring ${open ? "border-foreground/40" : "border-border/60"}`}
    >
      <span className="line-clamp-1 font-medium text-muted-foreground text-xs uppercase tracking-wider" title={title}>
        {title}
      </span>
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={`font-semibold text-3xl tabular-nums tracking-tight ${muted ? "text-muted-foreground" : ""}`}
            {...(num.value === null ? { "aria-label": "No reading" } : {})}
          >
            {num.value ?? "—"}
          </span>
          {num.value !== null && num.unit && <span className="text-muted-foreground text-xs">{num.unit}</span>}
        </div>
        <StatusPill status={a.status} title={reasonText(a.reason) ?? undefined} />
      </div>
      {hint && <span className="-mt-2 whitespace-nowrap text-muted-foreground text-xs tabular-nums">{hint}</span>}
      <div className="mt-auto w-full">
        {display === "progress" ? (
          <ProgressBar fraction={progressFraction(kpi)} label={`${title}: ${num.value ?? "no reading"}, target ${hint ?? ""}`} />
        ) : display === "slo" ? (
          <AvailabilityStrip trend={series} target={kpi.binding.target.value} label={sloLabel(a.value, kpi.binding.target.value)} />
        ) : (
          <Sparkline trend={series} label={`${title}, ${series ? `last ${seriesSpan(series)}` : "no history"}; now ${num.value ?? "no reading"}`} />
        )}
      </div>
    </button>
  );
}

function CardsSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}
