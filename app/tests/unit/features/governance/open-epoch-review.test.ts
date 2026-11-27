// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `open-epoch-review.test`
 * Purpose: Prove opening review posts once and refreshes governance reads.
 * Scope: Mutation and invalidation only; lifecycle readiness belongs to the read-only rail.
 * Invariants: SERVER_AUTHORITY, GOVERNANCE_READS_REFRESH_AFTER_MUTATION.
 * Side-effects: mocked HTTP
 * Links: src/features/governance/hooks/useOpenEpochReview.ts, work item bug.5042
 * @public
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOpenEpochReview } from "@/features/governance/hooks/useOpenEpochReview";

import { epochTestProvider } from "./epoch-test-provider";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useOpenEpochReview", () => {
  it("posts once and invalidates governance data after success", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ epoch: { id: "epoch-7", status: "review" } }),
    } as Response);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, epochTestProvider(children));
    const { result } = renderHook(() => useOpenEpochReview(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync("epoch-7");
    });

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v1/attribution/epochs/epoch-7/review",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      })
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["governance", "epoch-scope", expect.any(String)],
        predicate: expect.any(Function),
      })
    );
    // Exercise the actual production filter with real scoped Query instances.
    const filters = invalidate.mock.calls[0]?.[0];
    expect(filters?.queryKey).toHaveLength(3);
    const prefix = filters?.queryKey ?? [];
    const parents = [
      [...prefix, "epochs", "list", 0],
      [...prefix, "epochs", "view", "15", "open", 0],
      [...prefix, "finish-epoch", {}],
      [...prefix, "epochs", "15", "review-subject-overrides"],
    ];
    const excluded = [
      [...prefix, "epochs", "15", "open", "contributor", "user:a", "G", 0],
      [
        ...prefix,
        "epochs",
        "15",
        "review",
        "contributor",
        "identity:github:x",
        "G",
        50,
      ],
      ["governance", "epoch-scope", "another-scope", "epochs", "view", "15"],
      ["unrelated", "epochs", "view", "15"],
    ];
    for (const key of [...parents, ...excluded])
      queryClient.setQueryData(key, { fixture: true });
    // The separate call expectation verifies active-only refetch; here inspect scope/exclusion for every cached key.
    expect(
      queryClient
        .getQueryCache()
        .findAll({ ...filters, type: "all" })
        .map((query) => query.queryKey)
    ).toEqual(parents);
  });
});
