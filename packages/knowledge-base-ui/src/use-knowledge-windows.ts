// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-knowledge-windows`
 * Purpose: The bounded data path of knowledge Browse and the graph overview: one metadata window at a time, explicit body-search windows, and explicit Continue / Previous / Retry / Restart (task.0059).
 * Scope: Client hooks over node-supplied fetchers. The node owns its endpoint, auth and SSR seed; these own the request encoding, cache keys, window cursor/history and the revision prompt. Use the host's React Query client.
 * Invariants:
 *   - ONE_WINDOW_PER_VIEW: opening Browse, or changing its filters or sort, issues at most one metadata request (none when `initialData` seeds the default first window). Nothing walks cursors or prefetches.
 *   - SUBMIT_ONLY_SEARCH: a body search (`query.search`) runs only when its window identity changes through intent (submit, Continue, Previous, Restart, a filter or sort change). Focus, reconnect, remount and cache invalidation never replay a body window.
 *   - EMPTY_WINDOW_CAN_CONTINUE: `canNext` follows `nextCursor`, so an empty capped search window still offers Continue.
 *   - WINDOW_RESETS_ON_QUERY_CHANGE: a different filter, sort or search starts at the first window with an empty history.
 *   - ABORT_ON_CHANGE: each request gets React Query's `AbortSignal`; leaving a window (new query or unmount) aborts its in-flight request.
 *   - NO_AUTOMATIC_RETRY: a failed window stays failed until `retry()` re-requests the same cursor.
 *   - HOST_QUERY_CLIENT: rendered under the host's `QueryClientProvider`.
 * Side-effects: IO (through the injected fetchers)
 * Links: task.0059, packages/knowledge-base-ui/src/knowledge-browse-query.ts
 * @public
 */

"use client";

import type {
  KnowledgeBrowsePage,
  KnowledgeBrowseQuery,
} from "@cogni/knowledge-store/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  KNOWLEDGE_QUERY_PREFIX,
  type KnowledgeReadOperation,
  type KnowledgeWindowFetcher,
  knowledgeBrowseKey,
  knowledgeOverviewKey,
  knowledgeQueryToSearchParams,
  parseKnowledgeQuery,
} from "./knowledge-browse-query.js";
import { useKnowledgeRevision } from "./use-knowledge-revision.js";

export interface UseKnowledgeWindowsResult {
  /** The current window, or (overview only) the last loaded one while the next loads or fails. */
  readonly page: KnowledgeBrowsePage | undefined;
  /** The current window's query, cursor included. */
  readonly query: KnowledgeBrowseQuery;
  readonly isFetching: boolean;
  readonly error: unknown;
  /** True until the current window has been read: never "no matches". */
  readonly awaitingFirstRead: boolean;
  readonly isSearch: boolean;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly next: () => void;
  readonly previous: () => void;
  readonly retry: () => void;
  /** Return to the first window and adopt its revision. */
  readonly restart: () => void;
  readonly restartNeeded: boolean;
}

export interface UseKnowledgeBrowseOptions {
  /** Filters, sort and optional body search. Its own `cursor` is ignored: the hook owns the window. */
  readonly query: KnowledgeBrowseQuery;
  readonly fetchBrowse: KnowledgeWindowFetcher;
  /** SSR seed for the default first window (no filters or search, newest first). */
  readonly initialData?: KnowledgeBrowsePage | undefined;
  /** Default 30s. */
  readonly staleTime?: number;
  /** Default `["knowledge"]`. */
  readonly queryKeyPrefix?: readonly unknown[];
}

export interface UseKnowledgeOverviewOptions {
  readonly fetchOverview: KnowledgeWindowFetcher;
  /** SSR seed for the first overview window. */
  readonly initialData?: KnowledgeBrowsePage | undefined;
  readonly staleTime?: number;
  readonly queryKeyPrefix?: readonly unknown[];
}

interface WindowState {
  readonly listing: string;
  readonly cursor: string | undefined;
  readonly history: readonly (string | undefined)[];
}

const DEFAULT_LISTING = JSON.stringify(parseKnowledgeQuery({}, "browse"));

/** Layout effect would warn on the server; refs are mirrored after commit. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

function useKnowledgeWindows(
  operation: KnowledgeReadOperation,
  baseQuery: KnowledgeBrowseQuery,
  fetchWindow: KnowledgeWindowFetcher,
  initialData: KnowledgeBrowsePage | undefined,
  staleTime: number,
  prefix: readonly unknown[],
): UseKnowledgeWindowsResult {
  const client = useQueryClient();
  const { cursor: _ignored, ...listingQuery } = baseQuery;
  const parsedListing = parseKnowledgeQuery(listingQuery, operation);
  const listing = JSON.stringify(parsedListing);
  const [windowState, setWindowState] = useState<WindowState>({
    listing,
    cursor: undefined,
    history: [],
  });
  // A different listing starts over at its first window.
  const current =
    windowState.listing === listing
      ? windowState
      : { listing, cursor: undefined, history: [] };
  const query: KnowledgeBrowseQuery = {
    ...listingQuery,
    ...(current.cursor ? { cursor: current.cursor } : {}),
  };
  const isSearch = operation === "browse" && Boolean(query.search);
  const key =
    operation === "browse"
      ? knowledgeBrowseKey(query, prefix)
      : knowledgeOverviewKey(query, prefix);
  const fetcher = useLatest(fetchWindow);
  const seeded =
    !current.cursor &&
    (operation === "overview" || listing === DEFAULT_LISTING);

  const result = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      fetcher.current(knowledgeQueryToSearchParams(query, operation), signal),
    staleTime,
    // A body window runs only through `refetch` from explicit intent below.
    enabled: !isSearch,
    retry: false,
    refetchOnWindowFocus: !isSearch,
    refetchOnReconnect: !isSearch,
    refetchOnMount: !isSearch,
    retryOnMount: !isSearch,
    initialData: seeded ? initialData : undefined,
  });

  const revision = useKnowledgeRevision(result.data?.revision, prefix);
  const { acknowledgeRestart } = revision;
  const restartPending = useRef(false);
  const { refetch } = result;
  const bodyIntent = isSearch ? JSON.stringify(key) : "";
  useEffect(() => {
    // Only a changed search window initiates body work.
    if (bodyIntent)
      void refetch({ cancelRefetch: false }).then((read) => {
        if (restartPending.current && read.data && !read.error) {
          acknowledgeRestart(read.data.revision);
          restartPending.current = false;
        }
      });
  }, [bodyIntent, refetch, acknowledgeRestart]);

  // Overview keeps drawing the last loaded window while the next one loads or fails.
  const [lastPage, setLastPage] = useState<KnowledgeBrowsePage | undefined>(
    seeded ? initialData : undefined,
  );
  useEffect(() => {
    if (result.data) setLastPage(result.data);
  }, [result.data]);
  const page =
    operation === "overview" ? (result.data ?? lastPage) : result.data;

  const latest = useLatest({ current, page: result.data, query, operation });
  const go = useCallback(
    (next: WindowState) => setWindowState(next),
    [],
  );
  const next = useCallback(() => {
    const { current: window, page: data } = latest.current;
    if (!data?.nextCursor) return;
    go({
      listing: window.listing,
      cursor: data.nextCursor,
      history: [...window.history, window.cursor],
    });
  }, [go, latest]);
  const previous = useCallback(() => {
    const { current: window } = latest.current;
    if (window.history.length === 0) return;
    go({
      listing: window.listing,
      cursor: window.history[window.history.length - 1],
      history: window.history.slice(0, -1),
    });
  }, [go, latest]);
  const restart = useCallback(() => {
    const { current: window, query: currentQuery, operation: op } =
      latest.current;
    const first = { listing: window.listing, cursor: undefined, history: [] };
    if (op === "browse" && currentQuery.search && window.cursor) {
      // The first search window re-runs through the body-intent effect.
      restartPending.current = true;
      go(first);
      return;
    }
    go(first);
    const { cursor: _cursor, ...firstQuery } = currentQuery;
    void client
      .fetchQuery({
        queryKey:
          op === "browse"
            ? knowledgeBrowseKey(firstQuery, prefix)
            : knowledgeOverviewKey(firstQuery, prefix),
        queryFn: ({ signal }) =>
          fetcher.current(knowledgeQueryToSearchParams(firstQuery, op), signal),
        staleTime: 0,
      })
      .then((firstPage) => acknowledgeRestart(firstPage.revision))
      .catch(() => undefined);
  }, [go, latest, client, prefix, fetcher, acknowledgeRestart]);

  return {
    page,
    query,
    isFetching: result.isFetching,
    error: result.error,
    awaitingFirstRead:
      result.isFetching || (!result.data && !result.error),
    isSearch,
    canPrevious: current.history.length > 0 && !result.isFetching,
    canNext:
      Boolean(result.data?.nextCursor) && !result.isFetching && !result.error,
    next,
    previous,
    retry: () => void refetch(),
    restart,
    restartNeeded: revision.restartNeeded,
  };
}

/** Bounded Browse: metadata windows plus explicit body-search windows. */
export function useKnowledgeBrowse({
  query,
  fetchBrowse,
  initialData,
  staleTime = 30_000,
  queryKeyPrefix = KNOWLEDGE_QUERY_PREFIX,
}: UseKnowledgeBrowseOptions): UseKnowledgeWindowsResult {
  return useKnowledgeWindows(
    "browse",
    query,
    fetchBrowse,
    initialData,
    staleTime,
    queryKeyPrefix,
  );
}

const OVERVIEW_QUERY: KnowledgeBrowseQuery = {};

/** Bounded graph overview: one metadata window of at most 20 atoms at a time. */
export function useKnowledgeOverview({
  fetchOverview,
  initialData,
  staleTime = 30_000,
  queryKeyPrefix = KNOWLEDGE_QUERY_PREFIX,
}: UseKnowledgeOverviewOptions): UseKnowledgeWindowsResult {
  return useKnowledgeWindows(
    "overview",
    OVERVIEW_QUERY,
    fetchOverview,
    initialData,
    staleTime,
    queryKeyPrefix,
  );
}
