// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-work-board`
 * Purpose: The board's bounded data path: one request for the first page of every visible column, then one request per column "Load more" (task.0055).
 * Scope: Client hook over node-supplied fetchers. The node owns its endpoint and auth; this hook owns the query keys, cursors, appending and cancellation. Uses the host's React Query client, so warm navigation hits cache.
 * Invariants:
 *   - ONE_BOARD_REQUEST: opening the board, or changing its query or visible columns, issues exactly one `fetchBoard`, asking for `WORK_BOARD_COLUMN_PAGE` rows per column. A `query.statuses` filter narrows the columns read to those that are also visible; other visible columns render empty without a request.
 *   - ONE_PAGE_PER_CLICK: `loadMore(status)` issues exactly one `fetchPage` for that column's `endCursor`, with the identical query plus `statuses=[status]`, and appends it. Nothing loops cursors or prefetches.
 *   - ABORT_EVERY_REQUEST: both fetchers receive an `AbortSignal`. A key change, a fresh board result or unmount aborts every in-flight page, and appended pages never survive their board.
 *   - NO_DUPLICATE_CARDS: an appended item already in the column is dropped.
 * Side-effects: IO (through the injected fetchers)
 * Links: task.0055, packages/work-items/src/board.ts
 * @public
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import {
  WORK_BOARD_COLUMN_PAGE,
  type WorkBoardColumns,
  type WorkItemSummary,
  type WorkSummaryPage,
  type WorkSummaryPageInfo,
  type WorkSummaryQuery,
  workSummaryQueryToSearchParams,
} from "@cogni/work-items";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkBoardColumnState } from "./work-board.js";

export interface UseWorkBoardOptions {
  /** Filters, sort and search. `limit` and `cursor` are ignored: the board owns its page window. `statuses` narrows the visible columns that are read. */
  readonly query: WorkSummaryQuery;
  /** Visible columns, in display order. */
  readonly statuses: readonly string[];
  /** First page of every visible column in one request. `params` is the shared query codec's encoding. */
  readonly fetchBoard: (
    params: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<WorkBoardColumns>;
  /** One further page of one column. `params` carries `statuses=<status>` and the column cursor. */
  readonly fetchPage: (
    params: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<WorkSummaryPage>;
  /** How long a loaded board stays fresh in the React Query cache. Default 30s. */
  readonly staleTime?: number;
}

export interface UseWorkBoardResult {
  readonly columns: readonly WorkBoardColumnState<WorkItemSummary>[];
  /** Every loaded card, in column order. */
  readonly items: readonly WorkItemSummary[];
  /** True until the first board page of the current query arrives. */
  readonly isLoading: boolean;
  /** The board request's error, if it failed. */
  readonly error: unknown;
  /** The last "Load more" error, cleared by the next successful page. */
  readonly pageError: unknown;
  readonly loadMore: (status: string) => void;
}

interface Appended {
  readonly generation: string;
  readonly columns: Readonly<
    Record<
      string,
      { items: readonly WorkItemSummary[]; pageInfo: WorkSummaryPageInfo }
    >
  >;
  readonly loading: Readonly<Record<string, boolean>>;
  readonly error: unknown;
}

const fresh = (generation: string): Appended => ({
  generation,
  columns: {},
  loading: {},
  error: undefined,
});

export function useWorkBoard({
  query,
  statuses,
  fetchBoard,
  fetchPage,
  staleTime = 30_000,
}: UseWorkBoardOptions): UseWorkBoardResult {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  const visibleKey = [...new Set(statuses)].join(",");
  const visible = useMemo(
    () => (visibleKey ? visibleKey.split(",") : []),
    [visibleKey],
  );
  // A status filter narrows which visible columns are read; the rest show empty.
  const filteredKey = (query.statuses ?? []).join(",");
  const fetched = useMemo(
    () =>
      filteredKey
        ? visible.filter((status) => filteredKey.split(",").includes(status))
        : visible,
    [visible, filteredKey],
  );
  const boardKey = workSummaryQueryToSearchParams({
    ...filters,
    statuses: fetched,
    limit: WORK_BOARD_COLUMN_PAGE,
  }).toString();

  const board = useQuery({
    queryKey: ["work-board", boardKey],
    queryFn: ({ signal }) => fetchBoard(new URLSearchParams(boardKey), signal),
    enabled: fetched.length > 0,
    staleTime,
    // Pages the person has loaded must not vanish under a background refetch.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Appended pages belong to exactly one board result.
  const generation = `${boardKey}@${board.dataUpdatedAt}`;
  const [appended, setAppended] = useState<Appended>(() => fresh(generation));
  const current = appended.generation === generation ? appended : null;

  const latest = useRef({ generation, appended: fresh(generation) });
  latest.current = { generation, appended: current ?? fresh(generation) };
  const data = useRef(board.data);
  data.current = board.data;
  const inputs = useRef({ fetchPage, filters });
  inputs.current = { fetchPage, filters };
  const controllers = useRef(new Map<string, AbortController>());

  // A new board key or result, or unmount, cancels every page still in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the trigger.
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    [generation],
  );

  const loadMore = useCallback((status: string) => {
    const gen = latest.current.generation;
    const state = latest.current.appended;
    if (state.loading[status] === true) return;
    const base = data.current?.columns.find(
      (column) => column.status === status,
    );
    const pageInfo = state.columns[status]?.pageInfo ?? base?.pageInfo;
    if (!pageInfo?.hasMore || !pageInfo.endCursor) return;

    const commit = (change: (previous: Appended) => Appended) => {
      if (latest.current.generation !== gen) return;
      const next = change(latest.current.appended);
      latest.current = { generation: gen, appended: next };
      setAppended(next);
    };
    const controller = new AbortController();
    controllers.current.set(status, controller);
    commit((previous) => ({
      ...previous,
      loading: { ...previous.loading, [status]: true },
    }));
    const params = workSummaryQueryToSearchParams({
      ...inputs.current.filters,
      statuses: [status],
      limit: WORK_BOARD_COLUMN_PAGE,
      cursor: pageInfo.endCursor,
    });
    inputs.current.fetchPage(params, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        controllers.current.delete(status);
        commit((previous) => {
          const earlier = previous.columns[status]?.items ?? [];
          const known = new Set(
            [
              ...(data.current?.columns.find((c) => c.status === status)
                ?.items ?? []),
              ...earlier,
            ].map((item) => item.id),
          );
          return {
            ...previous,
            columns: {
              ...previous.columns,
              [status]: {
                items: [
                  ...earlier,
                  ...page.items.filter((item) => !known.has(item.id)),
                ],
                pageInfo: page.pageInfo,
              },
            },
            loading: { ...previous.loading, [status]: false },
            error: undefined,
          };
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        controllers.current.delete(status);
        commit((previous) => ({
          ...previous,
          loading: { ...previous.loading, [status]: false },
          error,
        }));
      },
    );
  }, []);

  const columns = useMemo(
    () =>
      visible.map((status): WorkBoardColumnState<WorkItemSummary> => {
        const first = board.data?.columns.find(
          (column) => column.status === status,
        );
        const more = current?.columns[status];
        const pageInfo = more?.pageInfo ?? first?.pageInfo;
        return {
          status,
          items: [...(first?.items ?? []), ...(more?.items ?? [])],
          hasMore: Boolean(pageInfo?.hasMore && pageInfo.endCursor),
          isLoadingMore: current?.loading[status] === true,
        };
      }),
    [visible, board.data, current],
  );
  const items = useMemo(
    () => columns.flatMap((column) => column.items),
    [columns],
  );

  return {
    columns,
    items,
    isLoading: fetched.length > 0 && board.isLoading,
    error: board.error,
    pageError: current?.error,
    loadMore,
  };
}
