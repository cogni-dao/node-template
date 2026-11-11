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
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  bandFraction,
  flagText,
  formatAge,
  GoalsBoard,
  type MetricRow,
  MetricsBoard,
  metricRank,
  metricStatus,
  notServingRows,
  sortGoals,
  sortMetricRows,
  summarizeMetrics,
} from "../src/goals.js";
import { goalFixture, kpiFixture, assessmentFixture } from "./_fixtures/goals-progress.js";

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
const served = (id: string, role: "input" | "guardrail" | "diagnostic", assessment: KpiAssessment | null, l: MetricLatest = latest()) => ({
  metric: { id, title: `Title ${id}`, calculatorId: "work.count@1", role },
  assessment,
  latest: l,
});

/** Goal B is healthy and listed first; goal A has a failing KPI and must sort above it. */
function fixture(extra: Partial<GoalsProgress> = {}): GoalsProgress {
  const healthy = kpiFixture("k-ok", "KPI ok", assessmentFixture("on_track"), null);
  const red = { ...kpiFixture("k-red", "KPI red", assessmentFixture("failing"), null), served: [
    served("m-diag", "diagnostic", null, latest({ viewState: "stale" })),
    served("m-input-ok", "input", band("on_track", 95)),
    served("m-guard-red", "guardrail", band("failing", 40)),
    served("m-input-red", "input", band("behind", 50)),
  ] };
  const okAlso = kpiFixture("k-ok2", "KPI ok 2", assessmentFixture("met"), null);
  return GoalsProgressSchema.parse({
    asOf: AS_OF,
    environment: "test",
    goals: [
      goalFixture("goal-b", "Goal B", [healthy, okAlso]),
      goalFixture("goal-a", "Goal A", [healthy, red]),
    ],
    orphans: [
      { metricId: "m-lost", kpi: "no-such", reason: "serves_unknown_kpi", assessment: null, latest: latest({ viewState: "error", value: null, reason: "source_failed" }) },
      { metricId: "m-guard-red", kpi: "k-red", reason: "band_invalid", issues: ["band:x"], assessment: null, latest: latest() },
    ],
    unbound: [
      { metric: { id: "m-loose", title: "Loose count", calculatorId: "work.count@1" }, assessment: null, latest: latest({ value: 3 }) },
      { metric: { id: "m-loose-red", title: "Loose red", calculatorId: "work.count@1" }, assessment: band("failing", 2), latest: latest({ value: 2 }) },
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
    </QueryClientProvider>
  );
}

const ids = (els: Iterable<Element>, attr: string) => [...els].map((e) => e.getAttribute(attr));

describe("MetricsBoard", () => {
  it("sorts goals, KPIs, role groups and metrics worst first", () => {
    const { container } = renderMetrics(fixture());
    // The failing goal is last in the data and first on the page.
    expect(ids(container.querySelectorAll("[data-goal]"), "data-goal")).toEqual(["goal-a", "goal-b"]);
    const goalA = container.querySelector('[data-goal="goal-a"]') as HTMLElement;
    expect(ids(goalA.querySelectorAll("[data-kpi-block]"), "data-kpi-block")).toEqual(["k-red", "k-ok"]);
    const branch = goalA.querySelector('[data-branch="served"]') as HTMLElement;
    // Roles in fixed order; inside a role, worst status first.
    expect(ids(branch.querySelectorAll("[data-role]"), "data-role")).toEqual(["input", "guardrail", "diagnostic"]);
    expect(ids(branch.querySelectorAll("[data-metric]"), "data-metric")).toEqual([
      "m-input-red",
      "m-input-ok",
      "m-guard-red",
      "m-diag",
    ]);
  });

  it("shows status, band, latest value and age on every serving metric, and No band without a verdict", () => {
    const { container } = renderMetrics(fixture());
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

  it("lists metrics that serve no KPI in a flagged group, worst first, and links why", () => {
    const { container } = renderMetrics(fixture());
    const group = container.querySelector('[data-group="not-serving"]') as HTMLElement;
    expect(ids(group.querySelectorAll("[data-metric]"), "data-metric")).toEqual(["m-loose-red", "m-lost", "m-loose"]);
    expect(group.querySelector('[data-metric="m-lost"] [data-flag="serves_unknown_kpi"]')?.textContent).toContain("no-such");
    expect(group.querySelector('[data-metric="m-loose"] [data-flag="unbound"]')?.textContent).toContain("Serves no KPI");
    // Unknown is not zero: a failed metric with no good value reads "—".
    expect(group.querySelector('[data-metric="m-lost"]')?.textContent).toContain("—");
    expect(within(group).getByRole("link", { name: "why" }).getAttribute("href")).toBe("/knowledge/goal-metrics-vs-telemetry");
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
    const cut = GoalsProgressSchema.parse({ asOf: AS_OF, environment: "t", goals: [goalFixture("g", "G", [bare])], orphans: [], unbound: [], servedTruncated: true });
    const a = renderMetrics(cut);
    expect(a.container.querySelector('[data-branch="empty"]')?.textContent).toContain("No metric serves this KPI yet");
    expect(a.container.textContent).toContain("This list may be incomplete");
    expect(a.container.querySelector('[data-group="not-serving"]')).toBeNull();
    a.unmount();
    const down = GoalsProgressSchema.parse({ asOf: AS_OF, environment: "t", goals: [goalFixture("g", "G", [bare])], servedUnavailable: "metric_authority_unavailable" });
    const b = renderMetrics(down);
    expect(b.container.textContent).toContain("Metrics unavailable right now");
    expect(b.container.querySelector('[data-branch]')).toBeNull();
  });

  it("leaves the Goals view as it was: server order, no metric branches", () => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const { container } = render(
      <QueryClientProvider client={c}>
        <GoalsBoard initialData={fixture()} />
      </QueryClientProvider>
    );
    expect(ids(container.querySelectorAll("[data-goal]"), "data-goal")).toEqual(["goal-b", "goal-a"]);
    expect(container.querySelector("[data-branch], [data-group]")).toBeNull();
  });
});

describe("metrics-view", () => {
  const row = (over: Partial<MetricRow>): MetricRow => ({ id: "m", title: "m", calculatorId: "c", role: "input", assessment: null, latest: latest(), flags: [], ...over });

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
    expect(metricRank(row({ assessment: band("failing", 1) }))).toBeLessThan(metricRank(row({ assessment: band("on_track", 99) })));
  });

  it("sorts goals by their worst KPI, with a goal with no KPIs last and ties in server order", () => {
    const g = (id: string, s: KpiStatus[]) => goalFixture(id, id, s.map((x, i) => kpiFixture(`${id}${i}`, "t", assessmentFixture(x), null)));
    expect(sortGoals([g("none", []), g("ok1", ["on_track"]), g("red", ["on_track", "failing"]), g("ok2", ["on_track"])]).map((x) => x.id)).toEqual(["red", "ok1", "ok2", "none"]);
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
      orphans: [{ metricId: "bet-m", title: "Bet metric", kpi: "bet-kpi", reason: "serves_bet_kpi", assessment: null, latest: latest() }],
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
    expect(bandFraction(row({ assessment: band("failing", 0, { value: null }), latest: latest({ value: null }) }))).toBeNull();
  });
});
