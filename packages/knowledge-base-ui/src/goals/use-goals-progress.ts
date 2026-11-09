// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (use-goals-progress)
 * Purpose: The one goal-progress read the board and a node's tab badge share, so both observe the same cached reading.
 * Scope: Client hook over the injected `GoalsClient`. `poll: true` (the board) refreshes every 30 s only while the page is visible; `poll: false` (a badge) reads once per freshness window, never on focus.
 * Invariants:
 *   - ONE_CACHE_ENTRY: board and badge use the same query key, so one failed or fresh read is seen by both.
 *   - POLL_ONLY_WHILE_MOUNTED: the interval belongs to the mounted observer and never runs in a background tab (`refetchIntervalInBackground: false`).
 *   - HOST_QUERY_CLIENT: render under the host's `QueryClientProvider` (`@tanstack/react-query` 5).
 * Side-effects: IO (through the injected client)
 * Links: ./client.ts, ./goals-board.tsx
 * @public
 */

"use client";

import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";

import { useGoalsHost } from "./context.js";

export const GOALS_POLL_MS = 30_000;
export const GOALS_QUERY_KEY = ["goals", "progress"] as const;

export function goalsProgressKey(prefix: readonly unknown[] = []) {
  return [...prefix, ...GOALS_QUERY_KEY] as const;
}
export function metricHistoryKey(
  prefix: readonly unknown[],
  metricId: string,
  from: string,
  step: string
) {
  return [...prefix, "goals", "history", metricId, from, step] as const;
}
export function metricEvidenceKey(
  prefix: readonly unknown[],
  metricId: string,
  observationId: string | null
) {
  return [...prefix, "metric", "evidence", metricId, observationId] as const;
}

export interface UseGoalsProgressOptions {
  /** SSR seed with the exact wire shape of GET /api/v1/metrics/goals. */
  readonly initialData?: GoalsProgress | undefined;
  /** Default true. */
  readonly poll?: boolean;
  /** Default true. */
  readonly enabled?: boolean;
}

export function useGoalsProgress({
  initialData,
  poll = true,
  enabled = true,
}: UseGoalsProgressOptions = {}) {
  const { client, queryKeyPrefix } = useGoalsHost();
  return useQuery({
    queryKey: goalsProgressKey(queryKeyPrefix),
    queryFn: ({ signal }) => client.fetchGoals(signal),
    enabled,
    initialData,
    ...(poll
      ? {
          staleTime: 15_000,
          refetchInterval: GOALS_POLL_MS,
          refetchIntervalInBackground: false,
          retry: 2,
        }
      : { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false }),
  });
}
