// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `useEpochsPage.test`
 * Purpose: Prove the epoch page reads a bounded number of endpoints on first load, whatever the epoch count, and reads a past epoch only when asked.
 * Scope: React Query hooks with HTTP mocked; no database or chain access.
 * Invariants: BOUNDED_FIRST_LOAD, CURRENT_NOT_BLOCKED_BY_PAST, ONE_PAGE_LIFECYCLE_READ, LIFECYCLE_FAILURE_IS_UNKNOWN.
 * Side-effects: mocked HTTP
 * Links: src/features/governance/hooks/useEpochsPage.ts, bug.0068, task.5039
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EpochDto } from "@/features/governance/lib/compose-epoch";
import {
  partitionEpochs,
  useEpochsPage,
  useEpochView,
  useSettlementLifecycle,
} from "@/features/governance/hooks/useEpochsPage";

import { epochTestProvider } from "./epoch-test-provider";

afterEach(() => vi.restoreAllMocks());

function epochDto(
  id: number,
  status: EpochDto["status"],
  periodEnd = `2026-08-${String(10 + id).padStart(2, "0")}T00:00:00.000Z`
): EpochDto {
  return {
    id: String(id),
    status,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd,
    weightConfig: { "github:pr_merged": 1000 },
    poolTotalCredits: null,
  };
}

function wrapperFor(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      epochTestProvider(children)
    );
}

function mockApi(epochs: readonly EpochDto[], lifecycleOk = true) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (body: unknown) =>
      ({ ok: true, json: async () => body }) as Response;
    if (url.includes("settlement-lifecycle")) {
      return lifecycleOk
        ? ok({
            publicationEvidence: "matched",
            liveRevision: null,
            latestRevision: null,
            epochs: [],
          })
        : ({
            ok: false,
            status: 503,
            statusText: "Unavailable",
            text: async () => "rpc unavailable",
          } as Response);
    }
    if (url.includes("/user-projections")) {
      return ok({
        items: [],
        total: 0,
        totalUnits: "0",
        totalPoints: "0",
        totalReceiptCount: 0,
        unresolvedCount: 0,
        unresolvedActivities: [],
        unresolvedActivityTotal: 0,
        limit: 200,
        offset: 0,
      });
    }
    if (url.includes("/activity")) return ok({ events: [] });
    if (url.includes("/claimants")) {
      return ok({
        epochId: "x",
        items: [],
        total: 0,
        totalUnits: "0",
        totalPoints: "0",
        totalReceiptCount: 0,
        unresolvedCount: 0,
        unresolvedActivities: [],
        unresolvedActivityTotal: 0,
        limit: 200,
        offset: 0,
      });
    }
    const current = epochs.find((epoch) => epoch.status === "open") ?? null;
    return ok({
      current,
      epochs: epochs.filter((epoch) => epoch !== current),
      total: epochs.length - (current ? 1 : 0),
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const paths = (fetchMock: ReturnType<typeof mockApi>): string[] =>
  fetchMock.mock.calls.map(([url]) => String(url));

describe("partitionEpochs", () => {
  it("prefers the open epoch and lists the rest newest period first", () => {
    const epochs = [
      epochDto(1, "review"),
      epochDto(2, "finalized"),
      epochDto(3, "open"),
      epochDto(4, "review"),
    ];
    const { current, pastEpochs } = partitionEpochs(epochs);
    expect(current?.id).toBe("3");
    expect(pastEpochs.map((e) => e.id)).toEqual(["4", "2", "1"]);
  });

  it("falls back to the first review epoch when none is open", () => {
    const { current, pastEpochs } = partitionEpochs([
      epochDto(1, "finalized"),
      epochDto(2, "review"),
    ]);
    expect(current?.id).toBe("2");
    expect(pastEpochs.map((e) => e.id)).toEqual(["1"]);
  });
});

describe("epoch page reads", () => {
  it("first load reads the list and the current epoch only, however many epochs exist", async () => {
    const epochs = [
      ...Array.from({ length: 14 }, (_, i) => epochDto(i + 1, "review")),
      epochDto(15, "open"),
    ];
    const fetchMock = mockApi(epochs);
    const wrapper = wrapperFor();

    const { result } = renderHook(
      () => {
        const list = useEpochsPage();
        const lifecycle = useSettlementLifecycle();
        const current = list.data?.current;
        // Mirrors the page: the current epoch's view, and a collapsed past row's cache-only read.
        const currentView = useEpochView(current ?? epochDto(0, "open"), {
          enabled: Boolean(current),
        });
        const collapsedRow = useEpochView(epochDto(1, "review"), {
          enabled: false,
        });
        return { list, lifecycle, currentView, collapsedRow };
      },
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current.currentView.isSuccess).toBe(true)
    );
    await waitFor(() => expect(result.current.lifecycle.isSuccess).toBe(true));

    expect(result.current.list.data?.pastEpochs).toHaveLength(14);
    expect(paths(fetchMock).sort()).toEqual(
      [
        "/api/v1/attribution/epochs/15/activity?limit=200&offset=0",
        "/api/v1/attribution/epochs/15/user-projections?view=summary&limit=200&offset=0",
        "/api/v1/attribution/epochs?view=overview&limit=200&offset=0",
        "/api/v1/attribution/settlement-lifecycle",
      ].sort()
    );
    expect(result.current.collapsedRow.data).toBeUndefined();
  });

  it("composes a past epoch only when its row is opened", async () => {
    const fetchMock = mockApi([epochDto(1, "finalized")]);
    const wrapper = wrapperFor();
    const past = epochDto(1, "finalized");

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useEpochView(past, { enabled: open }),
      { wrapper, initialProps: { open: false } }
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ open: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(paths(fetchMock).sort()).toEqual([
      "/api/v1/attribution/epochs/1/activity?limit=200&offset=0",
      "/api/v1/attribution/epochs/1/claimants?view=summary&limit=200&offset=0",
    ]);
    expect(result.current.data?.contributors).toEqual([]);
  });

  it("marks one failed lifecycle read unknown without hiding epochs", async () => {
    const fetchMock = mockApi([], false);
    const wrapper = wrapperFor();

    const { result } = renderHook(
      () => ({ list: useEpochsPage(), lifecycle: useSettlementLifecycle() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.lifecycle.isSuccess).toBe(true));

    expect(result.current.list.data).toEqual({
      current: null,
      pastEpochs: [],
      historyTotal: 0,
    });
    expect(result.current.lifecycle.data).toEqual({
      publicationEvidence: "unknown",
      liveRevision: null,
      latestRevision: null,
      epochs: [],
    });
    expect(
      paths(fetchMock).filter((url) => url.includes("settlement-lifecycle"))
    ).toHaveLength(1);
  });
});
