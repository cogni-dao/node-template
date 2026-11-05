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
        items={[item]}
        statuses={["needs_implement", "done"]}
        isLoading={false}
        onOpenItem={onOpenItem}
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
    expect(screen.getByText("No items on this page")).toBeInTheDocument();
  });

  it("uses injected goal hrefs and renderers, and shows unscored/missing safely", () => {
    render(
      <WorkBoard
        items={[{ ...item, scores: undefined, updatedAt: "bad date" }]}
        statuses={["needs_implement"]}
        isLoading={false}
        onOpenItem={() => {}}
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
        items={[]}
        statuses={["done"]}
        isLoading
        onOpenItem={() => {}}
      />,
    );
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(2);
    expect(screen.queryByText("No items on this page")).toBeNull();
  });
});
