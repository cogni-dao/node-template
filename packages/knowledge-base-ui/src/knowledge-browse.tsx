// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-browse`
 * Purpose: The whole bounded knowledge Browse capability: table, header sort and exact filters, column picker, submit-only body search, explicit window navigation (Previous / Next or Continue search / Retry window / Restart) and the revision-changed prompt (task.0059).
 * Scope: Client view over `useKnowledgeBrowse` and a node-supplied fetcher. The node supplies its endpoint, auth, SSR seed, known filter values and what a row selection opens (e.g. its detail sheet).
 * Invariants:
 *   - DRAFT_IS_NOT_SEARCH: typing edits only the draft. Submit (button or Enter) commits a changed draft that `KnowledgeBrowseQuerySchema` accepts; a rejected draft shows the schema's issue and sends nothing; an unchanged draft is not replayed.
 *   - ONE_WINDOW_PER_VIEW and INTENT_ONLY_SEARCH (see `useKnowledgeBrowse`); the view mounts with no committed search, so body reads follow only submit.
 *   - CLEAR_RETURNS_TO_FIRST_WINDOW: "Clear filters" empties filters and search and always returns to window 1.
 *   - OPTIONS_FROM_NODE: `entryTypeOptions` / `sourceTypeOptions` are required, because the canonical lists live in the store root (not its browser-safe `/contracts`); nodes pass `EntryTypeSchema.options` / `SourceTypeSchema.options`.
 *   - EXACT_TOTAL: the status line states the window's position against the store's exact filtered total ("Showing 1–20 of 5,046"); a search window states the candidates it examined and its matches; a capped empty search window says to continue, not "no matches". The page size comes from `@cogni/knowledge-store/contracts`.
 *   - HOST_QUERY_CLIENT: rendered under the host's `QueryClientProvider`.
 * Side-effects: IO (through the injected fetcher)
 * Links: task.0059, packages/knowledge-base-ui/src/use-knowledge-windows.ts
 * @public
 */

"use client";

import {
  KNOWLEDGE_BROWSE_PAGE_SIZE,
  type KnowledgeBrowsePage,
  type KnowledgeSummary,
} from "@cogni/knowledge-store/contracts";
import {
  type ColumnFiltersState,
  getCoreRowModel,
  type OnChangeFn,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";

import { DataTable, DataTableColumnsPicker } from "./data-table.js";
import {
  createKnowledgeBrowseColumns,
  DEFAULT_KNOWLEDGE_SORT,
  type KnowledgeBrowseColumnsOptions,
  knowledgeBrowseTableStateToQuery,
} from "./knowledge-browse-columns.js";
import {
  type KnowledgeWindowFetcher,
  knowledgeQueryIssue,
} from "./knowledge-browse-query.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { useKnowledgeBrowse } from "./use-knowledge-windows.js";

export interface KnowledgeBrowseProps extends KnowledgeBrowseColumnsOptions {
  readonly fetchBrowse: KnowledgeWindowFetcher;
  /** SSR seed for the default first window. */
  readonly initialData?: KnowledgeBrowsePage | undefined;
  /** A row was chosen; the node opens its own detail by exact id. */
  readonly onSelect?: (entry: KnowledgeSummary) => void;
  readonly staleTime?: number;
  readonly queryKeyPrefix?: readonly unknown[];
  /** Rendered after the window controls (e.g. the node's detail sheet). */
  readonly children?: ReactNode;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * The window's position against the exact filtered total: "Showing 21–40 of
 * 5,046". A search window states which candidates it examined and how many
 * matched ("Searched 1–20 of 5,046 candidates · 3 matches").
 */
export function knowledgeWindowSummary(
  page: KnowledgeBrowsePage | undefined,
  windowIndex: number,
  isSearch: boolean,
  isFetching: boolean,
): string {
  if (isFetching) return "Loading window…";
  if (!page) return "Window not loaded";
  const first = windowIndex * KNOWLEDGE_BROWSE_PAGE_SIZE + 1;
  const covered = isSearch ? page.scannedRows : page.items.length;
  const range =
    covered > 0 ? `${count(first)}–${count(first + covered - 1)}` : "0";
  const more = page.nextCursor
    ? isSearch
      ? " · continuation available"
      : " · more available"
    : " · end of results";
  return isSearch
    ? `Searched ${range} of ${count(page.total)} candidates · ${count(page.items.length)} matches${more}`
    : `Showing ${range} of ${count(page.total)}${more}`;
}

export function KnowledgeBrowse({
  fetchBrowse,
  initialData,
  onSelect,
  staleTime,
  queryKeyPrefix,
  children,
  entryTypeOptions,
  sourceTypeOptions,
  domainOptions,
  entryHref,
}: KnowledgeBrowseProps): ReactElement {
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_KNOWLEDGE_SORT);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [searchIssue, setSearchIssue] = useState<string | null>(null);
  const query = knowledgeBrowseTableStateToQuery({
    sorting,
    columnFilters,
    search,
  });
  const browse = useKnowledgeBrowse({
    query,
    fetchBrowse,
    initialData,
    ...(staleTime !== undefined && { staleTime }),
    ...(queryKeyPrefix && { queryKeyPrefix }),
  });
  const columns = useMemo(
    () =>
      createKnowledgeBrowseColumns({
        entryTypeOptions,
        sourceTypeOptions,
        ...(domainOptions && { domainOptions }),
        ...(entryHref && { entryHref }),
      }),
    [entryTypeOptions, sourceTypeOptions, domainOptions, entryHref],
  );
  const onSortingChange: OnChangeFn<SortingState> = (update) =>
    setSorting((previous) => {
      const next = typeof update === "function" ? update(previous) : update;
      return next.length ? next : DEFAULT_KNOWLEDGE_SORT;
    });
  const table = useReactTable({
    data: (browse.page?.items ?? []) as KnowledgeSummary[],
    columns,
    state: { sorting, columnFilters, columnVisibility },
    onSortingChange,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    meta: { isLoading: browse.awaitingFirstRead },
  });
  const { page, isSearch } = browse;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            // The store's query schema decides what a valid search is.
            const issue = draft ? knowledgeQueryIssue({ search: draft }) : null;
            setSearchIssue(issue);
            if (!issue && draft !== search) setSearch(draft);
          }}
        >
          <Input
            aria-label="Search knowledge"
            aria-invalid={searchIssue !== null}
            placeholder="Search id, title, content, domain, type…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-9 w-full sm:w-72"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {searchIssue && (
            <span role="alert" className="text-destructive text-xs">
              Search: {searchIssue}
            </span>
          )}
        </form>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setColumnFilters([]);
            setDraft("");
            setSearch("");
            setSearchIssue(null);
            browse.reset();
          }}
        >
          Clear filters
        </Button>
        <Button variant="outline" size="sm" onClick={browse.restart}>
          Restart
        </Button>
        <div className="ml-auto">
          <DataTableColumnsPicker table={table} />
        </div>
      </div>
      {browse.restartNeeded && (
        <p role="status">
          Knowledge changed. Restart to begin a new live traversal.
        </p>
      )}
      {page && (
        <p className="text-muted-foreground text-xs">
          Observed revision: {page.revision} · live read
        </p>
      )}
      <p className="text-muted-foreground text-xs" role="status">
        {knowledgeWindowSummary(
          page,
          browse.windowIndex,
          isSearch,
          browse.isFetching,
        )}
      </p>
      {Boolean(browse.error) && (
        <p role="alert">
          Failed to load this window.{" "}
          <button type="button" className="underline" onClick={browse.retry}>
            Retry window
          </button>
        </p>
      )}
      <DataTable
        table={table}
        isLoading={browse.awaitingFirstRead}
        {...(onSelect && { onRowClick: onSelect })}
        emptyMessage={
          page?.nextCursor
            ? "No matches in this window. Continue search to examine more entries."
            : "No entries match these filters."
        }
      />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!browse.canPrevious}
          onClick={browse.previous}
        >
          Previous window
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!browse.canNext}
          onClick={browse.next}
        >
          {isSearch ? "Continue search" : "Next window"}
        </Button>
      </div>
      {children}
    </>
  );
}
