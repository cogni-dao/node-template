// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board.test`
 * Purpose: Proves the shared board renders without a node router: plain goal anchors, injected hrefs, rank labels, safe updated times, and empty/loading states.
 * Scope: WorkBoard rendering only; node routing behavior is proven by the consuming app's own board test.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0041, ../src/work-board.tsx
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  WorkBoard,
  WorkMetricDetails,
  WorkExpectations,
  type WorkExpectationPage,
  createWorkItemColumns,
  type WorkBoardItem,
  WorkGoalsProvider,
} from "../src/index.js";
import { fetchWorkExpectations } from "../../../app/src/app/(app)/work/_api/fetchWorkExpectations";

const scored = { v: 3 };
const item: WorkBoardItem = {
  id: "task.0001",
  type: "task",
  title: "Ship the board",
  status: "needs_implement",
  labels: ["goal:goal-alpha", "goal:beta", "goal:../unsafe"],
  updatedAt: "2026-11-02T18:37:35.000Z",
  scores: {
    goal: scored,
    time: scored,
    unblocks: scored,
    ease: scored,
    confidence: scored,
    agent: scored,
  },
};

/** The resolver a node mounts: here, only `goal:goal-alpha` names a goal the read lists. */
function WithGoals({ children }: { readonly children: ReactNode }) {
  return (
    <WorkGoalsProvider
      resolve={(subject) =>
        subject.labels.includes("goal:goal-alpha")
          ? { id: "goal-alpha", title: "Alpha goal: ship the board" }
          : null
      }
    >
      {children}
    </WorkGoalsProvider>
  );
}

describe("WorkBoard", () => {
  it("shows the first affected metric and verdict on the card", () => {
    render(
      <WorkBoard
        columns={[
          {
            status: "needs_implement",
            items: [
              {
                ...item,
                moves: [
                  {
                    metricId: "edits-7d",
                    direction: null,
                    baselineObservationId: null,
                    moved: null,
                  },
                ],
              },
            ],
            hasMore: false,
          },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByText(/edits-7d.*affected/i)).toBeInTheDocument();
  });
  it("renders one plain goal anchor, a rank, and a time without a router", () => {
    const onOpenItem = vi.fn();
    render(
      <WithGoals>
        <WorkBoard
          columns={[
            { status: "needs_implement", items: [item], hasMore: false },
            { status: "done", items: [], hasMore: false },
          ]}
          isLoading={false}
          onOpenItem={onOpenItem}
          onLoadMore={() => {}}
        />
      </WithGoals>,
    );
    const open = screen.getByRole("button", {
      name: "task.0001: Ship the board",
    });
    const card = open.parentElement as HTMLElement;
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(within(card).getByRole("link")).toHaveAttribute(
      "href",
      "/knowledge/goal-alpha",
    );
    // The pointer reads the goal's title, never the raw label.
    expect(within(card).getByRole("link")).toHaveTextContent("Alpha goal: ship the board");
    expect(within(card).queryByText(/^goal:/)).toBeNull();
    expect(within(card).getByText(/^Rank /)).toBeInTheDocument();
    expect(card.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-11-02T18:37:35.000Z",
    );
    fireEvent.click(open);
    expect(onOpenItem).toHaveBeenCalledWith(item);
    expect(screen.getByText("No items")).toBeInTheDocument();
  });

  it("uses injected goal hrefs and renderers, and shows unscored/missing safely", () => {
    render(
      <WithGoals>
        <WorkBoard
          columns={[
            {
              status: "needs_implement",
              items: [{ ...item, scores: undefined, updatedAt: "bad date" }],
              hasMore: false,
            },
          ]}
          isLoading={false}
          onOpenItem={() => {}}
          onLoadMore={() => {}}
          goalHref={(slug) => `/goals/${slug}`}
          renderGoalLink={({ href, label }) => (
            <a href={href} data-testid="goal">
              {label}
            </a>
          )}
        />
      </WithGoals>,
    );
    expect(screen.getByTestId("goal")).toHaveAttribute("href", "/goals/alpha");
    expect(screen.getByTestId("goal")).toHaveTextContent("Alpha goal: ship the board");
    expect(screen.getByText("Unscored")).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toHaveTextContent("Updated —");
    expect(document.querySelector("time")).toBeNull();
  });

  it("renders skeletons while loading", () => {
    const { container } = render(
      <WorkBoard
        columns={[{ status: "done", items: [], hasMore: true }]}
        isLoading
        onOpenItem={() => {}}
        onLoadMore={() => {}}
      />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(2);
    expect(screen.queryByText("No items")).toBeNull();
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("keeps searching an empty capped column and loads a not-started column's first page", () => {
    const onLoadMore = vi.fn();
    render(
      <WorkBoard
        columns={[
          {
            status: "needs_implement",
            items: [],
            hasMore: true,
            rowsScanned: 1000,
          },
          { status: "done", items: [], hasMore: true, notStarted: true },
          { status: "cancelled", items: [], hasMore: false },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getAllByText("No items")).toHaveLength(1);
    expect(
      screen.getByText("No matches in the rows searched so far"),
    ).toBeInTheDocument();
    const search = screen.getByRole("button", {
      name: "Search further needs_implement",
    });
    expect(search).toHaveTextContent("Search further (1,000 scanned)");
    expect(screen.getByText("Not loaded yet")).toBeInTheDocument();
    expect(screen.getByText("–")).toHaveAttribute("title", "Not loaded yet");
    fireEvent.click(screen.getByRole("button", { name: "Load done" }));
    fireEvent.click(search);
    expect(onLoadMore.mock.calls).toEqual([["done"], ["needs_implement"]]);
  });

  it("labels a column with more as N+ and requests that column's next page", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <WorkBoard
        columns={[
          { status: "needs_implement", items: [item], hasMore: true },
          {
            status: "done",
            items: [{ ...item, id: "task.0002", status: "done" }],
            hasMore: false,
          },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getByText("1+")).toHaveAttribute(
      "title",
      "1 loaded, more available",
    );
    expect(screen.getByText("1")).toHaveAttribute("title", "1 items");
    fireEvent.click(
      screen.getByRole("button", { name: "Load more needs_implement" }),
    );
    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith("needs_implement");
    expect(screen.getAllByRole("button", { name: /^Load more/ })).toHaveLength(
      1,
    );
    rerender(
      <WorkBoard
        columns={[
          {
            status: "needs_implement",
            items: [item],
            hasMore: true,
            isLoadingMore: true,
          },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Load more needs_implement" }),
    ).toBeDisabled();
  });
});

describe("work expectation join", () => {
  it("refreshes an open detail on knowledge and observation changes without changing moves", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let page: WorkExpectationPage = { items: [], truncated: false };
    const load = vi.fn(async () => page);
    const moves: NonNullable<WorkBoardItem["moves"]> = [];
    const view = render(
      <QueryClientProvider client={client}>
        <WorkExpectations itemId="task.1" moves={moves} load={load} />
      </QueryClientProvider>,
    );
    try {
      expect(
        await screen.findByText("No expectation recorded."),
      ).toBeInTheDocument();
      page = {
        items: [
          {
            id: "hyp.1",
            title: "New expectation",
            content: "Expected result",
            predictions: [
              {
                metricId: "m",
                expected: "gte 4 count",
                observed: "unresolved",
              },
            ],
            outcomes: [],
            truncated: false,
          },
        ],
        truncated: false,
      };
      // The node's actual knowledge mutations invalidate this existing prefix.
      await act(() => client.invalidateQueries({ queryKey: ["knowledge"] }));
      expect(await screen.findByText("New expectation")).toBeInTheDocument();
      page = {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          outcomes: [
            {
              id: "outcome.1",
              title: "Recorded outcome",
              content: "Recount confirmed",
            },
          ],
        })),
      };
      // A refreshed EDO query/revision must also invalidate the composed read.
      act(() =>
        client.setQueryData(["knowledge", "entry", "outcome.1"], {
          revision: "next",
        }),
      );
      expect(await screen.findByText("Recorded outcome")).toBeInTheDocument();
      page = {
        ...page,
        items: page.items.map((item) => ({
          ...item,
          predictions: [
            {
              metricId: "m",
              expected: "gte 4 count",
              observed: "met · observation-2",
            },
          ],
        })),
      };
      act(() =>
        client.setQueryData(["metric", "evidence", "m", "observation-2"], {
          observation: { id: "observation-2" },
        }),
      );
      expect(
        await screen.findByText(/observed met · observation-2/),
      ).toBeInTheDocument();
      await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    } finally {
      view.unmount();
      client.clear();
    }
  });
  it("replaces an in-flight expectation read when evidence changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let finishOld!: (page: WorkExpectationPage) => void;
    const old = new Promise<WorkExpectationPage>((resolve) => {
      finishOld = resolve;
    });
    const updated: WorkExpectationPage = {
      items: [
        {
          id: "hyp.1",
          title: "Current expectation",
          content: "Expected result",
          predictions: [],
          outcomes: [],
          truncated: false,
        },
      ],
      truncated: false,
    };
    const load = vi
      .fn()
      .mockImplementationOnce(() => old)
      .mockResolvedValue(updated);
    const view = render(
      <QueryClientProvider client={client}>
        <WorkExpectations itemId="task.1" moves={[]} load={load} />
      </QueryClientProvider>,
    );
    try {
      await waitFor(() => expect(load).toHaveBeenCalledOnce());
      act(() =>
        client.setQueryData(["knowledge", "entry", "hyp.1"], {
          revision: "new",
        }),
      );
      expect(
        await screen.findByText("Current expectation"),
      ).toBeInTheDocument();
      await act(async () => {
        finishOld({ items: [], truncated: false });
        await old;
      });
      expect(screen.getByText("Current expectation")).toBeInTheDocument();
      expect(
        screen.queryByText("No expectation recorded."),
      ).not.toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      client.clear();
    }
  });
  it("provides shared table columns for goal and metric", () => {
    const columns = createWorkItemColumns();
    expect(columns.map((column) => column.id)).toEqual(
      expect.arrayContaining(["goal", "metric"]),
    );
  });

  it("reports an unavailable expectation projection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    try {
      await expect(
        fetchWorkExpectations("task.1", new AbortController().signal, []),
      ).rejects.toThrow("HTTP 403");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("shows the failed latest reading without presenting it as success", () => {
    render(
      <WorkMetricDetails
        moves={[
          {
            metricId: "m",
            direction: "up",
            moved: "unknown",
            baseline: { value: 1, unit: "count", observedAt: "2026-11-01" },
            current: { value: null, observedAt: null, viewState: "error" },
          },
        ]}
      />,
    );
    expect(screen.getByText("Latest: Unknown · error")).toBeInTheDocument();
    expect(
      screen.getByText("Baseline: 1 count · 2026-11-01"),
    ).toBeInTheDocument();
  });
  it("reads the bounded server projection in one request", async () => {
    const expected = {
      items: [
        {
          id: "hyp.1",
          title: "Expectation",
          content: "fresh reading",
          predictions: [
            { metricId: "m", expected: "gte 4 count", observed: "met" },
          ],
          outcomes: [
            {
              id: "outcome.1",
              title: "Observed",
              content: "independently recounted",
            },
          ],
          truncated: false,
        },
      ],
      truncated: false,
    };
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => expected,
    }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const page = await fetchWorkExpectations(
        "task.1",
        new AbortController().signal,
        [],
      );
      expect(page).toEqual(expected);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
