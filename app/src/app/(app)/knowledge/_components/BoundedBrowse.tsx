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
import { useState } from "react";
import { Button, Input } from "@/components";
import { browseKey, fetchBrowse } from "../_api/fetchBrowse";
import { summaryColumns } from "./columns";
import { KnowledgeSelection } from "./KnowledgeSelection";

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
    retry: false,
    initialData:
      !cursor &&
      !search &&
      !filters.length &&
      selectedSort?.id === "createdAt" &&
      selectedSort.desc
        ? initialData
        : undefined,
  });
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
            reset();
            const { cursor: _cursor, ...first } = query;
            void queryClient.invalidateQueries({ queryKey: browseKey(first) });
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
