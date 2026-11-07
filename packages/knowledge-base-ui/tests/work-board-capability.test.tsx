// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-capability.test`
 * Purpose: Parity proof for the complete work board capability: a fork that renders only the package's public exports, with its own TanStack table and state, can sort by rank, filter by type, status, project and rank range, search, toggle board columns, and see the cards update.
 * Scope: Package exports + a plain client-side TanStack table + fixture items. No node app code, router or URL state.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0044, ../src/work-board-toolbar.tsx, ../src/work-board-view.tsx
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  type ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_WORK_STATUSES,
  createWorkItemColumns,
  DEFAULT_WORK_SORT,
  WorkBoardToolbar,
  WorkBoardView,
  type WorkItemRow,
  workItemGlobalFilterFn,
} from "../src/index.js";

function scores(goal: number) {
  return Object.fromEntries(
    ["goal", "time", "unblocks", "ease", "confidence", "agent"].map((axis) => [
      axis,
      { v: axis === "goal" ? goal : 3 },
    ]),
  );
}

const fixture: WorkItemRow[] = [
  { id: "task.0001", type: "task", title: "Low task", status: "needs_implement", labels: [], projectId: "proj.alpha", scores: scores(1) },
  { id: "task.0002", type: "task", title: "High task", status: "needs_implement", labels: [], projectId: "proj.beta", scores: scores(5) },
  { id: "bug.0003", type: "bug", title: "Middle bug", status: "needs_implement", labels: ["ui"], projectId: "proj.alpha", scores: scores(3) },
  { id: "story.0004", type: "story", title: "Design story", status: "needs_design", labels: [], projectId: "proj.beta", scores: scores(4) },
  { id: "task.0005", type: "task", title: "Finished task", status: "done", labels: [], projectId: "proj.alpha", scores: scores(2) },
  { id: "spike.0006", type: "spike", title: "Unscored spike", status: "needs_implement", labels: [], priority: 1 },
];

function Fork({
  items,
  onOpenItem,
}: {
  readonly items: readonly WorkItemRow[];
  readonly onOpenItem: (item: WorkItemRow) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(
    DEFAULT_WORK_SORT.map((entry) => ({ ...entry })),
  );
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [visibleStatuses, setVisibleStatuses] = useState<string[]>([
    ...ACTIVE_WORK_STATUSES,
  ]);
  const columns = useMemo(() => createWorkItemColumns<WorkItemRow>(), []);
  const data = useMemo(() => [...items], [items]);
  const table = useReactTable({
    data,
    columns,
    getRowId: (item) => item.id,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: workItemGlobalFilterFn,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });
  return (
    <>
      <WorkBoardToolbar
        table={table}
        visibleStatuses={visibleStatuses}
        onVisibleStatusesChange={setVisibleStatuses}
      />
      <WorkBoardView
        table={table}
        visibleStatuses={visibleStatuses}
        isLoading={false}
        onOpenItem={onOpenItem}
      />
    </>
  );
}

const CARD = /^[a-z]+\.\d{4}: /;
const cardIds = () =>
  screen
    .queryAllByRole("button", { name: CARD })
    .map((card) => card.getAttribute("aria-label")?.split(":")[0]);
const cardRanks = () =>
  screen
    .queryAllByRole("button", { name: CARD })
    .map((card) => within(card).getByTitle("Rank score").textContent);
const filterBar = () =>
  within(screen.getByRole("group", { name: "Board filters and sorting" }));

async function openFilter(name: string) {
  await userEvent.click(filterBar().getByRole("button", { name }));
}

function mount() {
  const onOpenItem = vi.fn();
  render(<Fork items={fixture} onOpenItem={onOpenItem} />);
  return { onOpenItem };
}

describe("work board capability (package exports only)", () => {
  afterEach(cleanup);

  it("renders the full control surface and active columns by default", () => {
    mount();
    expect(screen.getByPlaceholderText(/Search id, title, labels/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board columns" })).toBeInTheDocument();
    for (const name of ["Rank", "Type", "Status", "Project"]) {
      expect(filterBar().getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    for (const name of ["Filter rank", "Filter type", "Filter status", "Filter projects"]) {
      expect(filterBar().getByRole("button", { name })).toBeInTheDocument();
    }
    expect(cardIds()).not.toContain("task.0005");
    expect(cardIds()).toContain("story.0004");
  });

  it("sorts by rank descending first, unscored last, then ascending", async () => {
    mount();
    const implementIds = new Set(
      fixture.filter((item) => item.status === "needs_implement").map((item) => item.id),
    );
    const implementRanks = () =>
      screen
        .queryAllByRole("button", { name: CARD })
        .filter((card) => implementIds.has(card.getAttribute("aria-label")?.split(":")[0] ?? ""))
        .map((card) => within(card).getByTitle("Rank score").textContent);
    expect(implementRanks().at(-1)).toBe("Unscored");
    const desc = implementRanks()
      .filter((v) => v !== "Unscored")
      .map((v) => Number(v?.replace("Rank ", "")));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    expect(cardIds().indexOf("task.0002")).toBeLessThan(cardIds().indexOf("bug.0003"));
    expect(cardIds().indexOf("bug.0003")).toBeLessThan(cardIds().indexOf("task.0001"));
    expect(cardIds().indexOf("task.0001")).toBeLessThan(cardIds().indexOf("spike.0006"));
    await userEvent.click(filterBar().getByRole("button", { name: "Rank" }));
    expect(cardIds().indexOf("task.0001")).toBeLessThan(cardIds().indexOf("bug.0003"));
    expect(cardIds().indexOf("bug.0003")).toBeLessThan(cardIds().indexOf("task.0002"));
    expect(cardIds().indexOf("task.0002")).toBeLessThan(cardIds().indexOf("spike.0006"));
  });

  it("filters by type, then clears filters", async () => {
    mount();
    await openFilter("Filter type");
    await userEvent.click(screen.getByRole("button", { name: "bug" }));
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute("aria-pressed", "true");
    expect(cardIds()).toEqual(["bug.0003"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(cardIds()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("filters by status", async () => {
    mount();
    await openFilter("Filter status");
    await userEvent.click(screen.getByRole("button", { name: "design" }));
    expect(cardIds()).toEqual(["story.0004"]);
  });

  it("filters by project from facets", async () => {
    mount();
    await openFilter("Filter projects");
    await userEvent.click(screen.getByRole("button", { name: "beta" }));
    expect(cardIds().sort()).toEqual(["story.0004", "task.0002"]);
  });

  it("filters by a rank range", async () => {
    mount();
    await openFilter("Filter rank");
    const before = cardRanks()
      .filter((rank) => rank !== "Unscored")
      .map((rank) => Number(rank?.replace("Rank ", "")));
    const [lowest = 0, next = 0] = [...before].sort((a, b) => a - b);
    const threshold = (lowest + next) / 2;
    fireEvent.change(screen.getByLabelText("Rank minimum"), {
      target: { value: String(threshold) },
    });
    const after = cardRanks();
    expect(after).not.toContain("Unscored");
    expect(after.length).toBe(before.length - 1);
    for (const rank of after) {
      expect(Number(rank?.replace("Rank ", ""))).toBeGreaterThanOrEqual(threshold);
    }
    expect(filterBar().getByRole("button", { name: "Filter rank" })).toHaveTextContent(`≥${threshold}`);
  });

  it("searches id, title and labels", async () => {
    mount();
    await userEvent.type(screen.getByPlaceholderText(/Search id, title, labels/), "ui");
    expect(cardIds()).toEqual(["bug.0003"]);
  });

  it("toggles board columns and the cards follow", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Board columns" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "design" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "done" }));
    await userEvent.keyboard("{Escape}");
    expect(cardIds()).not.toContain("story.0004");
    expect(cardIds()).toContain("task.0005");
  });

  it("discloses a sort without a board control and resets to rank", async () => {
    mount();
    // A fork's table offers more columns than the board; sort one of them through the table.
    await userEvent.click(filterBar().getByRole("button", { name: /^Type/ }));
    expect(screen.queryByText(/Sorted by/)).not.toBeInTheDocument();
    cleanup();
    function Hidden() {
      const columns = useMemo(() => createWorkItemColumns<WorkItemRow>(), []);
      const [sorting, setSorting] = useState<SortingState>([{ id: "priority", desc: false }]);
      const table = useReactTable({
        data: fixture as WorkItemRow[],
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
      });
      return <WorkBoardView table={table} visibleStatuses={["needs_implement"]} isLoading={false} onOpenItem={() => {}} />;
    }
    render(<Hidden />);
    expect(screen.getByText("Sorted by priority (ascending)")).toBeInTheDocument();
    expect(cardIds()[0]).toBe("spike.0006");
    await userEvent.click(screen.getByRole("button", { name: "Reset to rank" }));
    expect(screen.queryByText(/Sorted by/)).not.toBeInTheDocument();
    expect(cardIds()[0]).toBe("task.0002");
  });

  it("opens the card's own item", async () => {
    const { onOpenItem } = mount();
    await userEvent.click(screen.getByRole("button", { name: "story.0004: Design story" }));
    expect(onOpenItem).toHaveBeenCalledWith(fixture[3]);
  });
});
