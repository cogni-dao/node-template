// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/view`
 * Purpose: Work dashboard composing the published work board capability
 *          (`@cogni/knowledge-base-ui`) and the ReUI DataGrid over one TanStack
 *          filter, sort, pagination, and detail-navigation model.
 * Scope: Route composition. Fetches data via React Query and maps table state
 *        to URL params; board controls, columns and cards come from the package.
 * Invariants:
 *   - BOARD_FROM_PACKAGE — board mode renders only `WorkBoardToolbar` and
 *     `WorkBoardView` from `@cogni/knowledge-base-ui` (task.0044).
 *   - HEADER_OWNS_SORT_AND_FILTER — sort + per-column facet filter live in
 *     the package column headers (see `_components/columns.tsx`).
 *   - SINGLE_COLUMNS_TOGGLE — table visibility lives in one toolbar button
 *     (`DataGridColumnVisibility`), not on every column dropdown.
 *   - URL_DRIVEN_STATE — filters / sort / search persist in URL params.
 *   - CONTRACTS_ARE_TRUTH — types derived from `WorkItemSummary`.
 * Side-effects: IO (fetches summary pages and full item detail)
 * Links: [WorkPage](./page.tsx), [fetchWorkItems](./_api/fetchWorkItems.ts)
 * @public
 */

"use client";

import {
  ACTIVE_WORK_STATUSES,
  WORK_STATUSES,
  WorkBoardToolbar,
  WorkBoardView,
  type WorkTableMeta,
  workItemGlobalFilterFn,
} from "@cogni/knowledge-base-ui";
import type { WorkItemSummary } from "@cogni/node-contracts";
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
import { useQuery } from "@tanstack/react-query";
import {
  type ColumnFiltersState,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { Columns3, List, Settings2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/startup";

import { type WorkIntent, useWorkNavigation } from "./WorkNavigationBoundary";
import { fetchWorkItem, fetchWorkItems } from "./_api/fetchWorkItems";
import { columns } from "./_components/columns";
import { WorkDetailSheet } from "./_components/WorkDetailSheet";
import { WorkGoalLink } from "./_components/WorkKanban";
import {
  MOBILE_HIDDEN_COLUMNS,
  WORK_MOBILE_QUERY,
  WorkResponsiveTable,
} from "./_components/WorkResponsiveTable";
import {
  workItemHref,
  workListHref,
  workViewHref,
} from "./_lib/workItemNavigation";

const ALL_STATUSES = WORK_STATUSES;
const ACTIVE_STATUSES = ACTIVE_WORK_STATUSES;
const EMPTY_ITEMS: WorkItemSummary[] = [];
const HISTORY_STORAGE_KEY = "work-page-history";

function readFilters(searchParams: URLSearchParams): ColumnFiltersState {
  const filters: ColumnFiltersState = [];
  const typeParam = searchParams.get("type");
  if (typeParam) filters.push({ id: "type", value: typeParam.split(",") });
  const statusParam = searchParams.get("status");
  if (statusParam && statusParam !== "all") {
    filters.push({ id: "status", value: statusParam.split(",") });
  } else if (!statusParam) {
    filters.push({ id: "status", value: [...ACTIVE_STATUSES] });
  }
  const projectParam = searchParams.get("project");
  if (projectParam)
    filters.push({ id: "projectId", value: projectParam.split(",") });
  const numberParam = (key: string) => {
    const raw = searchParams.get(key);
    if (!raw?.trim()) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const rankRange = [numberParam("rankMin"), numberParam("rankMax")];
  if (rankRange.some((value) => value !== undefined)) {
    filters.push({ id: "rankScore", value: rankRange });
  }
  return filters;
}

function readSorting(searchParams: URLSearchParams): SortingState {
  const sortParam = searchParams.get("sort");
  if (sortParam) {
    const desc = sortParam.startsWith("-");
    const id = desc ? sortParam.slice(1) : sortParam;
    return [{ id, desc }];
  }
  return [{ id: "rankScore", desc: true }];
}

function readColumns(params: URLSearchParams): string[] {
  const value = params.get("columns");
  return value === null
    ? [...ACTIVE_STATUSES]
    : value
        .split(",")
        .filter((status) => ALL_STATUSES.includes(status));
}

function intentHref(intent: WorkIntent): string {
  return intent.itemId
    ? workItemHref(intent.itemId, intent.params)
    : workListHref(intent.params);
}

export function WorkDashboardView({
  selectedItemId,
}: {
  readonly selectedItemId?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const committedSearch = searchParams.toString();
  const actualHref = selectedItemId
    ? workItemHref(selectedItemId, searchParams)
    : workListHref(searchParams);
  const initialFilters = useMemo(
    () => readFilters(new URLSearchParams(committedSearch)),
    [committedSearch],
  );
  const initialSorting = useMemo(
    () => readSorting(new URLSearchParams(committedSearch)),
    [committedSearch],
  );
  const {
    desired, setDesired, columnVisibility, setColumnVisibility, history, setHistory,
    isNavigating, startNavigation, settledOperation, setSettledOperation,
    navigationLocked, setNavigationLocked, navigation,
  } = useWorkNavigation();
  const sorting = useMemo(() => readSorting(desired.params), [desired]);
  const columnFilters = useMemo(() => readFilters(desired.params), [desired]);
  const globalFilter = desired.params.get("q") ?? "";
  const visibleStatuses = readColumns(desired.params);
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    if (!window.matchMedia) { setIsMobile(false); return; }
    const media = window.matchMedia(WORK_MOBILE_QUERY);
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const tableColumnVisibility = useMemo(
    () =>
      isMobile
        ? { ...MOBILE_HIDDEN_COLUMNS, ...columnVisibility }
        : columnVisibility,
    [isMobile, columnVisibility],
  );
  const boardView = desired.params.get("view") !== "table";
  const pageSize = Number(searchParams.get("pageSize")) || 10;
  const cursor = searchParams.get("cursor") ?? "";
  const selectedItemQuery = useQuery({
    queryKey: ["work-item", selectedItemId],
    queryFn: ({ signal }) => fetchWorkItem(selectedItemId as string, signal),
    enabled: selectedItemId !== undefined,
    retry: false,
    staleTime: 30_000,
  });
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
  const { data, isLoading, error } = useQuery({
    queryKey: ["work-items", listParams.toString()],
    queryFn: ({ signal }) => fetchWorkItems(listParams, signal),
    staleTime: 30_000,
  });
  const items = data?.items ?? EMPTY_ITEMS;
  const dispatchNavigation = useCallback(
    (intent: WorkIntent, stack?: string[]) => {
      const owner = navigation.current;
      const to = intentHref(intent);
      if (owner.flight || isNavigating || to === owner.committed?.href) return;
      const flight = {
        id: ++owner.sequence,
        to,
        stack: stack ?? (intent.resetHistory ? [] : undefined),
        failed: false,
        committed: false,
      };
      owner.flight = flight;
      // A push belongs to this dispatch; later edits default to replacement.
      owner.desired = {
        ...owner.desired,
        method: "replace",
        resetHistory: false,
      };
      setNavigationLocked(true);
      startNavigation(() => {
        // This marker commits in this operation's transition lane. Unlike an old
        // isPending=false render it can also identify settlement without a URL change.
        setSettledOperation(flight.id);
        try {
          router[intent.method](to, { scroll: false });
        } catch {
          flight.failed = true;
        }
      });
    },
    [isNavigating, router, navigation, setNavigationLocked, setSettledOperation, startNavigation],
  );

  useEffect(() => {
    const owner = navigation.current;
    const flight = owner.flight;
    const previous = owner.committed;
    const reached = flight?.to === actualHref && !flight.failed;
    const external =
      previous !== null && actualHref !== previous.href && !reached;
    if (!previous || actualHref !== previous.href) {
      let stack =
        previous?.key === historyKey && previous.cursor === cursor
          ? previous.stack
          : [];
      if (reached) {
        stack =
          flight.stack ?? (previous?.key === historyKey ? previous.stack : []);
        flight.committed = true;
      } else if (stack !== previous?.stack) {
        try {
          // Retire older multi-record snapshots without depending on storage.
          for (const key of Object.keys(sessionStorage)) {
            if (key.startsWith("work-page-history:"))
              sessionStorage.removeItem(key);
          }
          const record = JSON.parse(
            sessionStorage.getItem(HISTORY_STORAGE_KEY) ?? "{}",
          );
          if (
            record?.key === historyKey &&
            record.cursor === cursor &&
            Array.isArray(record.history) &&
            record.history.length <= 20 &&
            record.history.every(
              (item: unknown) =>
                typeof item === "string" && item.length <= 2048,
            )
          )
            stack = record.history;
        } catch {
          /* Storage is optional. */
        }
      }
      owner.committed = { href: actualHref, key: historyKey, cursor, stack };
      setHistory(stack);
      if (reached) {
        try {
          sessionStorage.setItem(
            HISTORY_STORAGE_KEY,
            JSON.stringify({ key: historyKey, cursor, history: stack }),
          );
        } catch {
          /* Storage is optional. */
        }
      }
    }
    const settled = flight && settledOperation === flight.id && !isNavigating;
    if (external || flight?.failed || (settled && !flight.committed)) {
      // An external winner or abandoned request invalidates all its proposals.
      owner.flight = null;
      owner.desired = {
        params: new URLSearchParams(committedSearch),
        itemId: selectedItemId,
        method: "replace",
      };
      setDesired(owner.desired);
      setNavigationLocked(false);
    } else if (settled) {
      owner.flight = null;
      setNavigationLocked(false);
      if (intentHref(owner.desired) !== actualHref)
        dispatchNavigation(owner.desired);
    } else if (
      !owner.flight &&
      !isNavigating &&
      intentHref(owner.desired) !== actualHref
    ) {
      dispatchNavigation(owner.desired);
    }
  }, [
    actualHref,
    committedSearch,
    cursor,
    historyKey,
    isNavigating,
    settledOperation,
    selectedItemId,
    dispatchNavigation,
    navigation,
    setHistory,
    setDesired,
    setNavigationLocked,
  ]);

  const editIntent = useCallback(
    (update: (intent: WorkIntent) => WorkIntent) => {
      const owner = navigation.current;
      // Every updater reads the latest draft, including edits made in this tick.
      owner.desired = update({
        ...owner.desired,
        params: new URLSearchParams(owner.desired.params),
      });
      setDesired(owner.desired);
      dispatchNavigation(owner.desired);
    },
    [dispatchNavigation, navigation, setDesired],
  );

  const editList = (
    update: (state: {
      filters: ColumnFiltersState;
      sorting: SortingState;
      query: string;
    }) => void,
  ) => {
    editIntent((intent) => {
      const state = {
        filters: readFilters(intent.params),
        sorting: readSorting(intent.params),
        query: intent.params.get("q") ?? "",
      };
      update(state);
      const valuesFor = (id: string): readonly string[] => {
        const value = state.filters.find((filter) => filter.id === id)?.value;
        return Array.isArray(value) ? (value as string[]) : [];
      };
      const sort = state.sorting[0];
      const href = workViewHref(intent.itemId, intent.params, {
        type: valuesFor("type"),
        status: valuesFor("status"),
        project: valuesFor("projectId"),
        sort: sort ? `${sort.desc ? "-" : ""}${sort.id}` : null,
        query: state.query,
        rankRange: (state.filters.find((filter) => filter.id === "rankScore")
          ?.value as [number | undefined, number | undefined] | undefined) ?? [
          undefined,
          undefined,
        ],
      });
      return {
        ...intent,
        params: new URL(href, window.location.origin).searchParams,
        resetHistory: true,
      };
    });
  };

  const changePage = (action: "next" | "previous" | "restart") => {
    const owner = navigation.current;
    const committed = owner.committed;
    if (
      owner.flight ||
      isNavigating ||
      !committed ||
      committed.href !== actualHref ||
      intentHref(owner.desired) !== actualHref
    )
      return;
    let next = "";
    let stack: string[] = [];
    if (action === "next") {
      if (!(data?.pageInfo?.hasMore ?? Boolean(data?.nextCursor))) return;
      next = data?.pageInfo?.endCursor ?? data?.nextCursor ?? "";
      if (!next) return;
      stack = [...committed.stack, committed.cursor].slice(-20);
    } else if (action === "previous") {
      if (!committed.cursor || !committed.stack.length) return;
      next = committed.stack[committed.stack.length - 1] ?? "";
      stack = committed.stack.slice(0, -1);
    } else if (!committed.cursor) return;
    const params = new URLSearchParams(committedSearch);
    if (next) params.set("cursor", next);
    else params.delete("cursor");
    owner.desired = { params, itemId: selectedItemId, method: "replace" };
    setDesired(owner.desired);
    dispatchNavigation(owner.desired, stack);
  };

  const detailOpener = useRef<HTMLElement | null>(null);
  const workHeading = useRef<HTMLHeadingElement | null>(null);
  const openItem = useCallback(
    (item: WorkItemSummary) => {
      detailOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      editIntent((intent) => ({ ...intent, itemId: item.id, method: "push" }));
    },
    [editIntent],
  );
  const closeItem = useCallback(() => {
    editIntent((intent) => ({
      ...intent,
      itemId: undefined,
      method: "replace",
    }));
  }, [editIntent]);

  const table = useReactTable({
    getRowId: (item) => item.id,
    data: items,
    columns,
    meta: { isLoading } satisfies WorkTableMeta,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility: tableColumnVisibility,
    },
    onSortingChange: (updater) =>
      editList((state) => {
        state.sorting =
          typeof updater === "function" ? updater(state.sorting) : updater;
      }),
    onColumnFiltersChange: (updater) =>
      editList((state) => {
        state.filters =
          typeof updater === "function" ? updater(state.filters) : updater;
      }),
    onGlobalFilterChange: (updater) =>
      editList((state) => {
        state.query = functionalUpdate(updater, state.query);
      }),
    onColumnVisibilityChange: (updater) => {
      // Diff against the latest effective state so batched toggles compose;
      // only explicit differences from the viewport default become overrides.
      setColumnVisibility((previous) => {
        const base = isMobile ? { ...MOBILE_HIDDEN_COLUMNS, ...previous } : previous;
        const next = functionalUpdate(updater, base);
        const updated = { ...previous };
        for (const id of Object.keys(next)) {
          if ((next[id] ?? true) !== (base[id] ?? true)) updated[id] = next[id] ?? true;
        }
        return updated;
      });
    },
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    globalFilterFn: workItemGlobalFilterFn,
  });

  const rows = table.getRowModel().rows;
  const navigationRows = boardView
    ? rows.filter((row) => visibleStatuses.includes(row.original.status))
    : rows;
  const navigationKey = JSON.stringify([boardView, navigationRows.map((row) => row.id)]);

  const [focus, setFocus] = useState({ key: "", index: -1 });
  const focusedRowIndex = focus.key === navigationKey ? focus.index : -1;
  useEffect(() => {
    setFocus((previous) => previous.key === navigationKey ? previous : { key: navigationKey, index: -1 });
  }, [navigationKey]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement &&
          e.target.closest(
            "button, a, select, summary, [contenteditable=true], [role^=menuitem], [role=combobox], [role=checkbox], [role=option], [role=slider], [role=spinbutton]",
          ))
      )
        return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocus({ key: navigationKey, index: Math.min(focusedRowIndex + 1, navigationRows.length - 1) });
          break;
        case "k":
          e.preventDefault();
          setFocus({ key: navigationKey, index: navigationRows.length ? Math.max(focusedRowIndex - 1, 0) : -1 });
          break;
        case "Enter":
          if (focusedRowIndex >= 0 && focusedRowIndex < navigationRows.length) {
            const row = navigationRows[focusedRowIndex];
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
  }, [navigationRows, navigationKey, focusedRowIndex, selectedItemId, openItem, closeItem]);

  const setView = (view: "board" | "table") => {
    editIntent((intent) => {
      intent.params.set("view", view);
      return intent;
    });
  };

  return (
    <div className="flex flex-col gap-4 p-5 md:p-6">
      <h1 ref={workHeading} tabIndex={-1} className="font-semibold text-xl tracking-tight md:text-2xl">
        Work Dashboard
      </h1>

      <WorkBoardToolbar
        table={table}
        visibleStatuses={visibleStatuses}
        onVisibleStatusesChange={(updater) => {
          editIntent((intent) => {
            const next = functionalUpdate(updater, readColumns(intent.params));
            intent.params.set("columns", next.join(","));
            return intent;
          });
        }}
        showBoardColumns={boardView}
      >
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
              <Button disabled={isMobile === null} variant="outline" size="sm" className="h-9 gap-1.5">
                <Settings2 className="size-3.5" />
                Columns
              </Button>
            }
          />
        )}
      </WorkBoardToolbar>

      {error && (
        <p className="py-8 text-center text-destructive">
          Failed to load work items.
        </p>
      )}

      {boardView ? (
        <WorkBoardView
          table={table}
          visibleStatuses={visibleStatuses}
          isLoading={isLoading}
          onOpenItem={openItem}
          renderGoalLink={WorkGoalLink}
        />
      ) : (
        <DataGrid
          table={table}
          recordCount={table.getFilteredRowModel().rows.length}
          isLoading={isLoading}
          loadingMode="skeleton"
          onRowClick={openItem}
          tableLayout={{
            width: "fixed",
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
          <DataGridContainer className="overflow-x-auto">
            <WorkResponsiveTable table={table} overrides={columnVisibility} synced={isMobile !== null} isLoading={isLoading} skeletonRows={Math.min(pageSize, 100)} />
          </DataGridContainer>
        </DataGrid>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-4 text-sm">
        <span>
          {items.length} items on this page
          {boardView
            ? ` · ${items.filter((item) => visibleStatuses.includes(item.status)).length} visible cards`
            : ""}
        </span>
        <div className="flex flex-wrap gap-2">
          <Select
            value={String(Number(desired.params.get("pageSize")) || 10)}
            onValueChange={(value) => {
              editIntent((intent) => {
                intent.params.set("pageSize", value);
                intent.params.delete("cursor");
                return { ...intent, resetHistory: true };
              });
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
            onClick={() => changePage("restart")}
            disabled={navigationLocked || isNavigating || !cursor}
          >
            Restart
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => changePage("previous")}
            disabled={navigationLocked || isNavigating || !cursor || history.length === 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => changePage("next")}
            disabled={
              navigationLocked || isNavigating ||
              !(data?.pageInfo?.hasMore ?? Boolean(data?.nextCursor)) ||
              !(data?.pageInfo?.endCursor ?? data?.nextCursor)
            }
          >
            Next
          </Button>
        </div>
      </div>

      <WorkDetailSheet
        opener={detailOpener}
        fallback={workHeading}
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
