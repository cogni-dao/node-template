// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// @vitest-environment jsdom

/** Exercises the real ReUI board through the shared TanStack work dashboard. */
import "@testing-library/jest-dom/vitest";
import type { WorkItemDto } from "@cogni/node-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.params,
}));
vi.mock("@/components", async () => ({
  ...(await import("@cogni/node-ui-kit/shadcn/button")),
  ...(await import("@cogni/node-ui-kit/shadcn/input")),
}));
vi.mock("@/app/(app)/work/_components/WorkItemDetail", () => ({
  WorkItemDetail: () => null,
}));
vi.mock("@/app/(app)/work/_api/fetchWorkItems", () => ({
  fetchWorkItems: vi.fn(),
  fetchWorkItem: vi.fn(),
}));

import { fetchWorkItems } from "@/app/(app)/work/_api/fetchWorkItems";
import { WorkDashboardView } from "@/app/(app)/work/view";

const fixture: WorkItemDto[] = Array.from({ length: 5_000 }, (_, index) => ({
  id: `task.${String(index).padStart(4, "0")}`,
  type: "task",
  title: `Work item ${index}`,
  status: index % 3 === 0 ? "needs_design" : "needs_implement",
  labels: [],
  specRefs: [],
  revision: 1,
  deployVerified: false,
  assignees: [],
  externalRefs: [],
  actor: "either",
  node: "node-template",
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
  priority: 2,
  scores: Object.fromEntries(
    Object.entries({
      goal: 5,
      time: 5,
      unblocks: 5,
      ease: index % 2 === 0 ? 5 : 1,
      confidence: 5,
      agent: 5,
    }).map(([key, v]) => [key, { v }]),
  ),
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkDashboardView />
    </QueryClientProvider>,
  );
}
describe("Work Kanban", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: fixture.filter((_, i) => i % 2 === 0).slice(0, 10),
      pageInfo: { endCursor: "next", hasMore: true },
    });
  });
  afterEach(cleanup);
  it("requests one ranked page and renders only that page", async () => {
    mount();
    await waitFor(() =>
      expect(
        screen.getByText("10 items on this page · 10 visible cards"),
      ).toBeInTheDocument(),
    );
    const params = vi.mocked(fetchWorkItems).mock.calls[0]?.[0];
    expect(params?.get("limit")).toBe("10");
    expect(params?.has("rankMin")).toBe(false);
    expect(params?.get("sortBy")).toBe("rankScore");
    expect(params?.get("sortDirection")).toBe("desc");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigation.router.replace).toHaveBeenCalledWith(
      "/work?cursor=next",
      { scroll: false },
    );
  });
  it("renders independent goal links, one rank, project and safe updated times", async () => {
    const item = {
      ...(fixture[0] as WorkItemDto),
      labels: ["goal:alpha", "goal:goal-alpha", "goal:beta", "goal:../unsafe"],
      projectId: "proj.example",
      updatedAt:
        "Mon Nov 02 2026 18:37:35 GMT+0000 (Coordinated Universal Time)",
    };
    const invalid = {
      ...(fixture[1] as WorkItemDto),
      scores: undefined,
      updatedAt: "bad date",
    };
    const missing = { ...(fixture[2] as WorkItemDto), updatedAt: "" };
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: [item, invalid, missing],
      pageInfo: { endCursor: null, hasMore: false },
    });
    mount();
    const open = await screen.findByRole("button", {
      name: "task.0000: Work item 0",
    });
    const card = open.parentElement as HTMLElement;
    expect(card).toHaveAttribute("data-slot", "kanban-item");
    expect(card).not.toHaveAttribute("role", "button");
    expect(card).not.toHaveAttribute("tabindex");
    expect(card.tabIndex).toBe(-1);
    expect(within(card).getAllByText(/^Rank /)).toHaveLength(1);
    expect(within(card).queryByText("P2")).not.toBeInTheDocument();
    expect(within(card).getByText("example")).toBeInTheDocument();
    expect(within(card).getAllByRole("link")).toHaveLength(2);
    const goal = within(card).getByRole("link", { name: "goal:alpha" });
    expect(goal).toHaveAttribute("href", "/knowledge/goal-alpha");
    expect(open.contains(goal)).toBe(false);
    goal.focus();
    expect(goal).toHaveFocus();
    fireEvent.keyDown(goal, { key: "Enter" });
    fireEvent.click(goal);
    expect(navigation.router.push).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(navigation.router.push).toHaveBeenCalledWith(
      "/work/items/task.0000",
      { scroll: false },
    );
    expect(card.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-11-02T18:37:35.000Z",
    );
    const invalidCard = screen.getByRole("button", {
      name: "task.0001: Work item 1",
    }).parentElement as HTMLElement;
    expect(within(invalidCard).getByText("Unscored")).toBeInTheDocument();
    expect(within(invalidCard).getByText(/Updated/)).toHaveTextContent(
      "Updated —",
    );
    expect(invalidCard.querySelector("time")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "task.0002: Work item 2" })
        .parentElement?.querySelector("time"),
    ).toBeNull();
  });

  it("preserves explicit rank bounds and clears them on request", async () => {
    navigation.params = new URLSearchParams("rankMin=2&rankMax=5&status=all");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    const params = vi.mocked(fetchWorkItems).mock.calls[0]?.[0];
    expect(params?.get("rankMin")).toBe("2");
    expect(params?.get("rankMax")).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    const url = vi
      .mocked(navigation.router.replace)
      .mock.calls.at(-1)?.[0] as string;
    const cleared = new URL(url, "https://example.com").searchParams;
    expect(cleared.get("rankMin")).toBe("");
    expect(cleared.get("rankMax")).toBe("");
  });

  it("discloses hidden legacy sorting and resets only on request", async () => {
    navigation.params = new URLSearchParams("sort=-priority&cursor=p2");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalled());
    expect(
      screen.getByText("Sorted by priority (descending)"),
    ).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWorkItems).mock.calls[0]?.[0].get("sortBy")).toBe(
      "priority",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset to rank" }));
    const url = vi
      .mocked(navigation.router.replace)
      .mock.calls.at(-1)?.[0] as string;
    const reset = new URL(url, "https://example.com").searchParams;
    expect(reset.get("sort")).toBe("-rankScore");
    expect(reset.has("cursor")).toBe(false);
  });

  it("retains selected empty columns when no items match", async () => {
    navigation.params = new URLSearchParams("columns=done,needs_design");
    vi.mocked(fetchWorkItems).mockResolvedValue({
      items: [],
      pageInfo: { endCursor: null, hasMore: false },
    });
    mount();
    await waitFor(() =>
      expect(
        screen.getByText("0 items on this page · 0 visible cards"),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByText("No items on this page")).toHaveLength(2),
    );
    expect(screen.getAllByText("done").length).toBeGreaterThan(0);
  });
  it("moves through 21 results and back without prefetching", async () => {
    const items = fixture.filter((_, i) => i % 2 === 0).slice(0, 21);
    vi.mocked(fetchWorkItems).mockImplementation(async (params) => {
      const cursor = params.get("cursor");
      const offset = cursor === "p2" ? 10 : cursor === "p3" ? 20 : 0;
      return {
        items: items.slice(offset, offset + 10),
        pageInfo: {
          endCursor: offset === 0 ? "p2" : offset === 10 ? "p3" : null,
          hasMore: offset < 20,
        },
      };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <WorkDashboardView />
      </QueryClientProvider>
    );
    const result = render(element());
    await waitFor(() =>
      expect(
        screen.getByText("10 items on this page · 10 visible cards"),
      ).toBeInTheDocument(),
    );
    expect(fetchWorkItems).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    navigation.params = new URLSearchParams("cursor=p2");
    result.rerender(element());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "task.0020: Work item 20" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    navigation.params = new URLSearchParams("cursor=p3");
    result.rerender(element());
    await waitFor(() =>
      expect(
        screen.getByText("1 items on this page · 1 visible cards"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith(
      "/work?cursor=p2",
      { scroll: false },
    );
    navigation.params = new URLSearchParams("cursor=p2"); result.rerender(element());
    await waitFor(() => expect(screen.getByRole("button", { name: "task.0020: Work item 20" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/work", { scroll: false });
  });

  it("does not combine an edited filter with an old cursor", async () => {
    navigation.params = new URLSearchParams("cursor=p2");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const element = () => (
      <QueryClientProvider client={client}>
        <WorkDashboardView />
      </QueryClientProvider>
    );
    const result = render(element());
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(/Search id/), {
      target: { value: "target" },
    });
    expect(
      vi
        .mocked(fetchWorkItems)
        .mock.calls.every(
          ([params]) => !params.get("text") || !params.get("cursor"),
        ),
    ).toBe(true);
    navigation.params = new URLSearchParams(
      "q=target&rankMin=4&rankMax=&status=all&sort=-rankScore",
    );
    result.rerender(element());
    await waitFor(() =>
      expect(
        vi
          .mocked(fetchWorkItems)
          .mock.calls.some(
            ([params]) =>
              params.get("text") === "target" && !params.get("cursor"),
          ),
      ).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });
  it("does not combine an edited sort with an old cursor", async () => {
    navigation.params = new URLSearchParams("cursor=p2");
    mount();
    await waitFor(() => expect(fetchWorkItems).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Rank/ }));
    expect(vi.mocked(fetchWorkItems).mock.calls.every(([params]) => params.get("sortDirection") !== "asc" || !params.get("cursor"))).toBe(true);
    expect(navigation.router.replace).toHaveBeenCalledWith(expect.not.stringContaining("cursor="), { scroll: false });
  });

  it("does not intercept Enter on the page-size control", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "task.0000: Work item 0" })).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Items per page" }), { key: "Enter" });
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitemcheckbox");
    document.body.appendChild(menuItem);
    fireEvent.keyDown(menuItem, { key: "Enter" });
    menuItem.remove();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

});
