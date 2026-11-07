// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-column-header`
 * Purpose: Sortable column header for work tables and the work board filter bar, plus the rank header that sorts descending first (task.0044).
 * Scope: Context-free: reads only the TanStack `Column` (and, for disabling, the `Table`), so it renders inside any node's grid or none. Markup and classes match the ReUI `DataGridColumnHeader` sort-only path.
 * Invariants:
 *   - SORT_CYCLE: a generic header cycles asc → desc → unsorted; the rank header follows the column's own `sortDescFirst`.
 *   - DISABLED_WHILE_EMPTY: a generic header is disabled while the table is loading or has no filtered rows.
 * Side-effects: none
 * Links: task.0044, story.5111
 * @public
 */

"use client";

import type { Column, Table } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "./cn.js";
import { Button } from "./ui/button.js";

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
}

export function WorkColumnHeader<TData, TValue>({
  column,
  title,
  icon,
  className,
  disabled = false,
}: WorkColumnHeaderProps<TData, TValue>): ReactElement {
  const resolvedTitle = title ?? headerLabel(column);
  const isSorted = column.getIsSorted();
  if (!column.getCanSort()) {
    return (
      <div
        className={cn(
          "text-secondary-foreground/80 inline-flex h-full items-center gap-1.5 font-normal [&_svg]:opacity-60 text-[0.8125rem] leading-[calc(1.125/0.8125)] [&_svg]:size-3.5",
          className,
        )}
      >
        {icon}
        {resolvedTitle}
      </div>
    );
  }
  const handleSort = () => {
    if (isSorted === "asc") column.toggleSorting(true);
    else if (isSorted === "desc") column.clearSorting();
    else column.toggleSorting(false);
  };
  return (
    <div className="flex h-full items-center">
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
