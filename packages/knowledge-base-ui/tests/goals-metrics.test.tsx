// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals-metrics.test`
 * Purpose: Parity proof for the Metrics view (story.0039): a fork that renders only `MetricsBoard` from the `./goals` entry gets goals and KPIs worst first, each KPI with the metrics that serve it grouped by role (status, band, latest value, age), and a flagged group for metrics that serve no KPI.
 * Scope: Package exports + fixture goal progress. No node app code, router or URL state.
 * Invariants: RED_FIRST, SERVER_GROUPS_BROWSER_DRAWS, NO_BAND_NO_VERDICT, NO_EXTRA_CONTROLS, UNKNOWN_IS_NOT_ZERO.
 * Side-effects: DOM rendering in jsdom
 * Links: story.0039, ../src/goals/metrics-view.ts, ../src/goals/metrics-parts.tsx
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  type GoalsProgress,
  GoalsProgressSchema,
  type KpiAssessment,
  type KpiStatus,
  type MetricLatest,
} from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoalsClient } from "../src/goals/client.js";
import {
  bandFraction,
  flagText,
  formatAge,
  type MetricRow,
  metricRank,
  metricStatus,
  notServingRows,
  sortGoals,
  sortMetricRows,
  summarizeMetrics,
} from "../src/goals/metrics-view.js";
import { GoalsBoard, GoalsProvider, MetricEvidence, MetricsBoard } from "../src/goals.js";
import { assessmentFixture, goalFixture, kpiFixture, trend } from "./_fixtures/goals-progress.js";

// Match the existing Goals chart harness: jsdom has no measured viewport.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      React.createElement("div", {}, React.cloneElement(children as ReactElement<Record<string, unknown>>, { width: 800, height: 192 })),
  };
});

afterEach(cleanup);

const AS_OF = "2026-11-02T10:05:00.000Z";

function band(status: KpiStatus, value: number, over: Partial<KpiAssessment> = {}): KpiAssessment {
  return {
    status,
    reason: status === "failing" ? "target_breached" : null,
    value,
    unit: "items",
    observationId: "00000000-0000-4000-8000-000000000009",
    observedAt: "2026-11-02T09:55:00.000Z",
    comparator: "gte",
    target: { value: 90, unit: "items" },
    deadline: null,
    pace: { observed: null, needed: null },
    ...over,
  };
}
const latest = (over: Partial<MetricLatest> = {}): MetricLatest => ({
  viewState: "ok",
  value: 7,
  unit: "items",
  observedAt: "2026-11-02T09:55:00.000Z",
  reason: null,
  ...over,
});
const served = (
  id: string,
  role: "input" | "guardrail" | "diagnostic",
  assessment: KpiAssessment | null,
  l: MetricLatest = latest(),
) => ({
  metric: { id, title: `Title ${id}`, calculatorId: "work.count@1", role },
  assessment,
  latest: l,
});

/** Goal B is healthy and listed first; goal A has a failing KPI and must sort above it. */
function fixture(extra: Partial<GoalsProgress> = {}): GoalsProgress {
  const healthy = kpiFixture("k-ok", "KPI ok", assessmentFixture("on_track"), null);
  const red = {
    ...kpiFixture("k-red", "KPI red", assessmentFixture("failing"), null),
    served: [
      served("m-diag", "diagnostic", null, latest({ viewState: "stale" })),
      served("m-input-ok", "input", band("on_track", 95)),
      served("m-guard-red", "guardrail", band("failing", 40)),
      served("m-input-red", "input", band("behind", 50)),
    ],
  };
  const okAlso = kpiFixture("k-ok2", "KPI ok 2", assessmentFixture("met"), null);
  return GoalsProgressSchema.parse({
    asOf: AS_OF,
    environment: "test",
    goals: [goalFixture("goal-b", "Goal B", [healthy, okAlso]), goalFixture("goal-a", "Goal A", [healthy, red])],
    orphans: [
      {
        metricId: "m-lost",
        kpi: "no-such",
        reason: "serves_unknown_kpi",
        assessment: null,
        latest: latest({ viewState: "error", value: null, reason: "source_failed" }),
      },
      {
        metricId: "m-guard-red",
        kpi: "k-red",
        reason: "band_invalid",
        issues: ["band:x"],
        assessment: null,
        latest: latest(),
      },
    ],
    unbound: [
      {
        metric: { id: "m-loose", title: "Loose count", calculatorId: "work.count@1" },
        assessment: null,
        latest: latest({ value: 3 }),
      },
      {
        metric: { id: "m-loose-red", title: "Loose red", calculatorId: "work.count@1" },
        assessment: band("failing", 2),
        latest: latest({ value: 2 }),
      },
    ],
    servedTruncated: false,
    ...extra,
  });
}

function renderMetrics(data: GoalsProgress) {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={c}>
      <MetricsBoard initialData={data} />
    </QueryClientProvider>,
  );
}

const ids = (els: Iterable<Element>, attr: string) => [...els].map((e) => e.getAttribute(attr));

describe("MetricsBoard", () => {
  it("does not show fabricated counts while the first read is pending", () => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = render(
      <QueryClientProvider client={c}>
        <MetricsBoard client={{ ...createGoalsClient(), fetchGoals: () => new Promise(() => {}) }} />
      </QueryClientProvider>,
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // The statline holds its place with placeholders, never zeros.
    const strip = container.querySelector('[data-strip="loading"]') as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.querySelectorAll("dd[data-loading]").length).toBeGreaterThanOrEqual(7);
    expect(strip.querySelectorAll("dd:not([data-loading])")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\b0\b/);
  });

  it("retains measurement visualization in a clear KPI row with inline history and supporting disclosure", () => {
    const { container } = renderMetrics(fixture());
    const goal = container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    const card = goal.querySelector('[data-kpi="k-red"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('[role="img"]')).not.toBeNull();
    expect(card.textContent).toContain("KPI red");
    expect(card.parentElement?.querySelector('[data-branch="served"]')).toBeNull();
    expect(goal.querySelector("figure")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "KPI red" }));
    expect(goal.querySelector('[data-branch="served"]')).not.toBeNull();
    expect(within(card.parentElement as HTMLElement).getByRole("figure")).toBeInTheDocument();
  });

  it.each(["volume","slo"] as const)("keeps the configured target explicit on a measured %s row",display=>{
    const unit=display === "slo"?"%":"items";
    const target=display === "slo"?99:90;
    const kpi=kpiFixture("targeted","Measured KPI",band("on_track",95,{unit,target:{value:target,unit}}),trend("targeted",unit,[40,60,95]));
    kpi.metric={...kpi.metric!,display};
    const {container}=renderMetrics(fixture({goals:[goalFixture("goal-target","Target goal",[kpi])]}));
    const row=container.querySelector('[data-kpi="targeted"]') as HTMLElement;
    expect(row.textContent).toContain(display === "slo"?"≥ 99%":"≥ 90 items");
    expect(row.querySelector('[role="img"]')).not.toBeNull();
  });

  it("reveals seven supporting metrics only after selecting the measured KPI", () => {
    const data=fixture();
    const kpi=data.goals.find(goal=>goal.id === "goal-a")!.kpis.find(kpi=>kpi.binding.metricId === "k-red")!;
    kpi.served=Array.from({length:7},(_,i)=>served(`seven-${i}`,"input",null));
    const {container}=renderMetrics(data);
    const block=container.querySelector('[data-kpi-block="k-red"]') as HTMLElement;
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(0);
    expect(block.querySelector('[role="img"]')).not.toBeNull();
    const toggle=within(block).getByRole("button",{name:"KPI red"});
    fireEvent.click(toggle);
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(7);
    expect(within(block).getByRole("figure")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(0);
  });

  it("keeps delayed first reads free of false-zero header statistics", async () => {
    let finish!: (data: GoalsProgress)=>void;
    const pending=new Promise<GoalsProgress>(resolve=>{finish=resolve;});
    const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
    const view=render(<QueryClientProvider client={client}><MetricsBoard client={{...createGoalsClient(),fetchGoals:()=>pending}} /></QueryClientProvider>);
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(view.container.querySelector('[data-strip="loading"]')).not.toBeNull();
    expect(view.container.textContent).not.toMatch(/\b0\b/);
    await act(async()=>{finish(fixture());await pending;});
    expect(await within(view.container).findByRole("button",{name:"KPI red"})).toBeInTheDocument();
    expect(view.container.querySelector('[data-strip="ready"]')).not.toBeNull();
    expect(view.container.querySelector("dd[data-loading]")).toBeNull();
    expect(view.container.textContent).not.toContain("0 KPIs");
    view.unmount();client.clear();
  });

  it("sorts goals, KPIs, role groups and metrics worst first", () => {
    const { container } = renderMetrics(fixture());
    // The failing goal is last in the data and first on the page.
    expect(ids(container.querySelectorAll("[data-goal]"), "data-goal")).toEqual(["goal-a", "goal-b"]);
    const goalA = container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    expect(ids(goalA.querySelectorAll("[data-kpi-block]"), "data-kpi-block")).toEqual(["k-red", "k-ok"]);
    fireEvent.click(within(goalA).getByRole("button", { name: /KPI red/ }));
    const branch = goalA.querySelector('[data-branch="served"]') as HTMLElement;
    // Roles in fixed order; inside a role, worst status first. A role is metadata on a metric, never a heading.
    expect(ids(branch.querySelectorAll("[data-role]"), "data-role")).toEqual(["input", "input", "guardrail", "diagnostic"]);
    expect(branch.querySelectorAll("h4")).toHaveLength(1);
    expect(ids(branch.querySelectorAll("[data-metric]"), "data-metric")).toEqual([
      "m-input-red",
      "m-input-ok",
      "m-guard-red",
      "m-diag",
    ]);
  });

  it("shows status, band, latest value and age on every serving metric, and No band without a verdict", () => {
    const { container } = renderMetrics(fixture());
    fireEvent.click(
      within(container.querySelector('[data-goal="goal-a"]') as HTMLElement).getByRole("button", { name: /KPI red/ }),
    );
    const row = (id: string) => container.querySelector(`[data-metric="${id}"]`) as HTMLElement;
    const red = row("m-guard-red");
    expect(red.getAttribute("data-status")).toBe("failing");
    expect(red.textContent).toContain("Failing");
    expect(red.textContent).toContain("40");
    expect(red.textContent).toContain("≥ 90 items");
    expect(red.textContent).toContain("10m ago");
    expect(red.querySelector('[role="img"]')).not.toBeNull();
    // A bandless, stale metric is delayed, not judged; its own words say so.
    const diag = row("m-diag");
    expect(diag.getAttribute("data-status")).toBe("delayed");
    expect(diag.textContent).not.toContain("≥");
    // The band_invalid orphan of a served metric is a chip on its row, not a member of the not-serving group.
    expect(red.querySelector('[data-flag="band_invalid"]')).not.toBeNull();
  });

  it("preserves primary KPI attempt state and labels the last-good measurement historical", () => {
    const data=fixture();
    const kpi=data.goals.find(goal=>goal.id === "goal-a")!.kpis.find(kpi=>kpi.binding.metricId === "k-red")!;
    kpi.viewState="pending";
    kpi.assessment=band("building",95);
    const {container}=renderMetrics(GoalsProgressSchema.parse(data));
    const row=container.querySelector('[data-kpi="k-red"]') as HTMLElement;
    expect(row.querySelector('[data-status="building"]')).not.toBeNull();
    expect(row.querySelector('[data-status="on_track"]')).toBeNull();
    expect(row.textContent).toContain("historical reading");
    expect(row.textContent).toContain("95");
    const goal=container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    expect(goal.querySelector('h3 [data-status="on_track"]')).toBeNull();
    expect(goal.querySelector('h3 [data-status="building"]')).not.toBeNull();
    fireEvent.click(within(row).getByRole("button"));
    const figure=within(row.parentElement as HTMLElement).getByRole("figure");
    expect(figure.textContent).toContain("Pending · historical reading");
    expect(figure.textContent).not.toContain("Latest");
  });

  it.each(["met","missed","unresolved","evaluating"] as const)("preserves %s during a pending refresh across row, chart and goal summary",status=>{
    const data=fixture();
    const goal=data.goals.find(goal=>goal.id === "goal-a")!;
    const kpi=goal.kpis.find(kpi=>kpi.binding.metricId === "k-red")!;
    goal.kpis=[kpi];
    kpi.viewState="pending";
    kpi.assessment=band(status,95,{deadline:"2026-11-01T10:00:00.000Z",...(status === "unresolved" ? {value:null,observedAt:null} : {})});
    const {container}=renderMetrics(GoalsProgressSchema.parse(data));
    const row=container.querySelector('[data-kpi="k-red"]') as HTMLElement;
    expect(row.querySelector(`[data-status="${status}"]`)).not.toBeNull();
    expect(row.querySelector('[data-status="building"]')).toBeNull();
    const header=container.querySelector('[data-goal="goal-a"] h3') as HTMLElement;
    expect(header.querySelector(`[data-status="${status}"]`)).not.toBeNull();
    expect(row.textContent).toContain("Pending refresh");
    fireEvent.click(within(row).getByRole("button"));
    const figure=within(row.parentElement as HTMLElement).getByRole("figure");
    expect(figure.textContent).toContain("Pending refresh");
    if(status === "met" || status === "missed") expect(figure.textContent).toContain("Final");
    if(status === "evaluating") expect(figure.textContent).toContain("At deadline");
    expect(figure.textContent).not.toContain("Latest");
  });

  it("shows pending attempts instead of a healthy historical band verdict", () => {
    const data = fixture();
    const target = data.goals.find(goal => goal.id === "goal-a")!.kpis.find(kpi => kpi.binding.metricId === "k-red")!.served![0]!;
    target.latest = latest({viewState:"pending"});
    target.assessment = band("building",95);
    const {container}=renderMetrics(data);
    const goal=container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    fireEvent.click(within(goal).getByRole("button",{name:"KPI red"}));
    const row=goal.querySelector(`[data-metric="${target.metric.id}"]`) as HTMLElement;
    expect(row).toHaveAttribute("data-status","building");
    expect(row.textContent).toContain("Pending, historical reading");
    expect(row.querySelector('[data-status="on_track"]')).toBeNull();
  });

  it("lists metrics that serve no KPI in a flagged group, worst first, and links why", () => {
    const { container } = renderMetrics(fixture());
    const group = container.querySelector('[data-group="not-serving"]') as HTMLElement;
    expect(ids(group.querySelectorAll("[data-metric]"), "data-metric")).toEqual(["m-loose-red", "m-lost", "m-loose"]);
    expect(group.querySelector('[data-metric="m-lost"] [data-flag="serves_unknown_kpi"]')?.textContent).toContain(
      "no-such",
    );
    expect(group.querySelector('[data-metric="m-loose"] [data-flag="unbound"]')?.textContent).toContain(
      "Serves no goal KPI",
    );
    // Unknown is not zero: a failed metric with no good value reads "—".
    expect(group.querySelector('[data-metric="m-lost"]')?.textContent).toContain("—");
    expect(within(group).getByRole("link", { name: "why" }).getAttribute("href")).toBe(
      "/knowledge/goal-metrics-vs-telemetry",
    );
    // Rows wrap and never truncate their titles.
    expect(group.innerHTML).not.toContain("truncate");
  });

  it("counts the distinct metrics once and has no filter or sort control", () => {
    const data = fixture();
    // KPI metrics k-ok k-ok2 k-red (3), served m-diag m-input-ok m-guard-red m-input-red (4), not serving m-lost m-loose m-loose-red (3).
    expect(summarizeMetrics(data)).toEqual({ metrics: 10, notServing: 3 });
    const { container } = renderMetrics(data);
    expect(container.querySelectorAll("input, select, textarea, [role=combobox], [role=searchbox]")).toHaveLength(0);
  });

  it("says so when a KPI has no serving metric, when the scan is cut and when detail is unavailable", () => {
    const bare = kpiFixture("k-bare", "KPI bare", assessmentFixture("on_track"), null);
    const cut = GoalsProgressSchema.parse({
      asOf: AS_OF,
      environment: "t",
      goals: [goalFixture("g", "G", [bare])],
      orphans: [],
      unbound: [],
      servedTruncated: true,
    });
    const a = renderMetrics(cut);
    fireEvent.click(within(a.container).getByRole("button", { name: /KPI bare/ }));
    expect(a.container.querySelector('[data-branch="empty"]')?.textContent).toContain("No serving metrics found in the scanned set");
    expect(a.container.textContent).toContain("This list is cut");
    expect(a.container.querySelector('[data-group="not-serving"]')).toBeNull();
    a.unmount();
    const down = GoalsProgressSchema.parse({
      asOf: AS_OF,
      environment: "t",
      goals: [goalFixture("g", "G", [bare])],
      servedUnavailable: "metric_authority_unavailable",
    });
    const b = renderMetrics(down);
    expect(b.container.textContent).toContain("Metrics unavailable right now");
    expect(b.container.querySelector("[data-branch]")).toBeNull();
  });

  it("never clips or overflows: titles and flag chips wrap, and an unmeasured goal opens", () => {
    const longId = "a-very-long-kpi-identifier-that-would-overflow-a-360px-row-if-it-never-wrapped";
    const unmeasured = kpiFixture(
      "k-un",
      "KPI with a long title that must wrap on a narrow screen",
      assessmentFixture("not_measured", { value: null }),
      null,
    );
    const data = GoalsProgressSchema.parse({
      asOf: AS_OF,
      environment: "t",
      goals: [goalFixture("goal-un", "Goal with a long title that must wrap on a narrow screen", [unmeasured])],
      orphans: [{ metricId: "m-long", kpi: longId, reason: "serves_unknown_kpi", assessment: null, latest: latest() }],
      unbound: [],
    });
    const { container } = renderMetrics(data);
    const chip = container.querySelector('[data-flag="serves_unknown_kpi"]') as HTMLElement;
    expect(chip.textContent).toContain(longId);
    expect(chip.className).toContain("break-words");
    expect(chip.className).toContain("max-w-full");
    expect(chip.className).not.toContain("whitespace-nowrap");
    const goal = container.querySelector('[data-goal="goal-un"]') as HTMLElement;
    expect(goal.innerHTML).not.toContain("truncate");
    expect(goal.innerHTML).not.toContain("line-clamp");
    // A goal with nothing measured still shows its KPIs and their metrics.
    expect(within(goal).getAllByRole("button")[0]?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(goal).getByRole("button", { name: /KPI with a long title/ }));
    expect(goal.querySelector('[data-branch="empty"]')).not.toBeNull();
  });

  it("discloses supporting metrics only while the KPI is expanded; a metric opens like a KPI and links to its page", () => {
    const {container}=renderMetrics(fixture());
    const goal=container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    const toggle=within(goal).getByRole("button",{name:"KPI red"});
    expect(toggle).toHaveAttribute("aria-expanded","false");
    expect(goal.querySelector('[data-metric="m-guard-red"]')).toBeNull();
    fireEvent.click(toggle);
    const row=goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement;
    expect(row).toHaveTextContent("Failing");
    expect(row).toHaveTextContent("40");
    // Clicking the metric opens the same chart a KPI opens, with the same range control and a link to its page.
    const block=row.closest("[data-metric-block]") as HTMLElement;
    expect(block.querySelector("figure")).toBeNull();
    fireEvent.click(within(row).getByRole("button",{name:"Title m-guard-red"}));
    const figure=within(block).getByRole("figure");
    expect(figure).toHaveAttribute("data-chart","metric");
    expect(within(figure).getByRole("group",{name:"Chart range"})).toBeInTheDocument();
    for(const label of ["1D","1W","1M","3M"]) expect(within(figure).getByRole("radio",{name:label})).toBeInTheDocument();
    expect(within(figure).getByRole("link",{name:"Open Title m-guard-red"})).toHaveAttribute("href","/knowledge/m-guard-red");
    fireEvent.click(toggle);
    expect(goal.querySelector('[data-metric="m-guard-red"]')).toBeNull();
  });

  it("shows the metric's brief when it opens, never on the card face, and says so when it has none (task.0125)", () => {
    const brief = {
      summary: "Counts open work items each hour from the node's work-item table.",
      justification: "Shows whether open scope grows faster than the node closes it.",
    };
    const data = fixture();
    const goalA = data.goals[1]!;
    const red = goalA.kpis[1]!;
    const withBrief = GoalsProgressSchema.parse({
      ...data,
      goals: [
        data.goals[0],
        {
          ...goalA,
          kpis: [
            goalA.kpis[0],
            {
              ...red,
              served: red.served!.map((s) =>
                s.metric.id === "m-guard-red" ? { ...s, metric: { ...s.metric, brief } } : s,
              ),
            },
          ],
        },
      ],
    });
    const { container } = renderMetrics(withBrief);
    const goal = container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    fireEvent.click(within(goal).getByRole("button", { name: "KPI red" }));
    const row = goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement;
    expect(row).not.toHaveTextContent(brief.summary);
    fireEvent.click(within(row).getByRole("button", { name: "Title m-guard-red" }));
    const figure = within(row.closest("[data-metric-block]") as HTMLElement).getByRole("figure");
    const shown = figure.querySelector("[data-brief]") as HTMLElement;
    expect(within(shown).getByText("What")).toBeInTheDocument();
    expect(within(shown).getByText(brief.summary)).toBeInTheDocument();
    expect(within(shown).getByText("Why")).toBeInTheDocument();
    expect(within(shown).getByText(brief.justification)).toBeInTheDocument();
    // A metric without a brief says so when opened.
    const other = goal.querySelector('[data-metric="m-input-ok"]') as HTMLElement;
    fireEvent.click(within(other).getByRole("button", { name: "Title m-input-ok" }));
    const otherFigure = within(other.closest("[data-metric-block]") as HTMLElement).getByRole("figure");
    expect(otherFigure.querySelector('[data-brief="missing"]')).toHaveTextContent("No brief yet");
  });

  it("draws a supporting metric with the same card component as a KPI and calls the section Metrics", () => {
    const {container}=renderMetrics(fixture());
    const goal=container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    fireEvent.click(within(goal).getByRole("button",{name:"KPI red"}));
    const kpiCard=goal.querySelector('[data-kpi="k-red"]') as HTMLElement;
    const metricCard=goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement;
    // One component: both carry the same parts (toggle, status pill, mark, big value); only the level differs.
    expect(kpiCard.getAttribute("data-card")).toBe("kpi");
    expect(metricCard.getAttribute("data-card")).toBe("metric");
    const parts=(el:HTMLElement)=>["button[aria-expanded]","span[data-status]","[role=img]","span.tabular-nums"].map(q=>el.querySelector(q)!==null);
    expect(parts(kpiCard)).toEqual([true,true,true,true]);
    expect(parts(metricCard)).toEqual(parts(kpiCard));
    expect(kpiCard.className).toContain("rounded-md border");
    expect(metricCard.className).toContain("rounded-md border");
    const section=goal.querySelector('[data-branch="served"]') as HTMLElement;
    expect(section.querySelector("h4")).toHaveTextContent(/^Metrics$/);
    // The KPI rows are labelled too: a "KPIs" heading over the list and a KPI tag on each row.
    expect(kpiCard.parentElement?.parentElement?.querySelector("h4")).toHaveTextContent(/^KPIs$/);
    expect(kpiCard.textContent).toContain("KPI");
    // Metrics are metrics: no "Diagnostics" (or any diagnostic label) anywhere in the rendered view.
    expect(container.textContent).not.toMatch(/diagnostic/i);
  });

  it("shows a neutral state, not 'No band', for a metric with no target", () => {
    const data=fixture();
    const kpi=data.goals.find(g=>g.id==="goal-a")!.kpis.find(k=>k.binding.metricId==="k-red")!;
    kpi.served=[served("plain","input",null)];
    const {container}=renderMetrics(data);
    const goal=container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    fireEvent.click(within(goal).getByRole("button",{name:"KPI red"}));
    const row=goal.querySelector('[data-metric="plain"]') as HTMLElement;
    expect(row.getAttribute("data-status")).toBe("no_band");
    expect(row.textContent).toContain("No target");
    expect(row.textContent).not.toContain("No band");
    // No status pill is drawn for an unjudged, healthy metric: it is not broken.
    expect(row.querySelector("span[data-status]")).toBeNull();
    expect(row.textContent).toContain("7");
    expect(container.textContent).not.toContain("No band");
  });

  it("restores the statline at the top of Metrics with counts once the read arrives", () => {
    const {container}=renderMetrics(fixture());
    const strip=container.querySelector('[data-strip="ready"]') as HTMLElement;
    const cells=Object.fromEntries([...strip.querySelectorAll("dl > div")].map(c=>[c.querySelector("dt")!.textContent,c.querySelector("dd")!.textContent]));
    // Two goals bind four KPIs (k-ok, k-ok2 on track or met; k-ok again in goal-a; k-red failing).
    expect(cells.Goals).toBe("2");
    expect(cells.KPIs).toBe("4");
    expect(cells.Failing).toBe("1");
    expect(cells.Metrics).toBe("10");
    expect(cells["Serve no KPI"]).toBe("3");
    expect(strip.compareDocumentPosition(container.querySelector("[data-goal]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A "Goals" heading sits between the statline and the first goal row.
    const heading = within(container).getByRole("heading", { level: 2, name: "Goals" });
    expect(strip.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(container.querySelector("[data-goal]") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads a supporting metric's series through the history endpoint only once its card is near the viewport", async () => {
    const fetchHistory = vi.fn(async (id: string) => trend(id, "items", [3, 4, 5, 6, 7, 8]));
    const client = { ...createGoalsClient(), fetchHistory };
    const mount = () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const view = render(<QueryClientProvider client={qc}><MetricsBoard client={client} initialData={fixture()} /></QueryClientProvider>);
      const goal = view.container.querySelector('[data-goal="goal-a"]') as HTMLElement;
      fireEvent.click(within(goal).getByRole("button", { name: "KPI red" }));
      return { view, goal, qc };
    };
    // No visibility signal (jsdom, SSR): opening the KPI does not fire a read per supporting metric.
    const first = mount();
    expect(first.goal.querySelector('[data-metric="m-guard-red"]')).not.toBeNull();
    expect(fetchHistory.mock.calls.filter(([id]) => id === "m-guard-red")).toHaveLength(0);
    first.view.unmount();
    // Near the viewport: the same card reads the same history window the open chart reads.
    class Visible {
      constructor(private readonly cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Visible);
    try {
      const second = mount();
      await waitFor(() => expect(fetchHistory.mock.calls.some(([id]) => id === "m-guard-red")).toBe(true));
      const [, window] = fetchHistory.mock.calls.find(([id]) => id === "m-guard-red") as unknown as [string, { step: string }];
      // One read per card: the 1D window (hourly), the series the 1D chart starts on.
      expect(window.step).toBe("1h");
      expect(fetchHistory.mock.calls.filter(([id]) => id === "m-guard-red")).toHaveLength(1);
      second.qc.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws the supporting metric's trace from its one 1D read, or a neutral dashed placeholder when there is nothing to draw", async () => {
    class Visible {
      constructor(private readonly cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Visible);
    try {
      const mount = async (values: (number | null)[]) => {
        const fetchHistory = vi.fn(async (id: string) => trend(id, "items", values));
        const client = { ...createGoalsClient(), fetchHistory };
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        const view = render(<QueryClientProvider client={qc}><MetricsBoard client={client} initialData={fixture()} /></QueryClientProvider>);
        const goal = view.container.querySelector('[data-goal="goal-a"]') as HTMLElement;
        fireEvent.click(within(goal).getByRole("button", { name: "KPI red" }));
        const card = goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement;
        await waitFor(() => expect(fetchHistory.mock.calls.some(([id]) => id === "m-guard-red")).toBe(true));
        return { view, card, qc };
      };
      // Readings: a line is drawn inside the card's mark.
      const full = await mount([3, 4, 5, 6, 7, 8]);
      await waitFor(() => expect(full.card.querySelector('[role="img"] .recharts-area-curve')).not.toBeNull());
      expect(full.card.querySelector('[data-spark="empty"]')).toBeNull();
      full.view.unmount();
      full.qc.clear();
      // No readings in the window: a dashed placeholder with a title, not a blank slot.
      const none = await mount(Array.from({ length: 30 }, () => null));
      await waitFor(() => expect(none.card.querySelector('[data-spark="empty"]')).not.toBeNull());
      expect(none.card.querySelector('[data-spark="empty"]')).toHaveAttribute("title", expect.stringMatching(/readings/));
      expect(none.card.querySelector('[role="img"] .recharts-area-curve')).toBeNull();
      none.qc.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a neutral loading mark, not the dashed placeholder, until the supporting metric's read resolves (and chart area never blank)", async () => {
    const open = (client: ReturnType<typeof createGoalsClient>) => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const view = render(<QueryClientProvider client={qc}><MetricsBoard client={client} initialData={fixture()} /></QueryClientProvider>);
      const goal = view.container.querySelector('[data-goal="goal-a"]') as HTMLElement;
      fireEvent.click(within(goal).getByRole("button", { name: "KPI red" }));
      return { view, goal, qc, card: goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement };
    };
    // Never near the viewport (no IntersectionObserver): the read has not fired, so the mark is loading, not "no readings".
    const idle = open({ ...createGoalsClient(), fetchHistory: vi.fn(async (id: string) => trend(id, "items", [3, 4, 5])) });
    expect(idle.card.querySelector('[data-spark="loading"]')).not.toBeNull();
    expect(idle.card.querySelector('[data-spark="empty"]')).toBeNull();
    idle.view.unmount();
    idle.qc.clear();
    class Visible {
      constructor(private readonly cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Visible);
    try {
      // Read in flight: skeleton, and the open chart shows its own loading state rather than a blank area.
      let release: (v: ReturnType<typeof trend>) => void = () => {};
      const pending = new Promise<ReturnType<typeof trend>>((resolve) => { release = resolve; });
      const loading = open({ ...createGoalsClient(), fetchHistory: vi.fn(() => pending) });
      await waitFor(() => expect(loading.card.querySelector('[data-spark="loading"]')).not.toBeNull());
      expect(loading.card.querySelector('[data-spark="empty"]')).toBeNull();
      await waitFor(() => expect(loading.goal.querySelector('[data-chart="loading"]')).not.toBeNull());
      // Resolved with nothing to draw: now, and only now, the dashed placeholder.
      release(trend("m-guard-red", "items", Array.from({ length: 30 }, () => null)));
      await waitFor(() => expect(loading.card.querySelector('[data-spark="empty"]')).not.toBeNull());
      expect(loading.card.querySelector('[data-spark="loading"]')).toBeNull();
      loading.view.unmount();
      loading.qc.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says Unavailable, not the dashed no-readings mark, when a supporting metric's history read fails", async () => {
    class Visible {
      constructor(private readonly cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe() { this.cb([{ isIntersecting: true }]); }
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Visible);
    try {
      const fetchHistory = vi.fn(async () => { throw new Error("history down"); });
      const client = { ...createGoalsClient(), fetchHistory };
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
      const view = render(<QueryClientProvider client={qc}><MetricsBoard client={client} initialData={fixture()} /></QueryClientProvider>);
      const goal = view.container.querySelector('[data-goal="goal-a"]') as HTMLElement;
      fireEvent.click(within(goal).getByRole("button", { name: "KPI red" }));
      const card = goal.querySelector('[data-metric="m-guard-red"]') as HTMLElement;
      await waitFor(() => expect(card.querySelector('[data-spark="unavailable"]')).not.toBeNull(), { timeout: 4000 });
      expect(card.querySelector('[data-spark="unavailable"]')).toHaveAttribute("title", "Unavailable");
      expect(card.querySelector('[data-spark="empty"]')).toBeNull();
      expect(card.querySelector('[data-spark="loading"]')).toBeNull();
      view.unmount();
      qc.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pages the not-serving group at 20 like a KPI's metrics", () => {
    const unbound = Array.from({ length: 45 }, (_, i) => ({
      metric: { id: `loose-${String(i).padStart(2, "0")}`, title: `Loose ${String(i).padStart(2, "0")}`, calculatorId: "work.count@1" },
      assessment: null,
      latest: latest(),
    }));
    const { container } = renderMetrics(fixture({ orphans: [], unbound }));
    const group = container.querySelector('[data-group="not-serving"]') as HTMLElement;
    expect(group.querySelectorAll("[data-metric]")).toHaveLength(20);
    expect(within(group).getByText("1–20 of 45 loaded")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Next" }));
    expect(within(group).getByText("21–40 of 45 loaded")).toBeInTheDocument();
  });

  it("pages the bounded supporting set in inline pages of20", () => {
    const data=fixture();
    const kpi=data.goals.find(goal=>goal.id === "goal-a")!.kpis.find(kpi=>kpi.binding.metricId === "k-red")!;
    kpi.served=Array.from({length:45},(_,i)=>served(`page-${String(i).padStart(2,"0")}`,"input",null));
    const {container}=renderMetrics(data);
    const block=container.querySelector('[data-kpi-block="k-red"]') as HTMLElement;
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(0);
    fireEvent.click(within(block).getByRole("button",{name:"KPI red"}));
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(20);
    expect(within(block).getByText("1–20 of 45 loaded")).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button",{name:"Next"}));
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(20);
    expect(within(block).getByText("21–40 of 45 loaded")).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button",{name:"Next"}));
    expect(block.querySelectorAll('[data-metric]')).toHaveLength(5);
    expect(within(block).getByRole("button",{name:"Next"})).toBeDisabled();
    fireEvent.click(within(block).getByRole("button",{name:"Previous"}));
    expect(within(block).getByText("21–40 of 45 loaded")).toBeInTheDocument();
  });

  it("shows an unbound invalid band with both warnings", () => {
    const data = fixture({
      orphans: [
        { metricId: "bad", title: "Bad band", kpi: null, reason: "band_invalid", assessment: null, latest: latest() },
      ],
      unbound: [
        { metric: { id: "bad", title: "Bad band", calculatorId: "work.count@1" }, assessment: null, latest: latest() },
      ],
    });
    const { container } = renderMetrics(data);
    const row = container.querySelector('[data-metric="bad"]') as HTMLElement;
    expect(row.querySelector('[data-flag="unbound"]')).not.toBeNull();
    expect(row.querySelector('[data-flag="band_invalid"]')).not.toBeNull();
  });

  it("leaves the Goals view as it was: server order, no metric branches", () => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = render(
      <QueryClientProvider client={c}>
        <GoalsBoard initialData={fixture()} />
      </QueryClientProvider>,
    );
    expect(ids(container.querySelectorAll("[data-goal]"), "data-goal")).toEqual(["goal-b", "goal-a"]);
    expect(container.querySelector("[data-branch], [data-group]")).toBeNull();
  });
});

describe("metrics-view", () => {
  const row = (over: Partial<MetricRow>): MetricRow => ({
    id: "m",
    title: "m",
    calculatorId: "c",
    role: "input",
    assessment: null,
    latest: latest(),
    flags: [],
    ...over,
  });

  it("ranks red first, unjudged after every problem and before healthy", () => {
    const rows = sortMetricRows([
      row({ id: "ok", assessment: band("on_track", 95) }),
      row({ id: "nb", latest: latest() }),
      row({ id: "stale", latest: latest({ viewState: "stale" }) }),
      row({ id: "err", latest: latest({ viewState: "error", value: null }) }),
      row({ id: "behind", assessment: band("behind", 50) }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["err", "behind", "stale", "nb", "ok"]);
    expect(metricStatus(row({ latest: latest({ viewState: "unavailable", value: null }) }))).toBe("failing");
    expect(metricStatus(row({ latest: null }))).toBe("no_band");
    expect(metricRank(row({ assessment: band("failing", 1) }))).toBeLessThan(
      metricRank(row({ assessment: band("on_track", 99) })),
    );
  });

  it("sorts goals by their worst KPI, with a goal with no KPIs last and ties in server order", () => {
    const g = (id: string, s: KpiStatus[]) =>
      goalFixture(
        id,
        id,
        s.map((x, i) => kpiFixture(`${id}${i}`, "t", assessmentFixture(x), null)),
      );
    expect(
      sortGoals([g("none", []), g("ok1", ["on_track"]), g("red", ["on_track", "failing"]), g("ok2", ["on_track"])]).map(
        (x) => x.id,
      ),
    ).toEqual(["red", "ok1", "ok2", "none"]);
  });

  it("does not list a band_invalid orphan as not serving, and merges duplicate orphan rows", () => {
    const data = fixture({
      orphans: [
        { metricId: "x", kpi: null, reason: "serves_invalid", issues: ["a"], assessment: null, latest: latest() },
        { metricId: "x", kpi: null, reason: "band_invalid", issues: ["b"], assessment: null, latest: latest() },
      ],
      unbound: [],
    });
    const rows = notServingRows(data);
    expect(rows.map((r) => r.id)).toEqual(["x"]);
    expect(rows[0]?.flags.map((f) => f.kind)).toEqual(["serves_invalid", "band_invalid"]);
  });

  it("lists a metric that serves only a bet's KPI as not serving a goal KPI", () => {
    const data = fixture({
      orphans: [
        {
          metricId: "bet-m",
          title: "Bet metric",
          kpi: "bet-kpi",
          reason: "serves_bet_kpi",
          assessment: null,
          latest: latest(),
        },
      ],
      unbound: [],
    });
    const [r] = notServingRows(data);
    expect(r?.title).toBe("Bet metric");
    expect(r?.flags.map((f) => flagText(f))).toEqual(["Serves a bet's KPI only: bet-kpi"]);
  });

  it("reads age from the read's own clock and fills a meter toward the band", () => {
    expect(formatAge("2026-11-02T10:04:30.000Z", AS_OF)).toBe("just now");
    expect(formatAge("2026-11-02T09:05:00.000Z", AS_OF)).toBe("1h ago");
    expect(formatAge("2026-10-30T10:05:00.000Z", AS_OF)).toBe("3d ago");
    expect(bandFraction(row({ assessment: band("behind", 45) }))).toBe(0.5);
    expect(bandFraction(row({ assessment: band("on_track", 95) }))).toBe(1);
    expect(bandFraction(row({ assessment: null }))).toBeNull();
    expect(
      bandFraction(row({ assessment: band("failing", 0, { value: null }), latest: latest({ value: null }) })),
    ).toBeNull();
  });
});


describe("independent immutable measurement evidence", () => {
  it.each([
    { currentFails: true, pinnedFails: false },
    { currentFails: false, pinnedFails: true },
    { currentFails: false, pinnedFails: false },
  ])("isolates rolling and pinned reads: %j", async ({ currentFails, pinnedFails }) => {
    const pinned = {
      id: "pinned-proof", value: 17, unit: "items", status: "ok", window: { end: AS_OF },
      definitionHash: "saved-definition", calculatorVersion: "work.count@1", reason: null, evidenceRefs: [],
    };
    const rolling = { ...pinned, id: "rolling-proof", value: 99 };
    const fetchMetric = vi.fn(async () => {
      if (currentFails) throw new Error("current failed");
      return { history: [rolling] };
    });
    const fetchObservation = vi.fn(async () => {
      if (pinnedFails) throw Object.assign(new Error("denied"), { status: 403 });
      return { observation: pinned };
    });
    const client = { ...createGoalsClient(), fetchMetric, fetchObservation } as unknown as ReturnType<typeof createGoalsClient>;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={qc}><GoalsProvider client={client}>
      <MetricEvidence id="metric-proof" observationId="pinned-proof" />
    </GoalsProvider></QueryClientProvider>);
    await waitFor(() => expect(view.queryByText("Loading evidence…")).not.toBeInTheDocument());
    expect(fetchObservation).toHaveBeenCalledWith("metric-proof", "pinned-proof", expect.any(AbortSignal));
    expect(fetchMetric).toHaveBeenCalledTimes(1);
    if (pinnedFails) {
      expect(view.getByRole("alert")).toHaveTextContent("Linked measurement evidence is unavailable");
      expect(view.container.querySelector("article")).toBeNull();
    } else {
      expect(view.getByText("Observation pinned-proof")).toBeInTheDocument();
      expect(view.container.querySelector("article")).toHaveTextContent("17 items");
      expect(view.queryByText("Observation rolling-proof")).not.toBeInTheDocument();
    }
    if (currentFails) expect(view.getByRole("alert")).toHaveTextContent("Current measurement evidence is unavailable");
    if (!currentFails && !pinnedFails) expect(view.queryByRole("alert")).not.toBeInTheDocument();
    qc.clear();
  });
});

describe("a metric's own page", () => {
  const reading = {
    id: "00000000-0000-4000-8000-0000000000aa", metricId: "m-page", definitionRevision: "1", definitionHash: "hash-raw",
    calculatorVersion: "work.count@1", paramsHash: "p", node: "n", environment: "test", dataScope: "test",
    window: { start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z" }, sourceWatermarks: [],
    observedAt: "2026-11-02T10:00:00.000Z", status: "ok", value: 8, unit: "items", reason: null, evidenceRefs: [],
  };

  it("leads with the KPI chart (value, unit, range toggle) and keeps raw evidence behind a collapsed Evidence disclosure", async () => {
    const fetchMetric = vi.fn(async () => ({
      definition: { id: "m-page", title: "Page metric", revision: "1", spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 600 } },
      latestAttempt: reading,
      lastGood: reading,
      viewState: "ok",
      history: [reading],
    }));
    const fetchHistory = vi.fn(async () => trend("m-page", "items", [3, 4, 5, 6, 7, 8]));
    const client = { ...createGoalsClient(), fetchGoals: async () => fixture(), fetchMetric, fetchHistory } as unknown as ReturnType<typeof createGoalsClient>;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={qc}><GoalsProvider client={client}>
      <MetricEvidence id="m-page" />
    </GoalsProvider></QueryClientProvider>);
    const figure = await view.findByRole("figure");
    // The same chart a KPI opens: title, big value with unit, and the 1D/1W/1M/3M range toggle.
    expect(figure).toHaveAttribute("data-chart", "metric");
    expect(figure).toHaveTextContent("Page metric");
    expect(figure).toHaveTextContent("8");
    expect(figure).toHaveTextContent("items");
    for (const label of ["1D", "1W", "1M", "3M"]) expect(within(figure).getByRole("radio", { name: label })).toBeInTheDocument();
    await waitFor(() => expect(fetchHistory).toHaveBeenCalled());
    // Raw ids, hashes and exact times sit behind a collapsed Evidence disclosure that comes after the chart.
    const evidence = view.container.querySelector("details[data-evidence]") as HTMLElement;
    expect(evidence).not.toBeNull();
    expect(evidence.hasAttribute("open")).toBe(false);
    expect(within(evidence).getByText("Evidence")).toBeInTheDocument();
    expect(figure.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(figure.textContent).not.toContain("hash-raw");
    expect(figure.textContent).not.toContain(reading.id);
    expect(evidence.textContent).toContain(`Observation ${reading.id}`);
    expect(evidence.textContent).toContain("hash-raw");
    qc.clear();
  });

  it("gives a KPI's metric and a supporting metric the same header; only the label and links differ", async () => {
    const readFor = (id: string, serves: { kpi: string; role: "input" } | undefined, bandAssessment?: KpiAssessment) => ({
      definition: { id, title: `Title ${id}`, revision: "1", spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 600 }, ...(serves ? { serves } : {}) },
      latestAttempt: reading,
      lastGood: reading,
      viewState: "ok",
      ...(bandAssessment ? { bandAssessment } : {}),
      history: [reading],
    });
    const mount = async (id: string, serves?: { kpi: string; role: "input" }, assessment?: KpiAssessment) => {
      const client = {
        ...createGoalsClient(),
        fetchGoals: async () => fixture(),
        fetchMetric: async () => readFor(id, serves, assessment),
        fetchHistory: async () => trend(id, "items", [3, 4, 5, 6, 7, 8]),
      } as unknown as ReturnType<typeof createGoalsClient>;
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(<QueryClientProvider client={qc}><GoalsProvider client={client}><MetricEvidence id={id} /></GoalsProvider></QueryClientProvider>);
      const figure = await view.findByRole("figure");
      return { view, figure, qc };
    };
    const kpi = await mount("k-red");
    const kpiLabel = await kpi.view.findByText(/KPI of goal/);
    expect(kpiLabel).toHaveAttribute("data-relation", "kpi");
    expect(within(kpiLabel).getByRole("link", { name: "Goal A" })).toHaveAttribute("href", "/knowledge/goal-a");
    const sameParts = (el: HTMLElement) => ["span[data-status]", "[role=group]", "figcaption"].map((q) => el.querySelector(q) !== null);
    expect(sameParts(kpi.figure)).toEqual([true, true, true]);
    kpi.view.unmount();
    kpi.qc.clear();

    const metric = await mount("m-guard-red", { kpi: "k-red", role: "input" }, band("failing", 40));
    const label = await metric.view.findByText(/Metric serving KPI/);
    expect(label).toHaveAttribute("data-relation", "serves");
    expect(within(label).getByRole("link", { name: "KPI red" })).toHaveAttribute("href", "/knowledge/k-red");
    expect(sameParts(metric.figure)).toEqual(sameParts(kpi.figure));
    expect(metric.view.container.textContent).not.toMatch(/diagnostic/i);
    metric.qc.clear();
  });

  it("opens the Evidence disclosure when the page links one immutable reading", async () => {
    const fetchMetric = vi.fn(async () => ({ history: [reading] }));
    const fetchObservation = vi.fn(async () => ({ observation: reading }));
    const fetchHistory = vi.fn(async () => trend("m-page", "items", [3, 4, 5]));
    const client = { ...createGoalsClient(), fetchGoals: async () => fixture(), fetchMetric, fetchObservation, fetchHistory } as unknown as ReturnType<typeof createGoalsClient>;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={qc}><GoalsProvider client={client}>
      <MetricEvidence id="m-page" observationId={reading.id} />
    </GoalsProvider></QueryClientProvider>);
    await view.findByText(/Linked immutable evidence/);
    expect((view.container.querySelector("details[data-evidence]") as HTMLElement).hasAttribute("open")).toBe(true);
    qc.clear();
  });
});
