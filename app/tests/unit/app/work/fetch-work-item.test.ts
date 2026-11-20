// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// @vitest-environment jsdom

/** Covers the bounded list fetch. The item read is the package client (story.0085), proven in knowledge-base-ui. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWorkItems } from "@/app/(app)/work/_api/fetchWorkItems";

describe("fetchWorkItems bounded page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns one page without fetching the next", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "task.5000" }],
        pageInfo: { endCursor: "next", hasMore: true },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchWorkItems(
      new URLSearchParams({ limit: "10", rankMin: "4" }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.pageInfo?.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/work/summaries?limit=10&rankMin=4",
      expect.any(Object),
    );
  });
  it("reports server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "Work-item store is busy" }),
      }),
    );
    await expect(fetchWorkItems(new URLSearchParams())).rejects.toThrow(
      "Work-item store is busy",
    );
  });
});

it("passes cancellation to the list request", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  const signal = new AbortController().signal;
  await fetchWorkItems(new URLSearchParams(), signal);
  expect(fetchMock.mock.calls[0]?.[1].signal).toBe(signal);
  vi.unstubAllGlobals();
});

const uiRoute = vi.hoisted(() => ({ params: new URLSearchParams("view=table"), replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: uiRoute.replace, push: uiRoute.push }),
  usePathname: () => "/work",
  useParams: () => ({}),
  useSearchParams: () => uiRoute.params,
}));
vi.mock("@cogni/node-ui-kit/util/use-is-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components", async () => ({
  ...(await import("@cogni/node-ui-kit/shadcn/button")),
  ...(await import("@cogni/node-ui-kit/shadcn/input")),
}));
vi.mock("@/app/(app)/work/_components/WorkItemDetail", () => ({ WorkItemDetail: () => null }));

it("clears keyboard focus when an equal-sized cached page replaces its members", async () => {
  const React = await import("react");
  const { render, fireEvent, screen, waitFor, cleanup } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkNavigationBoundary } = await import("@/app/(app)/work/WorkNavigationBoundary");
  const { WorkDashboardView } = await import("@/app/(app)/work/view");
  const item = (id: string) => ({ id, title: id, type: "task", status: "needs_implement", labels: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [item(url.includes("cursor=next") ? "task.2" : "task.1")], pageInfo: { hasMore: false, endCursor: null } }) })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = () => React.createElement(QueryClientProvider, { client }, React.createElement(WorkNavigationBoundary, null, React.createElement(WorkDashboardView)));
  const view = render(element());
  await screen.findAllByText("task.1");
  fireEvent.keyDown(document, { key: "j" });
  uiRoute.params = new URLSearchParams("view=table&cursor=next");
  view.rerender(element());
  await screen.findAllByText("task.2");
  fireEvent.keyDown(document, { key: "Enter" });
  await waitFor(() => expect(uiRoute.push).not.toHaveBeenCalled());
  fireEvent.keyDown(document, { key: "j" });
  uiRoute.params = new URLSearchParams("view=table");
  view.rerender(element());
  await screen.findAllByText("task.1");
  fireEvent.keyDown(document, { key: "Enter" });
  expect(uiRoute.push).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "j" });
  fireEvent.keyDown(document, { key: "Enter" });
  await waitFor(() => expect(uiRoute.push).toHaveBeenCalledWith(expect.stringContaining("task.1"), expect.anything()));
  cleanup(); vi.unstubAllGlobals();
});
