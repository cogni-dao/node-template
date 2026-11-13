// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-capability.test`
 * Purpose: Parity proof for the complete, bounded work board capability: a fork that renders only the package's public exports, with its own TanStack table, React Query client and two fetchers, can sort, filter, search and toggle columns, and the board never asks for more than its budget (task.0044, task.0055).
 * Scope: Package exports + a manual-filtering TanStack table + a fixture "server" built from the published codec and board loader. No node app code, router or URL state.
 * Invariants:
 *   - ONE_BOARD_REQUEST: first render issues exactly one board request, ≤ 20 cards per column, no page request.
 *   - ONE_PAGE_PER_CLICK: Load more issues exactly one page request for that column and appends; nothing loops cursors.
 *   - ABORT_EVERY_REQUEST: a filter change aborts the in-flight board and page requests.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0044, task.0055, ../src/work-board-toolbar.tsx, ../src/work-board-view.tsx, ../src/use-work-board.ts
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  loadWorkBoardColumns,
  parseWorkBoardSearchParams,
  parseWorkSummarySearchParams,
  rankScore,
  WORK_BOARD_COLUMN_PAGE,
  type WorkBoardColumns,
  type WorkItemSummary,
  type WorkSummaryPage,
  type WorkSummaryQuery,
} from "@cogni/work-items";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_WORK_STATUSES,
  createWorkItemColumns,
  DEFAULT_WORK_SORT,
  useWorkBoard,
  WorkBoardToolbar,
  WorkBoardView,
  workBoardTableStateToQuery,
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

const STAMP = "2026-11-01T00:00:00Z";
function row(
  fields: Pick<WorkItemSummary, "id" | "type" | "title" | "status"> &
    Partial<WorkItemSummary>,
): WorkItemSummary {
  return { labels: [], createdAt: STAMP, updatedAt: STAMP, ...fields };
}

const fixture: WorkItemSummary[] = [
  row({ id: "task.0001", type: "task", title: "Low task", status: "needs_implement", projectId: "proj.alpha", scores: scores(1) }),
  row({ id: "task.0002", type: "task", title: "High task", status: "needs_implement", projectId: "proj.beta", scores: scores(5) }),
  row({ id: "bug.0003", type: "bug", title: "Middle bug", status: "needs_implement", labels: ["ui"], projectId: "proj.alpha", scores: scores(3) }),
  row({ id: "story.0004", type: "story", title: "Design story", status: "needs_design", projectId: "proj.beta", scores: scores(4) }),
  row({ id: "task.0005", type: "task", title: "Finished task", status: "done", projectId: "proj.alpha", scores: scores(2) }),
  row({ id: "spike.0006", type: "spike", title: "Unscored spike", status: "needs_implement", priority: 1 }),
];

/** 45 implement cards, so a 20-row column page has two more pages behind it. */
const bulk: WorkItemSummary[] = Array.from({ length: 45 }, (_, index) =>
  row({
    id: `task.${String(1000 + index)}`,
    type: "task",
    title: `Bulk ${index}`,
    status: "needs_implement",
    scores: scores(1 + (index % 5)),
  }),
);

/** What a node's summaries endpoint does, over fixture rows; cursors are offsets. */
function servePage(
  items: readonly WorkItemSummary[],
  query: WorkSummaryQuery,
): WorkSummaryPage {
  const text = query.text?.toLowerCase();
  const rows = items
    .filter((item) => !query.types || query.types.includes(item.type))
    .filter((item) => !query.statuses || query.statuses.includes(item.status))
    .filter(
      (item) =>
        !query.projectIds ||
        (item.projectId !== undefined && query.projectIds.includes(item.projectId)),
    )
    .filter((item) => {
      if (query.rankMin === undefined && query.rankMax === undefined) return true;
      const rank = rankScore(item.scores);
      return (
        rank !== undefined &&
        rank >= (query.rankMin ?? Number.NEGATIVE_INFINITY) &&
        rank <= (query.rankMax ?? Number.POSITIVE_INFINITY)
      );
    })
    .filter(
      (item) =>
        !text ||
        [item.id, item.title, ...item.labels].join(" ").toLowerCase().includes(text),
    )
    .sort((a, b) => {
      const sign = query.sortDirection === "asc" ? 1 : -1;
      const ra = rankScore(a.scores);
      const rb = rankScore(b.scores);
      if (ra === undefined && rb !== undefined) return 1;
      if (ra !== undefined && rb === undefined) return -1;
      if (ra !== undefined && rb !== undefined && ra !== rb) return (ra - rb) * sign;
      return a.id < b.id ? -1 : 1;
    });
  const offset = query.cursor ? Number(query.cursor) : 0;
  const limit = query.limit ?? 25;
  const hasMore = offset + limit < rows.length;
  return {
    items: rows.slice(offset, offset + limit),
    pageInfo: { hasMore, endCursor: hasMore ? String(offset + limit) : null },
  };
}

function fixtureServer(items: readonly WorkItemSummary[]) {
  const fetchBoard = vi.fn(
    async (params: URLSearchParams, _signal: AbortSignal): Promise<WorkBoardColumns> => {
      const parsed = parseWorkBoardSearchParams(params);
      if (!parsed.ok) throw new Error("bad board request");
      return loadWorkBoardColumns(
        async (query) => servePage(items, query),
        parsed.query,
        parsed.statuses,
      );
    },
  );
  const fetchPage = vi.fn(
    async (params: URLSearchParams, _signal: AbortSignal): Promise<WorkSummaryPage> => {
      const parsed = parseWorkSummarySearchParams(params);
      if (!parsed.ok) throw new Error("bad page request");
      return servePage(items, parsed.query);
    },
  );
  return { fetchBoard, fetchPage };
}
type Server = ReturnType<typeof fixtureServer>;

function Fork({
  server,
  onOpenItem,
}: {
  readonly server: Server;
  readonly onOpenItem: (item: WorkItemSummary) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>(
    DEFAULT_WORK_SORT.map((entry) => ({ ...entry })),
  );
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [visibleStatuses, setVisibleStatuses] = useState<string[]>([
    ...ACTIVE_WORK_STATUSES,
  ]);
  const query = useMemo(
    () => workBoardTableStateToQuery({ sorting, columnFilters, globalFilter }),
    [sorting, columnFilters, globalFilter],
  );
  const board = useWorkBoard({
    query,
    statuses: visibleStatuses,
    fetchBoard: server.fetchBoard,
    fetchPage: server.fetchPage,
  });
  const columns = useMemo(() => createWorkItemColumns<WorkItemSummary>(), []);
  const table = useReactTable({
    data: board.items as WorkItemSummary[],
    columns,
    getRowId: (item) => item.id,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: workItemGlobalFilterFn,
    manualSorting: true,
    manualFiltering: true,
    getCoreRowModel: getCoreRowModel(),
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
        columns={board.columns}
        isLoading={board.isLoading}
        onOpenItem={onOpenItem}
        onLoadMore={board.loadMore}
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
const column = (name: string) =>
  within(screen.getByRole("heading", { name }).closest("[data-slot]") as HTMLElement);

async function openFilter(name: string) {
  await userEvent.click(filterBar().getByRole("button", { name }));
}

function mount(items: readonly WorkItemSummary[] = fixture) {
  const onOpenItem = vi.fn();
  const server = fixtureServer(items);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Fork server={server} onOpenItem={onOpenItem} />
    </QueryClientProvider>,
  );
  return { onOpenItem, server, ...view };
}

async function mounted(items?: readonly WorkItemSummary[]) {
  const result = mount(items);
  await screen.findAllByRole("button", { name: CARD });
  return result;
}

describe("work board capability (package exports only)", () => {
  afterEach(cleanup);

  it("renders the full control surface and active columns by default", async () => {
    await mounted();
    expect(screen.getByPlaceholderText(/Search id, title, labels/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Board columns" })).toBeInTheDocument();
    for (const name of ["Rank", "Type", "Status"]) {
      expect(filterBar().getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    for (const name of ["Filter rank", "Filter type", "Filter status"]) {
      expect(filterBar().getByRole("button", { name })).toBeInTheDocument();
    }
    expect(filterBar().queryByRole("button", { name: "Filter projects" })).not.toBeInTheDocument();
    expect(cardIds()).not.toContain("task.0005");
    expect(cardIds()).toContain("story.0004");
  });

  it("sorts by rank descending first, unscored last, then ascending", async () => {
    await mounted();
    const implement = () => cardIds().filter((id) => id !== "story.0004");
    expect(implement()).toEqual(["task.0002", "bug.0003", "task.0001", "spike.0006"]);
    await userEvent.click(filterBar().getByRole("button", { name: "Rank" }));
    await waitFor(() =>
      expect(implement()).toEqual(["task.0001", "bug.0003", "task.0002", "spike.0006"]),
    );
    expect(cardRanks().at(-1)).toBe("Unscored");
  });

  it("filters by type, then clears filters", async () => {
    await mounted();
    await openFilter("Filter type");
    await userEvent.click(screen.getByRole("button", { name: "bug" }));
    await waitFor(() => expect(cardIds()).toEqual(["bug.0003"]));
    expect(screen.getByRole("button", { name: "bug" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(cardIds()).toHaveLength(5));
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("filters by status", async () => {
    await mounted();
    await openFilter("Filter status");
    await userEvent.click(screen.getByRole("button", { name: "design" }));
    await waitFor(() => expect(cardIds()).toEqual(["story.0004"]));
  });

  it("filters by a rank range", async () => {
    await mounted();
    await openFilter("Filter rank");
    const before = cardRanks()
      .filter((rank) => rank !== "Unscored")
      .map((rank) => Number(rank?.replace("Rank ", "")));
    const [lowest = 0, next = 0] = [...before].sort((a, b) => a - b);
    const threshold = (lowest + next) / 2;
    fireEvent.change(screen.getByLabelText("Rank minimum"), {
      target: { value: String(threshold) },
    });
    await waitFor(() => expect(cardRanks()).toHaveLength(before.length - 1));
    const after = cardRanks();
    expect(after).not.toContain("Unscored");
    for (const rank of after) {
      expect(Number(rank?.replace("Rank ", ""))).toBeGreaterThanOrEqual(threshold);
    }
    expect(filterBar().getByRole("button", { name: "Filter rank" })).toHaveTextContent(`≥${threshold}`);
  });

  it("searches id, title and labels", async () => {
    await mounted();
    await userEvent.type(screen.getByPlaceholderText(/Search id, title, labels/), "ui");
    await waitFor(() => expect(cardIds()).toEqual(["bug.0003"]));
  });

  it("toggles board columns and the board follows", async () => {
    const { server } = await mounted();
    await userEvent.click(screen.getByRole("button", { name: "Board columns" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "design" }));
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "done" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(cardIds()).toContain("task.0005"));
    expect(cardIds()).not.toContain("story.0004");
    expect(screen.queryByRole("heading", { name: "design" })).not.toBeInTheDocument();
    const last = server.fetchBoard.mock.lastCall?.[0];
    expect(last?.get("statuses")).not.toContain("needs_design");
    expect(last?.get("statuses")).toContain("done");
  });

  it("discloses a sort without a board control and resets to rank", async () => {
    function Hidden() {
      const columns = useMemo(() => createWorkItemColumns<WorkItemSummary>(), []);
      const [sorting, setSorting] = useState<SortingState>([{ id: "priority", desc: false }]);
      const table = useReactTable({
        data: fixture,
        columns,
        state: { sorting },
        onSortingChange: setSorting,
        manualSorting: true,
        getCoreRowModel: getCoreRowModel(),
      });
      return (
        <WorkBoardView
          table={table}
          columns={[{ status: "needs_implement", items: fixture.slice(0, 1), hasMore: false }]}
          isLoading={false}
          onOpenItem={() => {}}
          onLoadMore={() => {}}
        />
      );
    }
    render(<Hidden />);
    expect(screen.getByText("Sorted by priority (ascending)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset to rank" }));
    expect(screen.queryByText(/Sorted by/)).not.toBeInTheDocument();
  });

  it("opens the card's own item", async () => {
    const { onOpenItem } = await mounted();
    await userEvent.click(screen.getByRole("button", { name: "story.0004: Design story" }));
    expect(onOpenItem).toHaveBeenCalledWith(fixture[3]);
  });
});

describe("work board bounded reads", () => {
  afterEach(cleanup);

  it("issues one board request, at most one budget page per column, and no page request", async () => {
    const { server } = await mounted(bulk);
    await waitFor(() => expect(cardIds()).toHaveLength(WORK_BOARD_COLUMN_PAGE));
    expect(server.fetchBoard).toHaveBeenCalledTimes(1);
    expect(server.fetchPage).not.toHaveBeenCalled();
    const params = server.fetchBoard.mock.calls[0]?.[0];
    expect(params?.get("statuses")).toBe(ACTIVE_WORK_STATUSES.join(","));
    expect(params?.get("limit")).toBe(String(WORK_BOARD_COLUMN_PAGE));
    expect(params?.has("cursor")).toBe(false);
    const board = await server.fetchBoard.mock.results[0]?.value;
    for (const col of board.columns) {
      expect(col.items.length).toBeLessThanOrEqual(WORK_BOARD_COLUMN_PAGE);
    }
    // The count says more exist; it never claims to be a total.
    expect(column("implement").getByText(`${WORK_BOARD_COLUMN_PAGE}+`)).toBeInTheDocument();
  });

  it("shows N+ while a column has more and appends exactly one page per Load more", async () => {
    const { server } = await mounted(bulk);
    const implement = () => column("implement");
    expect(implement().getByText(`${WORK_BOARD_COLUMN_PAGE}+`)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Load more/ })).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Load more needs_implement" }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
    expect(server.fetchBoard).toHaveBeenCalledTimes(1);
    const page = server.fetchPage.mock.calls[0]?.[0];
    expect(page?.get("statuses")).toBe("needs_implement");
    expect(page?.get("cursor")).toBe(String(WORK_BOARD_COLUMN_PAGE));
    expect(page?.get("limit")).toBe(String(WORK_BOARD_COLUMN_PAGE));
    expect(new Set(cardIds()).size).toBe(40);
    expect(implement().getByText("40+")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load more needs_implement" }));
    await waitFor(() => expect(cardIds()).toHaveLength(45));
    expect(server.fetchPage).toHaveBeenCalledTimes(2);
    expect(implement().getByText("45")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Load more/ })).not.toBeInTheDocument();

    // Nothing keeps walking the cursor on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.fetchPage).toHaveBeenCalledTimes(2);
    expect(server.fetchBoard).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight board and page requests when the filter changes", async () => {
    const { server } = await mounted(bulk);
    const signals: AbortSignal[] = [];
    const release: Array<() => void> = [];
    const original = server.fetchPage.getMockImplementation();
    server.fetchPage.mockImplementation(async (params, signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => release.push(resolve));
      return (original as NonNullable<typeof original>)(params, signal);
    });
    await userEvent.click(screen.getByRole("button", { name: "Load more needs_implement" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Load more needs_implement" })).toBeDisabled();
    expect(signals[0]?.aborted).toBe(false);

    await userEvent.type(screen.getByPlaceholderText(/Search id, title, labels/), "Bulk 1");
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    release.forEach((resolve) => resolve());

    // The aborted page never lands: only the new query's first page is shown.
    await waitFor(() => expect(server.fetchBoard.mock.lastCall?.[0].get("text")).toBe("Bulk 1"));
    await waitFor(() => expect(cardIds().length).toBeLessThanOrEqual(WORK_BOARD_COLUMN_PAGE));
    expect(cardIds().every((id) => bulk.some((item) => item.id === id && item.title.startsWith("Bulk 1")))).toBe(true);
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight board request when the filter changes, and refetches once per change", async () => {
    const signals: AbortSignal[] = [];
    const server = fixtureServer(bulk);
    const base = server.fetchBoard.getMockImplementation();
    server.fetchBoard.mockImplementation(async (params, signal) => {
      signals.push(signal);
      if (signals.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return (base as NonNullable<typeof base>)(params, signal);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Fork server={server} onOpenItem={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(signals).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Rank" }));
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    await waitFor(() => expect(cardIds()).toHaveLength(WORK_BOARD_COLUMN_PAGE));
    expect(server.fetchBoard).toHaveBeenCalledTimes(2);
    expect(server.fetchBoard.mock.lastCall?.[0].get("sortDirection")).toBe("asc");
    expect(server.fetchPage).not.toHaveBeenCalled();
  });

  it("loads a not-started column's first page and keeps searching an empty capped column", async () => {
    const server = fixtureServer(bulk);
    // The board budget reaches only the first column; the capped scan finds nothing yet.
    server.fetchBoard.mockImplementation(async (params) => {
      const parsed = parseWorkBoardSearchParams(params);
      if (!parsed.ok) throw new Error("bad board request");
      return loadWorkBoardColumns(
        async () => ({
          items: [],
          pageInfo: { endCursor: "scan-1", hasMore: true, rowsScanned: 1000 },
        }),
        parsed.query,
        parsed.statuses,
        { maxScanRows: 1000 },
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Fork server={server} onOpenItem={() => {}} />
      </QueryClientProvider>,
    );
    const first = ACTIVE_WORK_STATUSES[0] as string;
    const search = await screen.findByRole("button", { name: `Search further ${first}` });
    expect(search).toHaveTextContent("Search further (1,000 scanned)");
    expect(screen.queryByText("No items")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load needs_implement" }));
    await waitFor(() => expect(cardIds()).toHaveLength(WORK_BOARD_COLUMN_PAGE));
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
    const firstPage = server.fetchPage.mock.calls[0]?.[0];
    expect(firstPage?.get("statuses")).toBe("needs_implement");
    expect(firstPage?.has("cursor")).toBe(false);
    expect(screen.getByRole("button", { name: "Load more needs_implement" })).toBeInTheDocument();

    server.fetchPage.mockResolvedValueOnce({
      items: [],
      pageInfo: { endCursor: "scan-2", hasMore: true, rowsScanned: 1000 },
    });
    await userEvent.click(search);
    await waitFor(() => expect(server.fetchPage).toHaveBeenCalledTimes(2));
    expect(server.fetchPage.mock.calls[1]?.[0].get("cursor")).toBe("scan-1");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: `Search further ${first}` }),
      ).toHaveTextContent("Search further (2,000 scanned)"),
    );
    expect(server.fetchBoard).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx board response", async () => {
    const server = fixtureServer(bulk);
    server.fetchBoard.mockRejectedValue(
      Object.assign(new Error("invalid input"), { status: 400 }),
    );
    // The client default would retry; the hook's own policy must win.
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } });
    render(
      <QueryClientProvider client={client}>
        <Fork server={server} onOpenItem={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(server.fetchBoard).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.fetchBoard).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx board response", async () => {
    const server = fixtureServer(bulk);
    const base = server.fetchBoard.getMockImplementation();
    server.fetchBoard.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { status: 503 }),
    );
    server.fetchBoard.mockImplementation(base as NonNullable<typeof base>);
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
    render(
      <QueryClientProvider client={client}>
        <Fork server={server} onOpenItem={() => {}} />
      </QueryClientProvider>,
    );
    await screen.findAllByRole("button", { name: CARD });
    expect(server.fetchBoard).toHaveBeenCalledTimes(2);
  });

  it("drops appended pages when the board changes", async () => {
    const { server } = await mounted(bulk);
    await userEvent.click(screen.getByRole("button", { name: "Load more needs_implement" }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));
    await userEvent.click(filterBar().getByRole("button", { name: "Rank" }));
    await waitFor(() => expect(server.fetchBoard).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cardIds()).toHaveLength(WORK_BOARD_COLUMN_PAGE));
  });
});
