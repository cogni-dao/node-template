// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals (goals-board)`
 * Purpose: The Goals view, read at a glance. A count strip (goals, KPIs, KPIs
 *   per status), then one collapsible row per goal: its title as the header,
 *   KPI count and most urgent status, and inside, its KPI cards (label, number,
 *   one hint, status, one mark by display type). A card opens its chart.
 * Scope: Reusable client component. Reads goal progress through the injected GoalsClient (default GET /api/v1/metrics/goals); no router import: links are an injected component, default <a>; no
 *   Knowledge-page imports; no compute or write controls. Every card comes
 *   from the read model, so adding or removing a metric or binding needs no UI change.
 * Invariants: STATUS_NEVER_COLOR_ONLY (pill = symbol + word); UNKNOWN_IS_NOT_ZERO
 *   ("—", never 0); NO_SENTENCES_ON_CARDS (the reason is the card's accessible
 *   description and hover title); QUIET_REFRESH (a failed poll keeps the data;
 *   repeated failures, or a response carrying `stale` (metrics >= 0.12.0), mark
 *   it stale; a 401 says signed out);
 *   POLL_ONLY_WHILE_MOUNTED (30s, never in a background tab); IDS_BEHIND_EVIDENCE.
 * Side-effects: IO (via GoalsClient.fetchGoals)
 * Links: ./kpi-chart.tsx, ./display.ts, packages/metrics/src/contracts.ts
 * @public
 */

"use client";

import type { GoalProgress, GoalsProgress } from "@cogni-dao/metrics/contracts";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { goalsErrorStatus } from "./client.js";
import { type GoalsHostOptions, GoalsProvider, useGoalsHost } from "./context.js";
import {
  formatDate,
  formatUtcTime,
  type GoalKpi,
  isMeasured,
  STATUS_META,
  summarize,
  worstStatus,
} from "./presentation.js";
import { KpiChart } from "./kpi-chart.js";
import { StatusPill } from "./marks.js";
import { MetricCard } from "./metric-card.js";
import { kpiSubject } from "./metric-subject.js";
import { KpiBranch, NotServingGroup } from "./metrics-parts.js";
import { hasMetricDetail, servedRows, sortGoals, sortKpis, summarizeMetrics } from "./metrics-view.js";
import { GOALS_POLL_MS, useGoalsProgress } from "./use-goals-progress.js";

export { GOALS_POLL_MS };
/** Consecutive failed polls before the data is marked stale. */
export const STALE_AFTER_FAILURES = 3;
const CARD_GRID = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3";

export interface GoalsBoardProps extends GoalsHostOptions {
  /** SSR seed with the exact wire shape of GET /api/v1/metrics/goals. */
  readonly initialData?: GoalsProgress | undefined;
  /** Show one goal only (goal entry page): no strip, first KPI open. */
  readonly goalId?: string | undefined;
  /** Called by "Signed out · reload". Default reloads the page so the session can be restored. */
  readonly onSignedOut?: (() => void) | undefined;
  /**
   * The Metrics view: goals and KPIs worst first, each KPI with the metrics that
   * serve it grouped by role, then the metrics that serve no KPI. Use `MetricsBoard`.
   */
  readonly metrics?: boolean | undefined;
}

/** The Goals view. Node inputs (client, hrefs, link component, key prefix) are injected; see GoalsHostOptions. */
export function GoalsBoard({ client, queryKeyPrefix, hrefs, LinkComponent, ...rest }: GoalsBoardProps) {
  return (
    <GoalsProvider
      {...(client ? { client } : {})}
      {...(queryKeyPrefix ? { queryKeyPrefix } : {})}
      {...(hrefs ? { hrefs } : {})}
      {...(LinkComponent ? { LinkComponent } : {})}
    >
      <GoalsBoardView {...rest} />
    </GoalsProvider>
  );
}

/** The whole Metrics view: the Goals board with every KPI's serving metrics and the metrics that serve none. */
export function MetricsBoard(props: Omit<GoalsBoardProps, "goalId" | "metrics">) {
  return <GoalsBoard {...props} metrics />;
}

function GoalsBoardView({
  initialData,
  goalId,
  onSignedOut,
  metrics = false,
}: Omit<GoalsBoardProps, keyof GoalsHostOptions>) {
  const { hrefs, Link } = useGoalsHost();
  const query = useGoalsProgress({ initialData });
  const reload = onSignedOut ?? (() => window.location.reload());
  const failures = useFailedPolls(query.errorUpdatedAt, query.dataUpdatedAt);
  const data = query.data;
  const listed = data ? (goalId ? data.goals.filter((g) => g.id === goalId) : data.goals) : [];
  // Metrics view: worst goal first (the Goals view keeps the server's order).
  const goals = metrics ? sortGoals(listed) : listed;
  const signedOut = goalsErrorStatus(query.error) === 401;
  const stale = !!data && (signedOut || failures >= STALE_AFTER_FAILURES || !!data.stale);

  return (
    <section
      aria-label={goalId ? "Goal progress" : metrics ? "Metrics" : "Goals"}
      aria-busy={!data && query.isPending}
      className="space-y-6"
    >
      {!goalId && (data || !query.isError) && (
        <Strip
          data={data ?? null}
          goals={goals}
          metrics={metrics}
          stale={stale}
          signedOut={signedOut}
          onRetry={() => query.refetch()}
          onReload={reload}
        />
      )}
      {!data ? (
        query.isError ? (
          <p role="alert" className="text-muted-foreground text-sm">
            {signedOut ? (
              <ReloadLink onClick={reload} />
            ) : (
              <button type="button" onClick={() => query.refetch()} className="inline-flex min-h-6 items-center underline underline-offset-2">
                {metrics ? "Metrics unavailable · retry" : "Goals unavailable · retry"}
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
          <Link href={hrefs.help} className="underline underline-offset-2">
            how goals work
          </Link>
        </p>
      ) : (
        <div className="space-y-2">
          {metrics && (
            <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">Goals</h2>
          )}
          <ul
            className={`divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 ${stale ? "opacity-70" : ""}`}
          >
            {goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} data={data} metrics={metrics} single={!!goalId} />
            ))}
          </ul>
        </div>
      )}
      {metrics && data && <MetricsFooter data={data} />}
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
          : s,
    );
  }, [errorAt, dataAt]);
  return state.count;
}

function ReloadLink({ onClick }: { readonly onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-warning underline underline-offset-2">
      Signed out · reload
    </button>
  );
}

/** One cell of the statline: a label over a count, or over a placeholder while the first read is pending. */
interface StripCell {
  readonly label: string;
  /** Null while loading: a placeholder, never a zero. */
  readonly value: number | null;
  readonly tone: string;
}

/**
 * The statline: goals and KPIs counted once each, every status a count of KPIs;
 * the Metrics view adds the distinct metrics and those serving no KPI. Until the
 * first read arrives every cell shows a placeholder, never zeros.
 */
function Strip({
  data,
  goals,
  metrics,
  stale,
  signedOut,
  onRetry,
  onReload,
}: {
  /** The read, or null while the first one is pending. */
  readonly data: GoalsProgress | null;
  readonly goals: readonly GoalProgress[];
  readonly metrics: boolean;
  readonly stale: boolean;
  readonly signedOut: boolean;
  readonly onRetry: () => void;
  readonly onReload: () => void;
}) {
  const s = data ? summarize(goals) : null;
  const n = (status: keyof typeof STATUS_META) => (s ? (s.byStatus[status] ?? 0) : null);
  // A loaded board hides an empty optional status; while loading only the always-present ones hold a place.
  const optional = (status: keyof typeof STATUS_META, tone: string): StripCell[] =>
    s && n(status) ? [{ label: STATUS_META[status].short, value: n(status), tone }] : [];
  const detail = data && metrics && hasMetricDetail(data) ? summarizeMetrics(data) : null;
  const cells: StripCell[] = [
    { label: "Goals", value: s?.goals ?? null, tone: "" },
    { label: "KPIs", value: s?.kpis ?? null, tone: "" },
    { label: STATUS_META.on_track.short, value: n("on_track"), tone: "text-success" },
    ...optional("met", "text-success"),
    { label: STATUS_META.behind.short, value: n("behind"), tone: "text-warning" },
    ...optional("missed", "text-destructive"),
    { label: STATUS_META.failing.short, value: n("failing"), tone: "text-destructive" },
    // The Metrics view also counts its metrics; they hold a place while loading and drop out if the read has no detail.
    ...(metrics && (!data || detail)
      ? [
          { label: "Metrics", value: detail?.metrics ?? null, tone: "" },
          { label: "Serve no KPI", value: detail?.notServing ?? null, tone: "text-warning" },
        ]
      : []),
  ];
  return (
    <div data-strip={data ? "ready" : "loading"} className="flex flex-wrap items-end justify-between gap-3">
      <dl
        {...(data ? {} : { "aria-busy": true })}
        className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60"
      >
        {cells.map((c) => (
          <div
            key={c.label}
            className="flex min-w-20 flex-1 flex-col gap-1 bg-background px-3 py-3 sm:min-w-24 sm:flex-none sm:px-4"
          >
            <dt className="text-[11px] text-muted-foreground uppercase tracking-widest">{c.label}</dt>
            <dd
              className={`font-semibold text-2xl tabular-nums leading-none ${c.value ? c.tone : ""}`}
              {...(c.value === null ? { "data-loading": "" } : {})}
            >
              {c.value === null ? (
                <>
                  <span aria-hidden="true" className="inline-block h-6 w-8 animate-pulse rounded bg-muted align-middle" />
                  <span className="sr-only">Loading</span>
                </>
              ) : (
                c.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs" {...(stale ? { role: "status" } : {})}>
        {signedOut ? (
          <ReloadLink onClick={onReload} />
        ) : !data ? null : stale ? (
          <button type="button" onClick={onRetry} className="min-h-6 text-warning underline underline-offset-2">
            Stale · {formatUtcTime(data.asOf)}
          </button>
        ) : (
          `Updated ${formatUtcTime(data.asOf)}`
        )}
      </p>
    </div>
  );
}

function GoalRow({
  goal,
  data,
  metrics,
  single,
}: {
  readonly goal: GoalProgress;
  readonly data: GoalsProgress;
  /** Metrics view: KPIs worst first, each with its serving metrics. */
  readonly metrics: boolean;
  /** The goal entry page: one row, first KPI open. */
  readonly single: boolean;
}) {
  const { hrefs, Link } = useGoalsHost();
  const measured = isMeasured(goal);
  // Until the reader toggles it, a row follows the data: open when measured (always on the goal page).
  const [choice, setChoice] = useState<boolean | null>(null);
  const expanded = choice ?? (single || measured || metrics);
  // A goal may bind one metric twice (a floor and a ceiling), so a card is its
  // position plus metric: if a refresh shifts the bindings, the chart closes
  // instead of silently showing another KPI.
  // `i` is the binding's own position, so the red-first order never swaps cards.
  const keyOf = (kpi: GoalKpi, i: number) => `${i}:${kpi.binding.metricId}`;
  const first = goal.kpis[0];
  const [open, setOpen] = useState<string | null>(single && first ? keyOf(first, 0) : null);
  const bodyId = useId();
  const chartId = useId();
  const openKpi = goal.kpis.find((kpi, i) => keyOf(kpi, i) === open);
  const worst = worstStatus(goal);
  const nowIso = data.asOf;
  const ranked = metrics ? sortKpis(goal.kpis) : goal.kpis.map((kpi, index) => ({ kpi, index }));
  return (
    <li data-goal={goal.id}>
      <h3 className={`flex items-start md:items-center ${metrics ? "border-b border-border/60 bg-muted/40" : ""}`}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setChoice(!expanded)}
          className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-3 pr-2 pl-4 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:flex"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className={`min-w-0 flex-1 ${metrics ? "break-words font-semibold text-lg" : "truncate font-medium text-sm"}`}>
            {goal.title}
          </span>
          {/* Below md the meta is a second line under the title; from md it sits beside it. */}
          <span className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 md:contents">
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {goal.kpis.length ? `${goal.kpis.length} ${goal.kpis.length === 1 ? "KPI" : "KPIs"}` : "No KPIs"}
            </span>
            {measured && worst && <StatusPill status={worst} />}
            {goal.evaluateAt && (
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {formatDate(goal.evaluateAt, true)}
              </span>
            )}
          </span>
        </button>
        {!single && (
          <Link
            href={hrefs.goal(goal.id)}
            aria-label={`Open ${goal.title}`}
            className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-3 py-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </Link>
        )}
      </h3>
      <div id={bodyId} hidden={!expanded} className="space-y-3 px-4 pt-1 pb-4">
        {(expanded || !metrics) && (
          <>
        {goal.kpis.length ? (
          metrics ? (
            <div className="space-y-2 border-l border-border/60 pl-3 md:pl-4">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">KPIs</h4>
              {ranked.map(({ kpi, index }) => {
                const key = keyOf(kpi, index);
                const selected = open === key;
                const detailId = `${chartId}-${index}`;
                return (
                  <div key={key} data-kpi-block={kpi.binding.metricId}>
                    <MetricCard
                      subject={kpiSubject(kpi)}
                      nowIso={nowIso}
                      open={selected}
                      chartId={detailId}
                      wrap
                      variant="row"
                      onToggle={() => setOpen(selected ? null : key)}
                    />
                    {selected && <div id={detailId} className="space-y-4 py-3 pl-3">
                      <KpiChart kpi={kpi} nowIso={nowIso} />
                      {hasMetricDetail(data) ? <KpiBranch rows={servedRows(kpi, data)} nowIso={nowIso} complete={!data.servedTruncated} /> : <p className="text-muted-foreground text-sm">Serving metrics unavailable</p>}
                    </div>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={CARD_GRID}>
              {ranked.map(({ kpi, index }) => {
                const key = keyOf(kpi, index);
                return (
                  <MetricCard
                    key={key}
                    subject={kpiSubject(kpi)}
                    nowIso={nowIso}
                    open={open === key}
                    chartId={chartId}
                    onToggle={() => setOpen(open === key ? null : key)}
                  />
                );
              })}
            </div>
          )
        ) : (
          <p className="text-muted-foreground text-sm">No metric bound</p>
        )}
        {!metrics && openKpi && open && <KpiChart key={open} id={chartId} kpi={openKpi} nowIso={nowIso} />}
          </>
        )}
      </div>
    </li>
  );
}

/** Metrics view footer: the metrics that serve no KPI, and honest notes when the list is cut or unavailable. */
function MetricsFooter({ data }: { readonly data: GoalsProgress }) {
  return (
    <>
      {hasMetricDetail(data) ? (
        <NotServingGroup data={data} />
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {data.servedUnavailable
            ? "Metrics unavailable right now"
            : "This node's metrics package is older than 0.10.0: no metric detail"}
        </p>
      )}
      {data.servedTruncated && (
        <p role="status" className="text-muted-foreground text-xs">
          This list is cut: more metrics exist than one read scans. Read every metric with core__metric_list.
        </p>
      )}
    </>
  );
}
