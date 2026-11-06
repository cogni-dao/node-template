// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Global metadata windows and explicit twenty-candidate body search; no automatic traversal. */
"use client";
import type {
  KnowledgeBrowsePage,
  KnowledgeBrowseQuery,
} from "@cogni/node-contracts";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  getCoreRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@/components";
import { browseKey, fetchBrowse } from "../_api/fetchBrowse";
import { summaryColumns } from "./columns";
import { KnowledgeSelection } from "./KnowledgeSelection";
import { useBrowseRevision } from "./useBrowseRevision";

export function BoundedBrowse({
  initialData,
}: {
  readonly initialData?: KnowledgeBrowsePage | undefined;
}) {
  const queryClient = useQueryClient();
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [filters, setFilters] = useState<ColumnFiltersState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reset = () => {
    setCursor(undefined);
    setHistory([]);
  };
  const selectedSort = sorting[0];
  const query: KnowledgeBrowseQuery = {
    sort: (selectedSort?.id ?? "createdAt") as NonNullable<
      KnowledgeBrowseQuery["sort"]
    >,
    direction: selectedSort?.desc === false ? "asc" : "desc",
    domains:
      (filters.find((f) => f.id === "domain")?.value as string[] | undefined) ??
      [],
    entryTypes:
      (filters.find((f) => f.id === "entryType")?.value as
        | string[]
        | undefined) ?? [],
    sourceTypes:
      (filters.find((f) => f.id === "sourceType")?.value as
        | string[]
        | undefined) ?? [],
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const page = useQuery({
    queryKey: browseKey(query),
    queryFn: ({ signal }) => fetchBrowse(query, signal),
    staleTime: 30_000,
    // Cached body windows must not refetch through mutation invalidation.
    enabled: !search,
    retry: false,
    // Cached body windows resume only through explicit user intent. A remount
    // may reuse them, but must not silently repeat a stale or failed body read.
    refetchOnWindowFocus: !search,
    refetchOnReconnect: !search,
    refetchOnMount: !search,
    retryOnMount: !search,
    initialData:
      !cursor &&
      !search &&
      !filters.length &&
      selectedSort?.id === "createdAt" &&
      selectedSort.desc
        ? initialData
        : undefined,
  });
  const revision = useBrowseRevision(page.data?.revision);
  const restartPending = useRef(false);
  const bodyIntent = search ? JSON.stringify(browseKey(query)) : "";
  const { refetch } = page;
  const { acknowledgeRestart } = revision;
  useEffect(() => {
    // Only a changed user query/window initiates body work. Cache invalidation,
    // focus, reconnect and renders cannot replay a body window.
    if (bodyIntent)
      void refetch({ cancelRefetch: false }).then((result) => {
        if (restartPending.current && result.data && !result.error) {
          acknowledgeRestart(result.data.revision);
          restartPending.current = false;
        }
      });
  }, [bodyIntent, refetch, acknowledgeRestart]);
  const table = useReactTable({
    data: page.data?.items ?? [],
    columns: summaryColumns,
    state: { sorting, columnFilters: filters, columnVisibility: visibility },
    onSortingChange: (update) => {
      reset();
      setSorting((previous) => {
        const next = typeof update === "function" ? update(previous) : update;
        return next.length ? next : [{ id: "createdAt", desc: true }];
      });
    },
    onColumnFiltersChange: (update) => {
      reset();
      setFilters(update);
    },
    onColumnVisibilityChange: setVisibility,
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          maxLength={2000}
          aria-label="Search knowledge"
          placeholder="Search id, title, content, domain, type…"
          value={search}
          onChange={(e) => {
            reset();
            setSearch(e.target.value);
          }}
          className="h-9 w-full sm:w-72"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            reset();
            setFilters([]);
            setSearch("");
          }}
        >
          Clear filters
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (search && cursor) {
              restartPending.current = true;
              reset();
              return;
            }
            reset();
            const { cursor: _cursor, ...first } = query;
            void queryClient
              .fetchQuery({
                queryKey: browseKey(first),
                queryFn: ({ signal }) => fetchBrowse(first, signal),
                staleTime: 0,
              })
              .then((firstPage) =>
                revision.acknowledgeRestart(firstPage.revision)
              )
              .catch(() => undefined);
          }}
        >
          Restart
        </Button>
        <div className="ml-auto">
          <DataGridColumnVisibility
            table={table}
            trigger={
              <Button variant="outline" size="sm">
                Columns
              </Button>
            }
          />
        </div>
      </div>
      {revision.restartNeeded && (
        <p role="status">
          Knowledge changed. Restart to begin a new live traversal.
        </p>
      )}
      {page.data && (
        <p className="text-muted-foreground text-xs">
          Observed revision: {page.data.revision} · live read
        </p>
      )}
      <p className="text-muted-foreground text-xs" role="status">
        {page.isFetching
          ? "Loading window…"
          : page.data
            ? `${page.data.items.length} entries in this window${search ? ` · ${page.data.scannedRows} candidates searched` : ""}${page.data.nextCursor ? (search ? " · continuation available" : " · more available") : " · end of results"}`
            : "Window not loaded"}
      </p>
      {page.error && (
        <p role="alert">
          Failed to load this window.{" "}
          <button type="button" onClick={() => void page.refetch()}>
            Retry window
          </button>
        </p>
      )}
      <DataGrid
        table={table}
        recordCount={page.data?.items.length ?? 0}
        isLoading={page.isFetching}
        loadingMode="skeleton"
        onRowClick={(row) => setSelectedId(row.id)}
        tableLayout={{
          headerSticky: true,
          headerBackground: true,
          rowBorder: true,
          dense: true,
        }}
        tableClassNames={{ bodyRow: "cursor-pointer" }}
        emptyMessage={
          page.data?.nextCursor
            ? "No matches in this window. Continue search to examine more entries."
            : "No entries match these filters."
        }
      >
        <DataGridContainer className="overflow-x-auto">
          <DataGridTable />
        </DataGridContainer>
      </DataGrid>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!history.length || page.isFetching}
          onClick={() => {
            setCursor(history[history.length - 1]);
            setHistory(history.slice(0, -1));
          }}
        >
          Previous window
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!page.data?.nextCursor || page.isFetching || !!page.error}
          onClick={() => {
            if (page.data?.nextCursor) {
              setHistory([...history, cursor]);
              setCursor(page.data.nextCursor);
            }
          }}
        >
          {search ? "Continue search" : "Next window"}
        </Button>
      </div>
      <KnowledgeSelection id={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}
