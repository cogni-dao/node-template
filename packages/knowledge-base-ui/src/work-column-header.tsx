// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-column-header`
 * Purpose: Sortable column header for work and knowledge tables and the work board filter bar, plus the rank header that sorts descending first (task.0044, task.0059).
 * Scope: Context-free: reads only the TanStack `Column` (and, for disabling, the `Table`), so it renders inside any node's grid or the package's own tables. Markup and classes match the ReUI `DataGridColumnHeader` sort-only path; the filter popover matches the work board's facet controls.
 * Invariants:
 *   - SORT_CYCLE: a generic header cycles asc → desc → unsorted; the rank header follows the column's own `sortDescFirst`.
 *   - HEADER_OWNS_SORT_AND_FILTER: with a `filter`, a "Filter <title>" button beside the sort header opens a focus-trapping popover holding that filter, so every value is reachable with Tab and Enter (no menu label or typeahead swallows focus).
 *   - DISABLED_WHILE_EMPTY: callers decide `disabled`; `workHeaderDisabled` disables while the table is loading or has no filtered rows (a bounded server page passes its loading flag only, so empty windows keep their controls).
 * Side-effects: none
 * Links: task.0044, task.0059, story.5111
 * @public
 */

"use client";

import type { Column, Table } from "@tanstack/react-table";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  ListFilter,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "./cn.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

/** Optional `useReactTable({ meta })` a node sets so headers can disable while its page loads. */
export interface WorkTableMeta {
  readonly isLoading?: boolean;
}

/** True while the table is loading (explicit flag, else `meta.isLoading`) or has no filtered rows. */
export function workHeaderDisabled<TData>(
  table: Table<TData>,
  isLoading?: boolean,
): boolean {
  const loading =
    isLoading ?? (table.options.meta as WorkTableMeta | undefined)?.isLoading;
  return Boolean(loading) || table.getFilteredRowModel().rows.length === 0;
}

function headerLabel<TData, TValue>(column: Column<TData, TValue>): string {
  const meta = column.columnDef.meta as { headerTitle?: string } | undefined;
  if (meta?.headerTitle) return meta.headerTitle;
  return typeof column.columnDef.header === "string"
    ? column.columnDef.header
    : column.id;
}

export interface WorkColumnHeaderProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  /** Defaults to `meta.headerTitle`, then a string `header`, then the column id. */
  readonly title?: string;
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  /** Filter control opened from a "Filter <title>" popover beside the sort header (e.g. a `HeaderFilter`). */
  readonly filter?: ReactNode;
}

export function WorkColumnHeader<TData, TValue>({
  column,
  title,
  icon,
  className,
  disabled = false,
  filter,
}: WorkColumnHeaderProps<TData, TValue>): ReactElement {
  const resolvedTitle = title ?? headerLabel(column);
  const isSorted = column.getIsSorted();
  const handleSort = () => {
    if (isSorted === "asc") column.toggleSorting(true);
    else if (isSorted === "desc") column.clearSorting();
    else column.toggleSorting(false);
  };
  const header = !column.getCanSort() ? (
    <div
      className={cn(
        "text-secondary-foreground/80 inline-flex h-full items-center gap-1.5 font-normal [&_svg]:opacity-60 text-[0.8125rem] leading-[calc(1.125/0.8125)] [&_svg]:size-3.5",
        className,
      )}
    >
      {icon}
      {resolvedTitle}
    </div>
  ) : (
    <Button
      variant="ghost"
      className={cn(
        "text-secondary-foreground/80 hover:bg-secondary data-[state=open]:bg-secondary hover:text-foreground data-[state=open]:text-foreground -ms-2 px-2 font-normal h-6 rounded-lg",
        className,
      )}
      disabled={disabled}
      onClick={handleSort}
    >
      {icon}
      {resolvedTitle}
      {isSorted === "desc" ? (
        <ArrowDownIcon className="size-3.25" />
      ) : isSorted === "asc" ? (
        <ArrowUpIcon className="size-3.25" />
      ) : (
        <ChevronsUpDownIcon className="mt-px size-3.25" />
      )}
    </Button>
  );
  if (!filter) {
    return column.getCanSort() ? (
      <div className="flex h-full items-center">{header}</div>
    ) : (
      header
    );
  }
  return (
    <div className="flex h-full items-center">
      {header}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 min-w-6 px-1.5"
            aria-label={`Filter ${resolvedTitle}`}
            disabled={disabled}
          >
            <ListFilter
              className={
                column.getIsFiltered()
                  ? "size-3.5 text-primary"
                  : "size-3.5 text-muted-foreground"
              }
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="start">
          {filter}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Rank header: toggles through the column's own sort order, so `sortDescFirst` puts the highest rank first. */
export function WorkItemRankHeader<TData, TValue>({
  column,
}: {
  readonly column: Column<TData, TValue>;
}): ReactElement {
  const direction = column.getIsSorted();
  const Icon =
    direction === "desc"
      ? ArrowDownIcon
      : direction === "asc"
        ? ArrowUpIcon
        : ChevronsUpDownIcon;
  return (
    <Button
      variant="ghost"
      className="-ms-2 h-6 px-2 font-normal"
      onClick={() => column.toggleSorting()}
      disabled={!column.getCanSort()}
    >
      Rank <Icon className="size-3.25 opacity-60" aria-hidden="true" />
    </Button>
  );
}
