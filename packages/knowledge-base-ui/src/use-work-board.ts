// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-work-board`
 * Purpose: The board's bounded data path: one request for the first page of every visible column, then one request per column "Load more" (task.0055).
 * Scope: Client hook over node-supplied fetchers. The node owns its endpoint and auth; this hook owns the query keys, cursors, appending and cancellation. Uses the host's React Query client, so warm navigation hits cache.
 * Invariants:
 *   - ONE_BOARD_REQUEST: opening the board, or changing its query or visible columns, issues exactly one `fetchBoard`, asking for `WORK_BOARD_COLUMN_PAGE` rows per column. A `query.statuses` filter narrows the columns read to those that are also visible; other visible columns render empty without a request.
 *   - ONE_PAGE_PER_CLICK: `loadMore(status)` issues exactly one `fetchPage` for that column's `endCursor`, with the identical query plus `statuses=[status]`, and appends it. A `not_started` column (the board budget did not reach it) fetches its first page without a cursor. A capped text page may append nothing yet still carry a cursor. Nothing loops cursors or prefetches.
 *   - ABORT_EVERY_REQUEST: both fetchers receive an `AbortSignal`. A key change, a fresh board result or unmount aborts every in-flight page, and appended pages never survive their board.
 *   - NO_DUPLICATE_CARDS: an appended item already in the column is dropped.
 *   - RETRY_SERVER_FAILURES_ONLY: the board request retries (up to 3 times) only on a network failure or an HTTP 5xx; an error carrying a 4xx `status` is final. Fetchers attach the HTTP status as `error.status`.
 *   - HOST_QUERY_CLIENT: the host must render this hook under a `QueryClientProvider` (`@tanstack/react-query` 5).
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { WorkBoardColumnState } from "./work-board.js";

export interface UseWorkBoardOptions {
  /** Filters, sort and search. `limit` and `cursor` are ignored: the board owns its page window. `statuses` narrows the visible columns that are read. */
  readonly query: WorkSummaryQuery;
  /** Visible columns, in display order. */
  readonly statuses: readonly string[];
  /** First page of every visible column in one request. `params` is the shared query codec's encoding. Reject with an error carrying `status` (the HTTP status) so 4xx responses are not retried. */
  readonly fetchBoard: (
    params: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<WorkBoardColumns>;
  /** One further page of one column. `params` carries `statuses=<status>` and the column cursor. Reject with an error carrying `status` (the HTTP status). */
  readonly fetchPage: (
    params: URLSearchParams,
    signal: AbortSignal,
  ) => Promise<WorkSummaryPage>;
  /** How long a loaded board stays fresh in the React Query cache. Default 30s. */
  readonly staleTime?: number;
  /** Query key prefix, e.g. to scope or invalidate per node. Default `["work-board"]`. */
  readonly queryKeyPrefix?: readonly unknown[];
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

const BOARD_RETRIES = 3;

/** Layout effect on the client, plain effect on the server (no SSR warning). */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The HTTP status a fetcher attached to its error, if any. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error))
    return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

/**
 * React Query `retry` for board reads: retry a network failure or an HTTP 5xx
 * (for example a 503 while the store is busy), never a 4xx (bad filter or
 * stale cursor), which would fail identically.
 */
export function shouldRetryWorkBoardRequest(
  failureCount: number,
  error: unknown,
): boolean {
  const status = httpStatus(error);
  if (status !== undefined && status < 500) return false;
  return failureCount < BOARD_RETRIES;
}

const DEFAULT_BOARD_KEY: readonly unknown[] = ["work-board"];

interface Appended {
  readonly generation: string;
  readonly columns: Readonly<
    Record<
      string,
      {
        items: readonly WorkItemSummary[];
        pageInfo: WorkSummaryPageInfo;
        /** Rows scanned by the appended pages (the board page's count is separate). */
        rowsScanned: number;
      }
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
  queryKeyPrefix = DEFAULT_BOARD_KEY,
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
    queryKey: [...queryKeyPrefix, boardKey],
    queryFn: ({ signal }) => fetchBoard(new URLSearchParams(boardKey), signal),
    enabled: fetched.length > 0,
    staleTime,
    retry: shouldRetryWorkBoardRequest,
    // Pages the person has loaded must not vanish under a background refetch.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Appended pages belong to exactly one board result.
  const generation = `${boardKey}@${board.dataUpdatedAt}`;
  const [appended, setAppended] = useState<Appended>(() => fresh(generation));
  const current = appended.generation === generation ? appended : null;

  const latest = useRef({ generation, appended: current ?? fresh(generation) });
  const data = useRef(board.data);
  const inputs = useRef({ fetchPage, filters });
  // Refs mirror the committed render for event handlers; written after commit,
  // never during render (concurrent renders may be discarded).
  useIsomorphicLayoutEffect(() => {
    latest.current = { generation, appended: current ?? fresh(generation) };
    data.current = board.data;
    inputs.current = { fetchPage, filters };
  });
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
    const appendedColumn = state.columns[status];
    const pageInfo = appendedColumn?.pageInfo ?? base?.pageInfo;
    // A column the board's budget did not reach loads its FIRST page (no cursor).
    const firstPage = !appendedColumn && base?.state === "not_started";
    if (!firstPage && (!pageInfo?.hasMore || !pageInfo.endCursor)) return;

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
      ...(!firstPage && pageInfo?.endCursor && { cursor: pageInfo.endCursor }),
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
                rowsScanned:
                  (previous.columns[status]?.rowsScanned ?? 0) +
                  (page.pageInfo.rowsScanned ?? 0),
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
        const notStarted = first?.state === "not_started" && !more;
        const rowsScanned =
          (first?.pageInfo.rowsScanned ?? 0) + (more?.rowsScanned ?? 0);
        return {
          status,
          items: [...(first?.items ?? []), ...(more?.items ?? [])],
          hasMore:
            notStarted || Boolean(pageInfo?.hasMore && pageInfo.endCursor),
          isLoadingMore: current?.loading[status] === true,
          notStarted,
          ...(rowsScanned > 0 && { rowsScanned }),
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
