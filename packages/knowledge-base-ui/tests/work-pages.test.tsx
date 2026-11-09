// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-pages.test`
 * Purpose: Pins the table page and open-work hooks: one bounded request each, a clamped page size, an empty capped page that still continues, a bounded previous-page stack, and the 4xx/5xx retry policy (task.0055).
 * Scope: Package exports with injected fetchers under a real React Query client. No node app code.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0055, ../src/use-work-pages.ts
 */

// @vitest-environment jsdom

import type { WorkSummaryPage } from "@cogni/work-items";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_WORK_STATUSES,
  clampWorkPageSize,
  shouldRetryWorkBoardRequest,
  useOpenWork,
  useWorkTablePage,
  WORK_PAGE_HISTORY_MAX,
  workPageStackNext,
  workPageStackPrevious,
} from "../src/index.js";

const STAMP = "2026-11-01T00:00:00Z";
const summary = (id: string) => ({
  id,
  title: id,
  type: "task",
  status: "needs_implement",
  labels: [],
  createdAt: STAMP,
  updatedAt: STAMP,
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useWorkTablePage", () => {
  it("clamps an over-budget page size and issues exactly one request", async () => {
    const fetchPage = vi.fn(
      async (): Promise<WorkSummaryPage> => ({
        items: [summary("task.1")],
        pageInfo: { endCursor: null, hasMore: false },
      }),
    );
    const { result } = renderHook(
      () =>
        useWorkTablePage({
          query: { statuses: ["needs_implement"], sortBy: "rankScore", limit: 7, cursor: "ignored" },
          pageSize: "500",
          fetchPage,
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const params = fetchPage.mock.calls[0]?.[0] as unknown as URLSearchParams;
    expect(params.get("limit")).toBe("100");
    expect(params.has("cursor")).toBe(false);
    expect(params.get("statuses")).toBe("needs_implement");
    expect(result.current.pageSize).toBe(100);
    expect(result.current.nextCursor).toBeNull();
    expect(result.current.listingKey).not.toContain("cursor");
  });

  it("sends the current cursor and continues past an empty capped page", async () => {
    const fetchPage = vi.fn(
      async (): Promise<WorkSummaryPage> => ({
        items: [],
        pageInfo: { endCursor: "next-1", hasMore: true, rowsScanned: 1000 },
      }),
    );
    const { result } = renderHook(
      () => useWorkTablePage({ query: { text: "rare" }, pageSize: 10, cursor: "c-0", fetchPage }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.nextCursor).toBe("next-1"));
    expect(result.current.items).toEqual([]);
    const params = fetchPage.mock.calls[0]?.[0] as unknown as URLSearchParams;
    expect(params.get("cursor")).toBe("c-0");
    expect(params.get("limit")).toBe("10");
  });

  it("clamps page sizes and bounds the previous-page stack", () => {
    expect(clampWorkPageSize("500")).toBe(100);
    expect(clampWorkPageSize("25")).toBe(25);
    expect(clampWorkPageSize("")).toBe(10);
    expect(clampWorkPageSize("abc")).toBe(10);
    expect(clampWorkPageSize(0)).toBe(10);
    let stack: string[] = [];
    for (let page = 0; page < 30; page++) stack = workPageStackNext(stack, `c${page}`);
    expect(stack).toHaveLength(WORK_PAGE_HISTORY_MAX);
    expect(stack.at(-1)).toBe("c29");
    expect(workPageStackPrevious(["", "c1"])).toEqual({ cursor: "c1", stack: [""] });
    expect(workPageStackPrevious([])).toBeNull();
  });
});

describe("useOpenWork", () => {
  it("asks once for at most five open items by rank", async () => {
    const fetchPage = vi.fn(
      async (): Promise<WorkSummaryPage> => ({
        items: ["a", "b", "c", "d", "e", "f"].map((id) => summary(`task.${id}`)),
        pageInfo: { endCursor: null, hasMore: false },
      }),
    );
    const { result } = renderHook(() => useOpenWork({ fetchPage }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const params = fetchPage.mock.calls[0]?.[0] as unknown as URLSearchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("statuses")).toBe(ACTIVE_WORK_STATUSES.join(","));
    expect(params.get("sortBy")).toBe("rankScore");
    expect(params.get("sortDirection")).toBe("desc");
  });
});

describe("shouldRetryWorkBoardRequest", () => {
  it("retries network failures and 5xx up to three times, never 4xx", () => {
    expect(shouldRetryWorkBoardRequest(0, new TypeError("fetch failed"))).toBe(true);
    expect(shouldRetryWorkBoardRequest(0, { status: 503 })).toBe(true);
    expect(shouldRetryWorkBoardRequest(3, { status: 503 })).toBe(false);
    expect(shouldRetryWorkBoardRequest(0, { status: 400 })).toBe(false);
    expect(shouldRetryWorkBoardRequest(0, { status: 404 })).toBe(false);
  });
});
