// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Work dashboard with ReUI Kanban and DataGrid sharing one TanStack
 *          filter, sort, pagination, and detail-navigation model.
 * Scope: Presentation. Fetches data via React Query.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the column header dropdown (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search persist in URL params.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemDto`.
 * Side-effects: IO (fetches from /api/v1/work/items)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { VALID_TRANSITIONS } from "@cogni/work-items";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@cogni/node-ui-kit/shadcn/dropdown-menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@cogni/node-ui-kit/shadcn/select";
import {
  DataGrid,
  DataGridContainer,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid";
import { DataGridColumnVisibility } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-visibility";
import { DataGridTable } from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Columns3, List, Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@/components";

import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { columns } from "./_components/columns";
import { WorkItemDetail } from "./_components/WorkItemDetail";
import { WorkKanban } from "./_components/WorkKanban";
import {
  closeWorkItemPermalink,
  openWorkItemPermalink,
  workItemHref,
  workListHref,
  workViewHref,
} from "./_lib/workItemNavigation";

const ALL_STATUSES = [...VALID_TRANSITIONS.keys()];
const ACTIVE_STATUSES = ALL_STATUSES.filter(
  (status) => status !== "done" && status !== "cancelled",
);
const EMPTY_ITEMS: WorkItemDto[] = [];

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const boardView = searchParams.get("view") !== "table";

  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: () => fetchWorkItem(selectedItemId as string),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });

  const initialFilters = useMemo((): ColumnFiltersState => {
    const filters: ColumnFiltersState = [];
    const typeParam = searchParams.get("type");
    if (typeParam) filters.push({ id: "type", value: typeParam.split(",") });
    const statusParam = searchParams.get("status");
    if (statusParam && statusParam !== "all") {
      filters.push({ id: "status", value: statusParam.split(",") });
    } else if (!statusParam) {
      filters.push({ id: "status", value: ACTIVE_STATUSES });
    }
    const projectParam = searchParams.get("project");
    if (projectParam)
      filters.push({ id: "projectId", value: projectParam.split(",") });
    const numberParam = (key: string) => {
      const raw = searchParams.get(key);
      if (!raw?.trim()) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const rankRange =
      searchParams.has("rankMin") || searchParams.has("rankMax")
        ? [numberParam("rankMin"), numberParam("rankMax")]
        : [4, undefined];
    if (rankRange.some((value) => value !== undefined)) {
      filters.push({ id: "rankScore", value: rankRange });
    }
    return filters;
  }, [searchParams]);

  const initialSorting = useMemo((): SortingState => {
    const sortParam = searchParams.get("sort");
    if (sortParam) {
      const desc = sortParam.startsWith("-");
      const id = desc ? sortParam.slice(1) : sortParam;
      return [{ id, desc }];
    }
    return [{ id: "rankScore", desc: true }];
  }, [searchParams]);

  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnFilters, setColumnFilters] =
    useState<ColumnFiltersState>(initialFilters);
  const [globalFilter, setGlobalFilter] = useState(searchParams.get("q") ?? "");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [history, setHistory] = useState<string[]>([]);
  const [visibleStatuses, setVisibleStatuses] = useState<string[]>(() => {
    const param = searchParams.get("columns");
    return param === null
      ? [...ACTIVE_STATUSES]
      : param
        ? param.split(",")
        : [];
  });
  const pageSize = Number(searchParams.get("pageSize")) || 10;
  const cursor = searchParams.get("cursor") ?? "";
  const listParams = useMemo(() => {
    const params = new URLSearchParams({ limit: String(pageSize) });
    const values = (id: string) =>
      initialFilters.find((f) => f.id === id)?.value as string[] | undefined;
    for (const [id, key] of [
      ["type", "types"],
      ["status", "statuses"],
      ["projectId", "projectIds"],
    ] as const) {
      const value = values(id);
      if (value?.length) params.set(key, value.join(","));
    }
    const range = initialFilters.find((f) => f.id === "rankScore")?.value as
      | [number | undefined, number | undefined]
      | undefined;
    if (range?.[0] !== undefined) params.set("rankMin", String(range[0]));
    if (range?.[1] !== undefined) params.set("rankMax", String(range[1]));
    const sort = initialSorting[0];
    if (sort) {
      params.set("sortBy", sort.id);
      params.set("sortDirection", sort.desc ? "desc" : "asc");
    }
    const query = searchParams.get("q");
    if (query) params.set("text", query);
    if (cursor) params.set("cursor", cursor);
    return params;
  }, [initialFilters, initialSorting, searchParams, pageSize, cursor]);
  const historyKey = useMemo(() => {
    const p = new URLSearchParams(listParams);
    p.delete("cursor");
    return `work-page-history:${p}`;
  }, [listParams]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(historyKey) ?? "[]",
      );
      setHistory(
        Array.isArray(saved) &&
          saved.length <= 20 &&
          saved.every(
            (value) => typeof value === "string" && value.length <= 2048,
          )
          ? saved
          : [],
      );
    } catch {
      setHistory([]);
    }
    const param = searchParams.get("columns");
    setVisibleStatuses(
      param === null
        ? [...ACTIVE_STATUSES]
        : param
          ? param
              .split(",")
              .filter((status) =>
                ALL_STATUSES.includes(status as (typeof ALL_STATUSES)[number]),
              )
          : [],
    );
  }, [historyKey, searchParams]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items", listParams.toString()],
    queryFn: () => fetchWorkItems(listParams),
    staleTime: 30_000,
  });
  const items = data?.items ?? EMPTY_ITEMS;
  const changePage = (next: string, stack: string[]) => {
    const bounded = stack.slice(-20);
    setHistory(bounded);
    sessionStorage.setItem(historyKey, JSON.stringify(bounded));
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("cursor", next);
    else params.delete("cursor");
    router.replace(
      selectedItemId
        ? workItemHref(selectedItemId, params)
        : workListHref(params),
      { scroll: false },
    );
  };

  useEffect(() => {
    setSorting((previous) =>
      JSON.stringify(previous) === JSON.stringify(initialSorting)
        ? previous
        : initialSorting,
    );
    setColumnFilters((previous) =>
      JSON.stringify(previous) === JSON.stringify(initialFilters)
        ? previous
        : initialFilters,
    );
    setGlobalFilter(searchParams.get("q") ?? "");
  }, [initialFilters, initialSorting, searchParams]);

  const syncUrl = useCallback(
    (
      newFilters: ColumnFiltersState,
      newSorting: SortingState,
      newQuery: string,
    ) => {
      const valuesFor = (id: string): readonly string[] => {
        const value = newFilters.find((filter) => filter.id === id)?.value;
        return Array.isArray(value) ? (value as string[]) : [];
      };
      const sort = newSorting[0];
      sessionStorage.removeItem(historyKey);
      setHistory([]);
      router.replace(
        workViewHref(selectedItemId, searchParams, {
          type: valuesFor("type"),
          status: valuesFor("status"),
          project: valuesFor("projectId"),
          sort: sort ? `${sort.desc ? "-" : ""}${sort.id}` : null,
          query: newQuery,
          rankRange: (newFilters.find((filter) => filter.id === "rankScore")
            ?.value as
            | [number | undefined, number | undefined]
            | undefined) ?? [undefined, undefined],
        }),
        { scroll: false },
      );
    },
    [router, searchParams, selectedItemId, historyKey],
  );

  const openItem = useCallback(
    (item: WorkItemDto) => {
      openWorkItemPermalink(router, item.id, searchParams);
    },
    [router, searchParams],
  );

  const closeItem = useCallback(() => {
    closeWorkItemPermalink(router, searchParams);
  }, [router, searchParams]);

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting, columnFilters, globalFilter, columnVisibility },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
      syncUrl(columnFilters, next, globalFilter);
    },
    onColumnFiltersChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(columnFilters) : updater;
      setColumnFilters(next);
      syncUrl(next, sorting, globalFilter);
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: (row, _columnId, filterValue: string) => {
      const q = filterValue.toLowerCase();
      const d = row.original;
      return (
        d.id.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        d.labels.some((l: string) => l.toLowerCase().includes(q))
      );
    },
  });

  const rows = table.getRowModel().rows;

  const [focusedRowIndex, setFocusedRowIndex] = useState(-1);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement &&
          e.target.closest(
            "button, a, [contenteditable=true], [role=menuitem]",
          ))
      )
        return;
      if (rows.length === 0) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.min(prev + 1, rows.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusedRowIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
            const row = rows[focusedRowIndex];
            if (row) {
              e.preventDefault();
              openItem(row.original);
            }
          }
          break;
        case "/":
          e.preventDefault();
          document
            .querySelector<HTMLInputElement>("[data-search-input]")
            ?.focus();
          break;
        case "Escape":
          if (selectedItemId) {
            closeItem();
          }
          break;
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [rows, focusedRowIndex, selectedItemId, openItem, closeItem]);

  const hasActiveFilters = columnFilters.length > 0;

  const setView = (view: "board" | "table") => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    router.replace(
      selectedItemId
        ? workItemHref(selectedItemId, params)
        : workListHref(params),
      { scroll: false },
    );
  };

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-search-input
          className="h-9 w-full sm:w-56"
          placeholder="Search id, title, labels... ( / )"
          value={globalFilter}
          onChange={(e) => {
            setGlobalFilter(e.target.value);
            syncUrl(columnFilters, sorting, e.target.value);
          }}
        />
        {hasActiveFilters && (
          <button
            type="button"
            className="text-muted-foreground text-xs underline hover:text-foreground"
            onClick={() => {
              setColumnFilters([]);
              syncUrl([], sorting, globalFilter);
            }}
          >
            Clear filters
          </button>
        )}
        {boardView && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Board columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ALL_STATUSES.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={visibleStatuses.includes(status)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...visibleStatuses, status]
                      : visibleStatuses.filter((value) => value !== status);
                    setVisibleStatuses(next);
                    const params = new URLSearchParams(searchParams.toString());
                    params.set("columns", next.join(","));
                    router.replace(
                      selectedItemId
                        ? workItemHref(selectedItemId, params)
                        : workListHref(params),
                      { scroll: false },
                    );
                  }}
                >
                  {status.replace("needs_", "").replaceAll("_", " ")}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-2">
          <fieldset
            className="inline-flex min-w-0 rounded-lg border bg-muted/30 p-1"
            aria-label="Work view"
          >
            <Button
              variant={boardView ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={boardView}
              onClick={() => setView("board")}
            >
              <Columns3 className="size-3.5" />
              Board
            </Button>
            <Button
              variant={boardView ? "ghost" : "secondary"}
              size="sm"
              className="h-7 gap-1.5"
              aria-pressed={!boardView}
              onClick={() => setView("table")}
            >
              <List className="size-3.5" />
              Table
            </Button>
          </fieldset>
          {!boardView && (
            <DataGridColumnVisibility
              table={table}
              trigger={
                <Button variant="outline" size="sm" className="h-9 gap-1.5">
                  <Settings2 className="size-3.5" />
                  Columns
                </Button>
              }
            />
          )}
        </div>
      </div>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      <DataGrid
        table={table}
        recordCount={table.getFilteredRowModel().rows.length}
        isLoading={isLoading}
        loadingMode="skeleton"
        onRowClick={openItem}
        tableLayout={{
          headerSticky: true,
          headerBackground: true,
          rowBorder: true,
          dense: true,
        }}
        tableClassNames={{
          bodyRow: "cursor-pointer",
        }}
        emptyMessage="No work items found."
      >
        {boardView ? (
          <>
            <fieldset
              className="mb-4 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-2"
              aria-label="Board filters and sorting"
            >
              {table
                .getFlatHeaders()
                .filter((header) =>
                  [
                    "priority",
                    "rankScore",
                    "type",
                    "status",
                    "projectId",
                  ].includes(header.column.id),
                )
                .map((header) => (
                  <div key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </div>
                ))}
            </fieldset>
            <WorkKanban
              items={rows.map((row) => row.original)}
              statuses={visibleStatuses}
              isLoading={isLoading}
              onOpenItem={openItem}
            />
          </>
        ) : (
          <DataGridContainer className="overflow-x-auto">
            <DataGridTable />
          </DataGridContainer>
        )}
        <div className="flex items-center justify-between gap-3 pt-4 text-sm">
          <span>
            {items.length} items on this page
            {boardView
              ? ` · ${items.filter((item) => visibleStatuses.includes(item.status)).length} visible cards`
              : ""}
          </span>
          <div className="flex gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("pageSize", value);
                params.delete("cursor");
                setHistory([]);
                sessionStorage.removeItem(historyKey);
                router.replace(
                  selectedItemId
                    ? workItemHref(selectedItemId, params)
                    : workListHref(params),
                  { scroll: false },
                );
              }}
            >
              <SelectTrigger aria-label="Items per page" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changePage("", [])}
              disabled={!cursor}
            >
              Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                changePage(
                  history[history.length - 1] ?? "",
                  history.slice(0, -1),
                )
              }
              disabled={!cursor || history.length === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                changePage(
                  data?.pageInfo?.endCursor ?? data?.nextCursor ?? "",
                  [...history, cursor],
                )
              }
              disabled={
                !(data?.pageInfo?.hasMore ?? Boolean(data?.nextCursor)) ||
                !(data?.pageInfo?.endCursor ?? data?.nextCursor)
              }
            >
              Next
            </Button>
          </div>
        </div>
      </DataGrid>

      <WorkItemDetail
        item={selectedItemQuery.data ?? null}
        {...(selectedItemId !== undefined && { itemId: selectedItemId })}
        isLoading={selectedItemQuery.isLoading}
        error={selectedItemQuery.error}
        open={selectedItemId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeItem();
        }}
      />
    </div>
  );
}
