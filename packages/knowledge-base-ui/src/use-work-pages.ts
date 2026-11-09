// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-work-pages`
 * Purpose: The table's bounded cursor page and the dashboard's open-work list, as package hooks over node-supplied fetchers (task.0055).
 * Scope: Client hooks plus pure page-size and cursor-stack helpers. The node owns its endpoint, auth, and URL/history navigation (where the cursor and stack are stored); these own the request shape, budgets, query keys and retry policy.
 * Invariants:
 *   - ONE_PAGE_PER_VIEW: `useWorkTablePage` issues exactly one `fetchPage` per (query, page size, cursor); nothing walks cursors.
 *   - PAGE_SIZE_CLAMPED: any requested page size is clamped to 1..`WORK_SUMMARY_PAGE_MAX`; an invalid one falls back to `WORK_TABLE_PAGE_DEFAULT`, so `?pageSize=500` asks for 100 rows, never a 400.
 *   - EMPTY_PAGE_CAN_CONTINUE: `nextCursor` is set whenever the page reports `hasMore` with an `endCursor`, even when it holds no items (a capped text scan).
 *   - HISTORY_BOUNDED: the previous-page stack keeps at most `WORK_PAGE_HISTORY_MAX` cursors.
 *   - OPEN_WORK_IS_ONE_PAGE: `useOpenWork` issues one request for at most `limit` (default 5, max `WORK_SUMMARY_PAGE_MAX`) active-status summaries sorted by rank, descending.
 *   - HOST_QUERY_CLIENT: hosts render these under a `QueryClientProvider` (`@tanstack/react-query` 5).
 * Side-effects: IO (through the injected fetchers)
 * Links: task.0055, packages/knowledge-base-ui/src/use-work-board.ts
 * @public
 */

"use client";

import {
  WORK_SUMMARY_PAGE_MAX,
  type WorkItemSummary,
  type WorkSummaryPage,
  type WorkSummaryQuery,
  workSummaryQueryToSearchParams,
} from "@cogni/work-items";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { shouldRetryWorkBoardRequest } from "./use-work-board.js";
import { ACTIVE_WORK_STATUSES } from "./work-board-controls.js";

/** Page sizes a table offers. */
export const WORK_TABLE_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
/** Table page size when the request names none or an invalid one. */
export const WORK_TABLE_PAGE_DEFAULT = 10;
/** Most previous-page cursors a table remembers. */
export const WORK_PAGE_HISTORY_MAX = 20;
/** Rows the dashboard's open-work list shows by default. */
export const WORK_OPEN_ITEMS_DEFAULT = 5;

/** Clamp a requested page size (for example a URL value) into budget. */
export function clampWorkPageSize(value: unknown): number {
  const size = Math.trunc(Number(value));
  if (!Number.isFinite(size) || size < 1) return WORK_TABLE_PAGE_DEFAULT;
  return Math.min(size, WORK_SUMMARY_PAGE_MAX);
}

/** The previous-page stack after moving forward from `currentCursor` ("" = first page). */
export function workPageStackNext(
  stack: readonly string[],
  currentCursor: string,
): string[] {
  return [...stack, currentCursor].slice(-WORK_PAGE_HISTORY_MAX);
}

/** The cursor and stack after moving back one page, or `null` on the first page. */
export function workPageStackPrevious(
  stack: readonly string[],
): { readonly cursor: string; readonly stack: string[] } | null {
  if (stack.length === 0) return null;
  return { cursor: stack[stack.length - 1] ?? "", stack: stack.slice(0, -1) };
}

export type WorkPageFetcher = (
  params: URLSearchParams,
  signal: AbortSignal,
) => Promise<WorkSummaryPage>;

export interface UseWorkTablePageOptions {
  /** Filters, sort and search; its own `limit` and `cursor` are ignored. */
  readonly query: WorkSummaryQuery;
  /** Requested rows per page; clamped by `clampWorkPageSize`. */
  readonly pageSize: unknown;
  /** The current page's cursor; "" or absent is the first page. */
  readonly cursor?: string | undefined;
  readonly fetchPage: WorkPageFetcher;
  readonly enabled?: boolean;
  readonly staleTime?: number;
}

export interface UseWorkTablePageResult {
  readonly items: readonly WorkItemSummary[];
  readonly page: WorkSummaryPage | undefined;
  readonly isLoading: boolean;
  readonly error: unknown;
  /** The clamped page size actually requested. */
  readonly pageSize: number;
  /** The cursor of the next page, when one exists (also for an empty capped page). */
  readonly nextCursor: string | null;
  /** The encoded request without its cursor: stable across pages of one listing. */
  readonly listingKey: string;
}

const NO_ITEMS: readonly WorkItemSummary[] = [];

/** One bounded table page for the current cursor. */
export function useWorkTablePage({
  query,
  pageSize,
  cursor,
  fetchPage,
  enabled = true,
  staleTime = 30_000,
}: UseWorkTablePageOptions): UseWorkTablePageResult {
  const limit = clampWorkPageSize(pageSize);
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  const listingKey = workSummaryQueryToSearchParams({
    ...filters,
    limit,
  }).toString();
  const requestKey = useMemo(() => {
    const params = new URLSearchParams(listingKey);
    if (cursor) params.set("cursor", cursor);
    return params.toString();
  }, [listingKey, cursor]);
  const result = useQuery({
    queryKey: ["work-summaries-page", requestKey],
    queryFn: ({ signal }) => fetchPage(new URLSearchParams(requestKey), signal),
    enabled,
    staleTime,
    retry: shouldRetryWorkBoardRequest,
  });
  const pageInfo = result.data?.pageInfo;
  return {
    items: result.data?.items ?? NO_ITEMS,
    page: result.data,
    isLoading: enabled && result.isLoading,
    error: result.error,
    pageSize: limit,
    nextCursor:
      pageInfo?.hasMore && pageInfo.endCursor ? pageInfo.endCursor : null,
    listingKey,
  };
}

export interface UseOpenWorkOptions {
  readonly fetchPage: WorkPageFetcher;
  /** Rows to show; clamped to 1..`WORK_SUMMARY_PAGE_MAX`. Default 5. */
  readonly limit?: number;
  /** Statuses counted as open. Default `ACTIVE_WORK_STATUSES`. */
  readonly statuses?: readonly string[];
  readonly staleTime?: number;
}

export interface UseOpenWorkResult {
  readonly items: readonly WorkItemSummary[];
  readonly isLoading: boolean;
  readonly error: unknown;
}

/** The request `useOpenWork` sends: open statuses, rank descending, one small page. */
export function openWorkSearchParams(
  limit: number = WORK_OPEN_ITEMS_DEFAULT,
  statuses: readonly string[] = ACTIVE_WORK_STATUSES,
): URLSearchParams {
  return workSummaryQueryToSearchParams({
    statuses: [...statuses],
    sortBy: "rankScore",
    sortDirection: "desc",
    limit,
  });
}

/** The top open work items by rank, in one bounded request. */
export function useOpenWork({
  fetchPage,
  limit = WORK_OPEN_ITEMS_DEFAULT,
  statuses = ACTIVE_WORK_STATUSES,
  staleTime = 30_000,
}: UseOpenWorkOptions): UseOpenWorkResult {
  const key = openWorkSearchParams(limit, statuses).toString();
  const result = useQuery({
    queryKey: ["work-open-items", key],
    queryFn: ({ signal }) => fetchPage(new URLSearchParams(key), signal),
    staleTime,
    retry: shouldRetryWorkBoardRequest,
  });
  const rows = Number(new URLSearchParams(key).get("limit"));
  const items = useMemo(
    () => (result.data?.items ?? NO_ITEMS).slice(0, rows),
    [result.data, rows],
  );
  return { items, isLoading: result.isLoading, error: result.error };
}
