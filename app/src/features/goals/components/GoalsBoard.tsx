// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/GoalsBoard`
 * Purpose: The Goals view. One row per active goal answers "Will we make it?":
 *   goal + KPI, value against target (bullet), 30-day trend, status in a word.
 *   Rows expand to a dated history chart, pace, bets and an evidence link.
 * Scope: Reusable client component. Reads GET /api/v1/metrics/goals; no
 *   Knowledge-specific imports; no compute or write controls.
 * Invariants: STATUS_NEVER_COLOR_ONLY; UNKNOWN_IS_NOT_ZERO; STALE_NEVER_LOOKS_CURRENT
 *   (a failed refresh keeps the last data labeled "not current"); POLL_ONLY_WHILE_MOUNTED
 *   (30s, never in a background tab); IDS_BEHIND_EVIDENCE (no operational IDs on a row).
 * Side-effects: IO (via fetchGoalsProgress)
 * Links: ../lib/presentation.ts, packages/metrics/src/contracts.ts, .context/design-0024/goals-visual.html
 * @public
 */

"use client";

import type { GoalProgress, GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight } from "lucide-react";
import Link from "next/link";
import { type MouseEvent, type ReactNode, useId, useState } from "react";

import { fetchGoalsProgress, GOALS_QUERY_KEY } from "../lib/api";
import {
  COMPARATOR_SYMBOL,
  deadlineText,
  formatDate,
  formatNumber,
  formatReadingTime,
  formatSigned,
  type GoalKpi,
  plural,
  reasonText,
  STATUS_META,
  statusCaption,
  summarize,
  targetText,
  unitLabel,
  valueIsCurrent,
} from "../lib/presentation";
import { HistoryChart } from "./HistoryChart";
import { BulletGraph, Sparkline, StatusPill } from "./marks";

export const GOALS_POLL_MS = 30_000;
const ROW_GRID =
  "@2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1.45fr)_150px_11rem] @2xl:items-center @2xl:gap-x-6";

export interface GoalsBoardProps {
  /** SSR seed with the exact wire shape of GET /api/v1/metrics/goals. */
  readonly initialData?: GoalsProgress | undefined;
  /** Show one goal only (goal entry page): no summary strip, row starts open. */
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
    retry: 1,
  });
  const data = query.data;
  const goals = data
    ? goalId
      ? data.goals.filter((g) => g.id === goalId)
      : data.goals
    : [];
  const notCurrent = query.isError && !!data;

  return (
    <section
      aria-label={goalId ? "Goal progress" : "Goals"}
      aria-busy={!data && query.isPending}
      className="@container"
    >
      {query.isError && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-600/35 bg-amber-400/10 px-3 py-2 text-sm dark:border-amber-300/30"
        >
          <span>
            <span aria-hidden="true">! </span>
            {data
              ? `Goals could not be refreshed. Showing readings as of ${formatReadingTime(data.asOf, new Date().toISOString())}; they are not current.`
              : "Goals could not be read. Their progress is unknown, not zero."}
          </span>
          <button
            type="button"
            onClick={() => query.refetch()}
            className="rounded-md border border-border px-2 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </div>
      )}

      {!goalId && (
        <SummaryStrip
          data={data}
          goals={goals}
          notCurrent={notCurrent}
          failed={query.isError}
        />
      )}

      {!data ? (
        query.isError ? null : (
          <SkeletonRows count={goalId ? 1 : 3} />
        )
      ) : goals.length === 0 ? (
        <EmptyState goalId={goalId} />
      ) : (
        <>
          <div
            aria-hidden="true"
            className={`hidden px-0.5 pt-3 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em] @2xl:grid ${ROW_GRID}`}
          >
            <span>Goal and KPI</span>
            <span>Now vs target</span>
            <span>Last 30 days</span>
            <span>Status</span>
          </div>
          <ul className={notCurrent ? "opacity-75" : undefined}>
            {goals.map((goal) => (
              <GoalRow
                key={goal.id}
                goal={goal}
                nowIso={data.asOf}
                defaultOpen={!!goalId}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ summary

function SummaryStrip({
  data,
  goals,
  notCurrent,
  failed,
}: {
  readonly data: GoalsProgress | undefined;
  readonly goals: readonly GoalProgress[];
  readonly notCurrent: boolean;
  readonly failed: boolean;
}) {
  // Nothing to summarize: the alert or the empty state speaks alone.
  if ((!data && failed) || (data && goals.length === 0)) return null;
  if (!data)
    return (
      <div className="flex min-h-11 flex-wrap items-baseline gap-x-6 gap-y-1 border-border border-b pb-3">
        <span className="inline-block h-5 w-56 animate-pulse rounded bg-muted" />
        <span className="inline-block h-4 w-24 animate-pulse rounded bg-muted" />
        <span className="ml-auto inline-block h-4 w-48 animate-pulse rounded bg-muted" />
      </div>
    );
  const s = summarize(goals);
  const due = deadlineText(s.deadlines, s.active, data.asOf);
  return (
    <div className="flex min-h-11 flex-wrap items-baseline gap-x-6 gap-y-1 border-border border-b pb-3 text-[13px] tabular-nums">
      <span>
        <b className="font-semibold text-foreground text-xl">{s.active}</b>{" "}
        <span className="text-muted-foreground">
          active {s.active === 1 ? "goal" : "goals"}
          {due ? ` · ${due}` : ""}
        </span>
      </span>
      {s.active > 0 && (
        <span>
          <b className="font-semibold">{s.measured}</b>{" "}
          <span className="text-muted-foreground">measured</span>
        </span>
      )}
      {s.behind > 0 && (
        <span>
          <b className="font-semibold text-amber-800 dark:text-amber-200">
            {STATUS_META.behind.symbol} {s.behind}
          </b>{" "}
          <span className="text-muted-foreground">behind pace</span>
        </span>
      )}
      {s.failing > 0 && (
        <span>
          <b className="font-semibold text-red-800 dark:text-red-300">
            {STATUS_META.failing.symbol} {s.failing}
          </b>{" "}
          <span className="text-muted-foreground">failing to measure</span>
        </span>
      )}
      {s.missed > 0 && (
        <span>
          <b className="font-semibold text-red-800 dark:text-red-300">
            {STATUS_META.missed.symbol} {s.missed}
          </b>{" "}
          <span className="text-muted-foreground">missed</span>
        </span>
      )}
      {s.notMeasured > 0 && (
        <span>
          <b className="font-semibold">{s.notMeasured}</b>{" "}
          <span className="text-muted-foreground">not measured yet</span>
        </span>
      )}
      <span className="text-muted-foreground @2xl:ml-auto">
        {notCurrent ? (
          <>
            <b className="font-semibold text-foreground">Not current</b> · as of{" "}
            {formatReadingTime(data.asOf, data.asOf)}
          </>
        ) : (
          <>
            Updated automatically ·{" "}
            {s.lastReadingAt
              ? `last reading ${formatReadingTime(s.lastReadingAt, data.asOf)}`
              : "no readings yet"}
          </>
        )}
      </span>
    </div>
  );
}

function SkeletonRows({ count }: { readonly count: number }) {
  return (
    <div aria-hidden="true">
      <div className="hidden h-8 @2xl:block" />
      {Array.from({ length: count }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          key={i}
          className={`grid min-h-[84px] gap-2 border-border border-t py-3.5 ${ROW_GRID}`}
        >
          <div className="space-y-2">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
          <div className="space-y-2">
            <div className="h-5 w-16 animate-pulse rounded bg-muted" />
            <div className="h-[22px] w-full animate-pulse rounded bg-muted" />
          </div>
          <div className="hidden h-10 animate-pulse rounded bg-muted @2xl:block" />
          <div className="h-6 w-28 animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ goalId }: { readonly goalId: string | undefined }) {
  return (
    <div className="mt-3 rounded-lg border border-border border-dashed px-5 py-8 text-center">
      <p className="font-medium">
        {goalId ? "This goal is not active" : "No approved goals yet"}
      </p>
      <p className="mt-1 text-muted-foreground text-sm">
        {goalId
          ? "Only approved, active goals report progress."
          : "Goals appear here once a goal entry is approved into the knowledge base."}{" "}
        <Link
          href="/knowledge/dao-goals-design"
          className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          How goals are approved
        </Link>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ row

function kpiCaption(kpi: GoalKpi | undefined): string {
  if (!kpi) return "No KPI bound yet";
  if (!kpi.metric) return `${kpi.binding.metricId} · not computed yet`;
  const name = kpi.metric.title;
  const cadence = kpi.metric?.cadenceSeconds;
  const every =
    cadence == null
      ? null
      : cadence % 86_400 === 0
        ? cadence === 86_400
          ? "daily reading"
          : `every ${plural(cadence / 86_400, "day")}`
        : cadence % 3_600 === 0
          ? cadence === 3_600
            ? "hourly reading"
            : `every ${plural(cadence / 3_600, "hour")}`
          : `every ${plural(cadence / 60, "minute")}`;
  return [name, every].filter(Boolean).join(" · ");
}

function GoalRow({
  goal,
  nowIso,
  defaultOpen,
}: {
  readonly goal: GoalProgress;
  readonly nowIso: string;
  readonly defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailId = useId();
  const primary = goal.kpis[0];
  const others = goal.kpis.slice(1);
  const status = goal.configurationError
    ? "not_measured"
    : (primary?.assessment.status ?? "not_measured");

  // Pointer convenience: a click anywhere on the row toggles it. Keyboard and
  // screen-reader users use the title button, which owns aria-expanded.
  const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    if (window.getSelection()?.toString()) return;
    setOpen((v) => !v);
  };

  return (
    <li className="border-border border-t" data-goal={goal.id}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the title button is the accessible control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard control */}
      <div
        onClick={onRowClick}
        className={`grid cursor-pointer gap-x-4 gap-y-2 rounded-md px-0.5 py-3.5 hover:bg-muted/30 ${ROW_GRID}`}
      >
        <div className="min-w-0">
          <h3 className="font-semibold text-[15px] leading-snug">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              onClick={() => setOpen((v) => !v)}
              className="-mx-1 inline-flex items-start gap-1 rounded px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                aria-hidden="true"
                className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
              />
              <span>{goal.title}</span>
            </button>
          </h3>
          <p className="mt-0.5 pl-5 text-muted-foreground text-xs">
            {goal.configurationError
              ? "KPI binding is invalid"
              : kpiCaption(primary)}
          </p>
        </div>
        <NowVsTarget goal={goal} kpi={primary} status={status} nowIso={nowIso} />
        <div className="hidden @2xl:block">
          {primary ? (
            <Sparkline
              trend={primary.trend}
              target={primary.binding.target.value}
              comparator={primary.binding.comparator}
            />
          ) : (
            <Sparkline trend={null} target={null} comparator={null} />
          )}
        </div>
        <StatusCell kpi={primary} status={status} nowIso={nowIso} />
      </div>

      {others.map((kpi) => (
        <SubKpiRow key={kpi.binding.metricId} kpi={kpi} nowIso={nowIso} />
      ))}

      <div id={detailId} hidden={!open}>
        {open && <GoalDetail goal={goal} nowIso={nowIso} />}
      </div>
    </li>
  );
}

function ValueLine({
  kpi,
  status,
  nowIso,
  size,
}: {
  readonly kpi: GoalKpi;
  readonly status: GoalProgress["kpis"][number]["assessment"]["status"];
  readonly nowIso: string;
  readonly size: "lg" | "sm";
}) {
  const a = kpi.assessment;
  const current = valueIsCurrent(status);
  if (a.value === null) return null;
  return (
    <span className="tabular-nums">
      <b
        className={`font-semibold ${size === "lg" ? "text-xl" : "text-sm"} ${current ? "text-foreground" : "text-muted-foreground"}`}
      >
        {formatNumber(a.value, a.unit)}
      </b>{" "}
      <span className="text-muted-foreground text-xs">
        {unitLabel(a.value, a.unit)}
        {!current && a.observedAt
          ? ` · last good, ${formatReadingTime(a.observedAt, nowIso)}`
          : ""}
      </span>
    </span>
  );
}

function NowVsTarget({
  goal,
  kpi,
  status,
  nowIso,
}: {
  readonly goal: GoalProgress;
  readonly kpi: GoalKpi | undefined;
  readonly status: GoalProgress["kpis"][number]["assessment"]["status"];
  readonly nowIso: string;
}) {
  const mobilePill = (
    <StatusPill status={status} short className="@2xl:hidden" />
  );
  if (!kpi || goal.configurationError)
    return (
      <div className="flex items-start justify-between gap-3 text-[13px]">
        <p className="text-muted-foreground">
          No reading. This is unknown, not zero.
          <br />
          <span className="text-foreground">
            {goal.configurationError
              ? "Its KPI binding is invalid; fix the goal entry."
              : "No metric is bound to this goal yet."}
          </span>
        </p>
        {mobilePill}
      </div>
    );
  const a = kpi.assessment;
  const target = `${targetText(a.comparator, a.target)} ${unitLabel(a.target.value, a.target.unit)}`;
  if (a.value === null)
    return (
      <div className="flex items-start justify-between gap-3 text-[13px]">
        <p className="text-muted-foreground">
          {status === "not_measured"
            ? "No reading. This is unknown, not zero."
            : "No reading yet. This is unknown, not zero."}
          <br />
          {status === "not_measured" && (
            <span className="text-foreground">
              {reasonText(a.reason) ?? "Not measured yet."}{" "}
            </span>
          )}
          <span className="tabular-nums">Target {target}.</span>
        </p>
        {mobilePill}
      </div>
    );
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <ValueLine kpi={kpi} status={status} nowIso={nowIso} size="lg" />
        <span className="hidden text-muted-foreground text-xs tabular-nums @2xl:inline">
          target {target}
        </span>
        <span className="flex items-baseline gap-2 @2xl:hidden">
          <span className="text-muted-foreground text-xs tabular-nums">
            / {targetText(a.comparator, a.target)}
          </span>
          {mobilePill}
        </span>
      </div>
      <BulletGraph
        value={a.value}
        unit={a.unit}
        comparator={a.comparator}
        target={a.target.value}
        current={valueIsCurrent(status)}
      />
    </div>
  );
}

function StatusCell({
  kpi,
  status,
  nowIso,
}: {
  readonly kpi: GoalKpi | undefined;
  readonly status: GoalProgress["kpis"][number]["assessment"]["status"];
  readonly nowIso: string;
}) {
  // Not-measured rows already say what is missing in "Now vs target".
  const caption =
    kpi && status !== "not_measured"
      ? statusCaption(kpi.assessment, nowIso, kpi.metric?.maxAgeSeconds ?? null)
      : null;
  return (
    <div className="min-w-0">
      <div className="hidden @2xl:block">
        <StatusPill status={status} />
      </div>
      {caption && (
        <p className="text-muted-foreground text-xs tabular-nums @2xl:mt-1">
          {caption}
        </p>
      )}
    </div>
  );
}

function SubKpiRow({
  kpi,
  nowIso,
}: {
  readonly kpi: GoalKpi;
  readonly nowIso: string;
}) {
  const a = kpi.assessment;
  const caption =
    a.status !== "not_measured"
      ? statusCaption(a, nowIso, kpi.metric?.maxAgeSeconds ?? null)
      : reasonText(a.reason);
  return (
    <div
      className={`grid gap-x-4 gap-y-1.5 border-border/60 border-t border-dashed px-0.5 py-2.5 pl-5 text-xs @2xl:pl-0.5 ${ROW_GRID}`}
    >
      <p className="min-w-0 text-muted-foreground @2xl:pl-5">
        <CornerDownRight
          aria-hidden="true"
          className="mr-1 inline size-3.5 -translate-y-px align-middle"
        />
        {kpiCaption(kpi)}
      </p>
      <div className="min-w-0">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          {a.value !== null ? (
            <ValueLine kpi={kpi} status={a.status} nowIso={nowIso} size="sm" />
          ) : (
            <span className="text-muted-foreground">No reading</span>
          )}
          <span className="text-muted-foreground tabular-nums">
            target {targetText(a.comparator, a.target)}
          </span>
        </div>
        {a.value !== null && (
          <BulletGraph
            value={a.value}
            unit={a.unit}
            comparator={a.comparator}
            target={a.target.value}
            current={valueIsCurrent(a.status)}
            compact
          />
        )}
      </div>
      <div className="hidden @2xl:block">
        <Sparkline
          trend={kpi.trend}
          target={kpi.binding.target.value}
          comparator={kpi.binding.comparator}
          height={28}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 @2xl:block">
        <StatusPill status={a.status} />
        {caption && (
          <p className="text-muted-foreground tabular-nums @2xl:mt-1">
            {caption}
          </p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ detail

function GoalDetail({
  goal,
  nowIso,
}: {
  readonly goal: GoalProgress;
  readonly nowIso: string;
}) {
  const [index, setIndex] = useState(0);
  const kpi = goal.kpis[index] ?? goal.kpis[0];
  const openBets = goal.hypotheses.filter((h) => !h.outcome && h.evaluateAt);
  const metricTitle = new Map(
    goal.kpis.map((k) => [k.binding.metricId, k.metric?.title ?? null])
  );
  const nextBet = [...openBets].sort(
    (x, y) => Date.parse(x.evaluateAt ?? "") - Date.parse(y.evaluateAt ?? "")
  )[0];

  return (
    <div className="mx-0.5 mb-4 space-y-4 rounded-lg bg-muted/40 p-4">
      {goal.kpis.length > 1 && (
        <fieldset className="flex flex-wrap gap-1.5 text-xs">
          <legend className="sr-only">KPI to chart</legend>
          {goal.kpis.map((k, i) => (
            <button
              key={k.binding.metricId}
              type="button"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className={`rounded-md border px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                i === index
                  ? "border-foreground/40 bg-background font-medium"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {k.metric?.title ?? k.binding.metricId}
            </button>
          ))}
        </fieldset>
      )}

      {kpi?.metric ? (
        <HistoryChart
          key={kpi.binding.metricId}
          metricId={kpi.binding.metricId}
          title={kpi.metric.title}
          assessment={kpi.assessment}
          nowIso={nowIso}
          bets={openBets.map((h) => ({
            id: h.id,
            title: h.title,
            at: h.evaluateAt as string,
          }))}
        />
      ) : (
        <p className="rounded-md border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
          {kpi
            ? `${reasonText(kpi.assessment.reason) ?? "This KPI is not computed yet."} There is no history to chart.`
            : "No metric is bound to this goal, so there is no history to chart."}
        </p>
      )}

      <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 @3xl:grid-cols-4">
        {kpi && (
          <Fact label="Latest reading">
            {kpi.assessment.value !== null && kpi.assessment.observedAt ? (
              <span className="tabular-nums">
                {formatNumber(kpi.assessment.value, kpi.assessment.unit)}{" "}
                {unitLabel(kpi.assessment.value, kpi.assessment.unit)} ·{" "}
                {formatReadingTime(kpi.assessment.observedAt, nowIso)}
                {!valueIsCurrent(kpi.assessment.status) && (
                  <span className="text-muted-foreground"> (not current)</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">None yet</span>
            )}
          </Fact>
        )}
        {kpi && <PaceFact kpi={kpi} />}
        <Fact label="Bets on this goal">
          {goal.hypothesesUnavailable ? (
            <span className="text-muted-foreground">
              Could not be read right now
            </span>
          ) : goal.hypotheses.length === 0 ? (
            <span className="text-muted-foreground">None yet</span>
          ) : (
            <span className="tabular-nums">
              {openBets.length} open
              {nextBet?.evaluateAt
                ? ` · next evaluates ${formatDate(nextBet.evaluateAt)}`
                : ""}
            </span>
          )}
        </Fact>
        <Fact label="Evidence">
          <span className="flex flex-wrap gap-x-3">
            {kpi?.assessment.observationId && (
              <Link
                href={`/knowledge/${encodeURIComponent(kpi.binding.metricId)}?observation=${encodeURIComponent(kpi.assessment.observationId)}`}
                className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Inspect reading ↗
              </Link>
            )}
            <Link
              href={`/knowledge/${encodeURIComponent(goal.id)}`}
              className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Goal entry ↗
            </Link>
          </span>
        </Fact>
      </dl>

      {goal.hypotheses.length > 0 && (
        <section aria-label="Bets on this goal">
          <h4 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
            Bets
          </h4>
          <ul className="divide-y divide-border/60">
            {goal.hypotheses.map((h) => (
              <li key={h.id} className="py-2 text-[13px]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Link
                    href={`/knowledge/${encodeURIComponent(h.id)}`}
                    className="font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {h.title}
                  </Link>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {h.evaluateAt
                      ? `${Date.parse(h.evaluateAt) > Date.parse(nowIso) ? "evaluates" : "evaluated"} ${formatDate(h.evaluateAt, true)}`
                      : "no evaluation date"}
                  </span>
                </div>
                {h.predictions.map((p) => (
                  <div
                    key={p.binding.metricId}
                    className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs tabular-nums"
                  >
                    <StatusPill status={p.assessment.status} short />
                    <span>
                      Predicts{" "}
                      {metricTitle.get(p.binding.metricId) ??
                        p.binding.metricId}{" "}
                      {COMPARATOR_SYMBOL[p.binding.comparator]}{" "}
                      {formatNumber(
                        p.binding.target.value,
                        p.binding.target.unit
                      )}{" "}
                      {unitLabel(p.binding.target.value, p.binding.target.unit)}
                      {p.baselineValue !== null
                        ? ` · baseline ${formatNumber(p.baselineValue, p.binding.target.unit)}`
                        : ""}
                      {p.assessment.value !== null
                        ? ` · now ${formatNumber(p.assessment.value, p.assessment.unit)}`
                        : ""}
                    </span>
                  </div>
                ))}
                {h.outcome && (
                  <p className="mt-1 text-xs">
                    Outcome:{" "}
                    <Link
                      href={`/knowledge/${encodeURIComponent(h.outcome.id)}`}
                      className="underline underline-offset-2"
                    >
                      {h.outcome.title}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      ({h.outcome.supports ? "supports" : "contradicts"} the bet)
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
          {goal.moreHypotheses && (
            <p className="mt-1 text-muted-foreground text-xs">
              More bets exist.{" "}
              <Link
                href={`/knowledge/${encodeURIComponent(goal.id)}`}
                className="underline underline-offset-2"
              >
                Open the goal entry
              </Link>{" "}
              to see them all.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function PaceFact({ kpi }: { readonly kpi: GoalKpi }) {
  const { pace, target, deadline, unit } = kpi.assessment;
  const by = deadline ? ` by ${formatDate(deadline)}` : "";
  return (
    <Fact label="Pace">
      {pace.observed === null && pace.needed === null ? (
        <span className="text-muted-foreground">
          Not enough history for a pace yet
        </span>
      ) : (
        <span className="tabular-nums">
          {pace.observed !== null
            ? `Observed ${formatSigned(pace.observed, unit)} / week`
            : "Observed pace unknown"}
          {pace.needed !== null
            ? ` · needed ${formatSigned(pace.needed, unit)} / week to reach ${formatNumber(target.value, target.unit)} ${unitLabel(target.value, unit)}${by}`
            : ""}
        </span>
      )}
    </Fact>
  );
}
