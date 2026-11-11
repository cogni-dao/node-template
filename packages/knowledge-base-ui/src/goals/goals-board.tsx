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
 *   repeated failures mark it stale; a 401 says signed out);
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
import { cardHint, cardSeries, displayOf, formatValue, progressFraction } from "./display.js";
import {
  formatDate,
  formatUtcTime,
  type GoalKpi,
  isMeasured,
  reasonText,
  STATUS_META,
  summarize,
  worstStatus,
} from "./presentation.js";
import { KpiChart } from "./kpi-chart.js";
import { AvailabilityStrip, ProgressBar, Sparkline, StatusPill } from "./marks.js";
import { KpiBranch, NotServingGroup } from "./metrics-parts.js";
import {
  hasMetricDetail,
  type MetricsSummary,
  servedRows,
  sortGoals,
  sortKpis,
  summarizeMetrics,
} from "./metrics-view.js";
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

function GoalsBoardView({ initialData, goalId, onSignedOut, metrics = false }: Omit<GoalsBoardProps, keyof GoalsHostOptions>) {
  const { hrefs, Link } = useGoalsHost();
  const query = useGoalsProgress({ initialData });
  const reload = onSignedOut ?? (() => window.location.reload());
  const failures = useFailedPolls(query.errorUpdatedAt, query.dataUpdatedAt);
  const data = query.data;
  const listed = data ? (goalId ? data.goals.filter((g) => g.id === goalId) : data.goals) : [];
  // Metrics view: worst goal first (the Goals view keeps the server's order).
  const goals = metrics ? sortGoals(listed) : listed;
  const signedOut = goalsErrorStatus(query.error) === 401;
  const stale = !!data && (signedOut || failures >= STALE_AFTER_FAILURES);

  return (
    <section
      aria-label={goalId ? "Goal progress" : metrics ? "Metrics" : "Goals"}
      aria-busy={!data && query.isPending}
      className="space-y-6"
    >
      {!goalId && (
        <Strip
          goals={goals}
          metrics={metrics && data ? summarizeMetrics(data) : null}
          asOf={data?.asOf ?? null}
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
              <button type="button" onClick={() => query.refetch()} className="underline underline-offset-2">
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
        <ul
          className={`divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 ${stale ? "opacity-70" : ""}`}
        >
          {goals.map((goal) => (
            <GoalRow key={goal.id} goal={goal} data={data} metrics={metrics} single={!!goalId} />
          ))}
        </ul>
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
          : s
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

function Strip({
  goals,
  metrics,
  asOf,
  stale,
  signedOut,
  onRetry,
  onReload,
}: {
  readonly goals: readonly GoalProgress[];
  /** Metrics view only: the distinct-metric counts beside the KPI counts. */
  readonly metrics: MetricsSummary | null;
  readonly asOf: string | null;
  readonly stale: boolean;
  readonly signedOut: boolean;
  readonly onRetry: () => void;
  readonly onReload: () => void;
}) {
  const s = summarize(goals);
  const n = (status: keyof typeof STATUS_META) => s.byStatus[status] ?? 0;
  // Goals and KPIs are counted once each; every status count is a count of KPIs.
  const cells = [
    { label: "Goals", value: s.goals, tone: "" },
    { label: "KPIs", value: s.kpis, tone: "" },
    { label: STATUS_META.on_track.short, value: n("on_track"), tone: "text-success" },
    ...(n("met") ? [{ label: STATUS_META.met.short, value: n("met"), tone: "text-success" }] : []),
    { label: STATUS_META.behind.short, value: n("behind"), tone: "text-warning" },
    ...(n("missed") ? [{ label: STATUS_META.missed.short, value: n("missed"), tone: "text-destructive" }] : []),
    { label: STATUS_META.failing.short, value: n("failing"), tone: "text-destructive" },
  ];
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <dl className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60">
        {[
          ...cells,
          ...(metrics
            ? [
                { label: "Metrics", value: metrics.metrics, tone: "" },
                { label: "Serve no KPI", value: metrics.notServing, tone: "text-warning" },
              ]
            : []),
        ].map((c) => (
          <div key={c.label} className="flex min-w-20 flex-1 flex-col gap-1 bg-background px-3 py-3 sm:min-w-24 sm:flex-none sm:px-4">
            <dt className="text-[11px] text-muted-foreground uppercase tracking-widest">{c.label}</dt>
            <dd className={`font-semibold text-2xl tabular-nums leading-none ${c.value ? c.tone : ""}`}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs" {...(stale ? { role: "status" } : {})}>
        {signedOut ? (
          <ReloadLink onClick={onReload} />
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
  const expanded = choice ?? (single || measured);
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
      <h3 className="flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setChoice(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRight
            aria-hidden="true"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{goal.title}</span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {goal.kpis.length ? `${goal.kpis.length} ${goal.kpis.length === 1 ? "KPI" : "KPIs"}` : "No KPIs"}
          </span>
          {measured && worst && <StatusPill status={worst} />}
          {goal.evaluateAt && (
            <span className="hidden shrink-0 text-muted-foreground text-xs tabular-nums sm:inline">
              {formatDate(goal.evaluateAt, true)}
            </span>
          )}
        </button>
        {!single && (
          <Link
            href={hrefs.goal(goal.id)}
            aria-label={`Open ${goal.title}`}
            className="shrink-0 rounded-md px-3 py-3 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </Link>
        )}
      </h3>
      <div id={bodyId} hidden={!expanded} className="space-y-3 px-4 pt-1 pb-4">
        {goal.kpis.length ? (
          metrics ? (
            <div className="space-y-4">
              {ranked.map(({ kpi, index }) => {
                const key = keyOf(kpi, index);
                return (
                  <div key={key} data-kpi-block={kpi.binding.metricId} className="grid gap-3 md:grid-cols-[15rem_minmax(0,1fr)] md:items-start">
                    <KpiCard
                      kpi={kpi}
                      open={open === key}
                      chartId={chartId}
                      onToggle={() => setOpen(open === key ? null : key)}
                    />
                    {hasMetricDetail(data) ? (
                      <KpiBranch rows={servedRows(kpi, data)} nowIso={nowIso} />
                    ) : (
                      <p className="text-muted-foreground text-sm">Serving metrics unavailable</p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={CARD_GRID}>
              {ranked.map(({ kpi, index }) => {
                const key = keyOf(kpi, index);
                return (
                  <KpiCard
                    key={key}
                    kpi={kpi}
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
        {openKpi && open && <KpiChart key={open} id={chartId} kpi={openKpi} nowIso={nowIso} />}
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
          {data.servedUnavailable ? "Metrics unavailable right now" : "This node's metrics package is older than 0.10.0: no metric detail"}
        </p>
      )}
      {data.servedTruncated && (
        <p role="status" className="text-muted-foreground text-xs">
          This list is cut: more metrics exist than one read scans. Read the rest with core__metric_list.
        </p>
      )}
    </>
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
  // A breached target is a fresh reading, so it stays at full strength.
  const muted =
    a.value !== null &&
    (a.status === "delayed" ||
      (a.status === "failing" && a.reason !== "target_breached"));
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
