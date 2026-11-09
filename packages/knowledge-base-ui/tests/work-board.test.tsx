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

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkBoard, type WorkBoardItem } from "../src/index.js";

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

describe("WorkBoard", () => {
  it("renders one plain goal anchor, a rank, and a time without a router", () => {
    const onOpenItem = vi.fn();
    render(
      <WorkBoard
        columns={[
          { status: "needs_implement", items: [item], hasMore: false },
          { status: "done", items: [], hasMore: false },
        ]}
        isLoading={false}
        onOpenItem={onOpenItem}
        onLoadMore={() => {}}
      />,
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
      />,
    );
    expect(screen.getByTestId("goal")).toHaveAttribute("href", "/goals/alpha");
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
          { status: "needs_implement", items: [], hasMore: true, rowsScanned: 1000 },
          { status: "done", items: [], hasMore: true, notStarted: true },
          { status: "cancelled", items: [], hasMore: false },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getAllByText("No items")).toHaveLength(1);
    expect(screen.getByText("No matches in the rows searched so far")).toBeInTheDocument();
    const search = screen.getByRole("button", { name: "Search further needs_implement" });
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
          { status: "done", items: [{ ...item, id: "task.0002", status: "done" }], hasMore: false },
        ]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getByText("1+")).toHaveAttribute("title", "1 loaded, more available");
    expect(screen.getByText("1")).toHaveAttribute("title", "1 items");
    fireEvent.click(screen.getByRole("button", { name: "Load more needs_implement" }));
    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith("needs_implement");
    expect(screen.getAllByRole("button", { name: /^Load more/ })).toHaveLength(1);
    rerender(
      <WorkBoard
        columns={[{ status: "needs_implement", items: [item], hasMore: true, isLoadingMore: true }]}
        isLoading={false}
        onOpenItem={() => {}}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.getByRole("button", { name: "Load more needs_implement" })).toBeDisabled();
  });
});
