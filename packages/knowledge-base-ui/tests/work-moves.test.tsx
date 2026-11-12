// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-moves.test`
 * Purpose: Proves a work item leads with the KPI it moves (task.0112): the pure goal resolver (KPI, serves, label spellings, unknown), the detail `WorkMoves` block with and without moves, and the table's Goal column showing the resolved title (never the raw label) with no Project column.
 * Scope: Package exports + fixture goal progress. No node app code, router or URL state.
 * Invariants: GOAL_IS_INHERITED, ONE_SUBJECT_ONE_COMPONENT, GAP_IS_VISIBLE, ONE_READ_FOR_ALL_ROWS.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0112, ../src/goals/work-goals.ts, ../src/goals/work-moves.tsx, ../src/work-item-columns.tsx
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { type GoalsProgress, GoalsProgressSchema } from "@cogni-dao/metrics/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGoalsClient } from "../src/goals/client.js";
import {
  GoalsProvider,
  goalForLabels,
  locateMetric,
  resolveWorkGoal,
  WorkGoalsScope,
  WorkMoves,
} from "../src/goals.js";
import { createWorkItemColumns, type WorkItemRow, type WorkMetric } from "../src/index.js";
import { assessmentFixture, goalFixture, kpiFixture } from "./_fixtures/goals-progress.js";

afterEach(cleanup);

const latest = { viewState: "ok" as const, value: 12, unit: "items", observedAt: "2026-11-02T09:55:00.000Z", reason: null };

/** goal-alpha: KPI `k-ratio` with one serving metric `m-created`. goal-beta: KPI `k-beta`. `m-loose` serves nothing. */
function fixture(): GoalsProgress {
  const ratio = {
    ...kpiFixture("k-ratio", "Ratio KPI", assessmentFixture("behind"), null),
    served: [
      {
        metric: { id: "m-created", title: "Created in 7 days", calculatorId: "work.count@1", role: "input" as const },
        assessment: null,
        latest,
      },
    ],
  };
  return GoalsProgressSchema.parse({
    asOf: "2026-11-02T10:05:00.000Z",
    environment: "test",
    goals: [
      goalFixture("goal-alpha", "Alpha goal: converge", [ratio]),
      goalFixture("goal-beta", "Beta goal: grow", [kpiFixture("k-beta", "Beta KPI", assessmentFixture("on_track"), null)]),
    ],
    orphans: [],
    unbound: [{ metric: { id: "m-loose", title: "Loose count", calculatorId: "work.count@1" }, assessment: null, latest }],
    servedTruncated: false,
  });
}

const move = (metricId: string, over: Partial<WorkMetric> = {}): WorkMetric => ({
  metricId,
  direction: "up",
  moved: "as_declared",
  baseline: { value: 0.8, unit: "ratio", observedAt: "2026-11-01T00:00:00.000Z", id: "obs-base" },
  current: { value: 0.9, unit: "ratio", observedAt: "2026-11-02T09:00:00.000Z", id: "obs-now", metricTitle: "Ratio KPI" },
  ...over,
});

describe("work goal resolver", () => {
  const data = fixture();

  it("resolves a moved KPI to its goal", () => {
    const found = resolveWorkGoal(data, { labels: [], moves: [{ metricId: "k-ratio" }] });
    expect(found?.goal.id).toBe("goal-alpha");
    expect(found?.via).toBe("kpi");
  });

  it("resolves a metric that serves a KPI to that KPI's goal", () => {
    const found = resolveWorkGoal(data, { labels: [], moves: [{ metricId: "m-created" }] });
    expect(found?.goal.id).toBe("goal-alpha");
    expect(found?.via).toBe("serves");
    expect(locateMetric(data, "m-created")).toMatchObject({ kind: "serves", kpi: { binding: { metricId: "k-ratio" } } });
  });

  it("prefers the moved KPI's goal over a label naming another goal", () => {
    expect(resolveWorkGoal(data, { labels: ["goal:goal-alpha"], moves: [{ metricId: "k-beta" }] })?.goal.id).toBe("goal-beta");
  });

  it("falls back to a label in either spelling, naming the active goal id", () => {
    for (const label of ["goal:alpha", "goal:goal-alpha"]) {
      const found = resolveWorkGoal(data, { labels: ["ui", label] });
      expect(found?.goal.id).toBe("goal-alpha");
      expect(found?.goal.title).toBe("Alpha goal: converge");
      expect(found?.via).toBe("label");
    }
    expect(goalForLabels(data, ["goal:beta"])?.id).toBe("goal-beta");
  });

  it("skips a metric that serves no KPI and uses the label; without one it resolves nothing", () => {
    expect(resolveWorkGoal(data, { labels: ["goal:beta"], moves: [{ metricId: "m-loose" }] })?.goal.id).toBe("goal-beta");
    expect(resolveWorkGoal(data, { labels: [], moves: [{ metricId: "m-loose" }] })).toBeNull();
    expect(locateMetric(data, "m-loose")?.kind).toBe("unserved");
  });

  it("resolves nothing for an unknown metric, an unknown goal or an unsafe label", () => {
    expect(resolveWorkGoal(data, { labels: [], moves: [{ metricId: "nope" }] })).toBeNull();
    expect(resolveWorkGoal(data, { labels: ["goal:nope", "goal:goal-nope", "goal:../unsafe", "other"] })).toBeNull();
    expect(resolveWorkGoal(data, { labels: [], moves: [] })).toBeNull();
  });
});

function renderWithGoals(ui: React.ReactElement, data: GoalsProgress | Error = fixture()) {
  const fetchGoals = vi.fn(async () => {
    if (data instanceof Error) throw data;
    return data;
  });
  const client = { ...createGoalsClient(), fetchGoals };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <GoalsProvider client={client}>{ui}</GoalsProvider>
    </QueryClientProvider>,
  );
  return { ...view, fetchGoals };
}

describe("WorkMoves", () => {
  it("leads with Goal, then the KPI card, with direction, baseline, latest and result", async () => {
    const { container } = renderWithGoals(<WorkMoves moves={[move("k-ratio")]} labels={[]} />);
    const goal = await screen.findByRole("link", { name: "Alpha goal: converge" });
    expect(goal).toHaveAttribute("href", "/knowledge/goal-alpha");
    const card = container.querySelector('[data-kpi="k-ratio"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("data-card")).toBe("kpi");
    // Goal title precedes the KPI card in document order.
    expect(goal.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const readout = container.querySelector('[data-move-readout="k-ratio"]') as HTMLElement;
    expect(readout).toHaveTextContent(/Baseline 0\.80 → Latest 0\.90/);
    expect(within(readout).getByLabelText("Expected to rise")).toHaveTextContent("↑");
    expect(readout).toHaveTextContent("as expected");
    expect(within(readout).getByRole("link", { name: "Baseline reading 0.80" })).toHaveAttribute(
      "href",
      "/knowledge/k-ratio?observation=obs-base",
    );
    // The same card opens the chart: one toggle button, collapsed to start.
    expect(within(card).getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("shows Goal, KPI and the supporting metric when the moved metric serves a KPI", async () => {
    const { container } = renderWithGoals(
      <WorkMoves moves={[move("m-created", { direction: "down", moved: "flat" })]} labels={[]} />,
    );
    await screen.findByRole("link", { name: "Alpha goal: converge" });
    const kpiCard = container.querySelector('[data-kpi="k-ratio"]') as HTMLElement;
    const metricCard = container.querySelector('[data-metric="m-created"]') as HTMLElement;
    expect(kpiCard).not.toBeNull();
    expect(metricCard).not.toBeNull();
    expect(kpiCard.compareDocumentPosition(metricCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The item's own readout belongs to the metric it moves, not the KPI above it.
    expect(container.querySelector('[data-chain-id="m-created"] [data-move-readout]')).not.toBeNull();
    expect(container.querySelector('[data-chain-id="k-ratio"] [data-move-readout]')).toBeNull();
    expect(within(container.querySelector('[data-move-readout="m-created"]') as HTMLElement).getByLabelText("Expected to fall")).toHaveTextContent("↓");
  });

  it("names the measurement gap for an item with no moves, with the goal from its label and no edit controls", async () => {
    const { container } = renderWithGoals(<WorkMoves moves={[]} labels={["goal:goal-beta"]} />);
    expect(screen.getByText("Names no KPI — measurement gap")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "why" })).toHaveAttribute(
      "href",
      "https://node-template.cognidao.org/knowledge/kpi-through-delivery",
    );
    expect(await screen.findByRole("link", { name: "Beta goal: grow" })).toBeInTheDocument();
    expect(container.querySelector("[data-kpi]")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/goal:[a-z]/)).toBeNull();
  });

  it("keeps each move's direction, baseline and latest readable when the goals read fails", async () => {
    renderWithGoals(<WorkMoves moves={[move("k-ratio")]} labels={[]} />, new Error("down"));
    expect(await screen.findByText("Goal and KPI unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ratio KPI" })).toBeInTheDocument();
    expect(document.querySelector('[data-move-readout="k-ratio"]')).toHaveTextContent(/Baseline 0\.80 → Latest 0\.90/);
  });
});

function Table({ items }: { readonly items: readonly WorkItemRow[] }) {
  const table = useReactTable({
    data: items as WorkItemRow[],
    columns: createWorkItemColumns(),
    getCoreRowModel: getCoreRowModel(),
    getRowId: (item) => item.id,
    meta: { isLoading: false },
  });
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th key={header.id} data-column={header.column.id}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} data-row={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} data-column={cell.column.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const row = (id: string, over: Partial<WorkItemRow> = {}): WorkItemRow => ({
  id,
  type: "task",
  title: `Item ${id}`,
  status: "needs_implement",
  labels: [],
  projectId: "proj.hidden",
  ...over,
});

describe("work table Goal column", () => {
  it("shows the resolved goal title, not the raw label, from one goals read, and has no Project column", async () => {
    const { container, fetchGoals } = renderWithGoals(
      <WorkGoalsScope>
        <Table
          items={[
            row("task.1", { moves: [move("k-beta")] }),
            row("task.2", { labels: ["goal:alpha"] }),
            row("task.3", { labels: ["goal:goal-alpha"] }),
            row("task.4", { labels: ["goal:unknown"] }),
            row("task.5"),
          ]}
        />
      </WorkGoalsScope>,
    );
    const goalOf = (id: string) => container.querySelector(`[data-row="${id}"] td[data-column="goal"]`) as HTMLElement;
    await waitFor(() => expect(goalOf("task.1")).toHaveTextContent("Beta goal: grow"));
    expect(goalOf("task.2")).toHaveTextContent("Alpha goal: converge");
    expect(goalOf("task.3")).toHaveTextContent("Alpha goal: converge");
    expect(goalOf("task.4")).toHaveTextContent("—");
    expect(goalOf("task.5")).toHaveTextContent("—");
    expect(within(goalOf("task.2")).getByTitle("Alpha goal: converge")).toHaveClass("truncate");
    expect(container.textContent).not.toMatch(/goal:[a-z]/);
    // One read for every row; projectId stays in the data and is not displayed.
    expect(fetchGoals).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-column="projectId"]')).toBeNull();
    expect(container.textContent).not.toMatch(/proj\.hidden|Project/);
  });

  it("shows no goal while the read is unavailable, never the raw label", async () => {
    const { container, fetchGoals } = renderWithGoals(
      <WorkGoalsScope>
        <Table items={[row("task.1", { labels: ["goal:alpha"] })]} />
      </WorkGoalsScope>,
      new Error("down"),
    );
    await waitFor(() => expect(fetchGoals).toHaveBeenCalled());
    expect(container.querySelector('td[data-column="goal"]')).toHaveTextContent("—");
    expect(container.textContent).not.toMatch(/goal:alpha/);
  });

  it("shows the metric title, direction arrow and result in the Metric column", async () => {
    const { container } = renderWithGoals(
      <WorkGoalsScope>
        <Table items={[row("task.1", { moves: [move("k-ratio")] })]} />
      </WorkGoalsScope>,
    );
    const cell = container.querySelector('td[data-column="metric"]') as HTMLElement;
    expect(cell).toHaveTextContent("Ratio KPI · as expected");
    expect(within(cell).getByRole("img", { name: "expected to rise" })).toHaveTextContent("↑");
  });
});
