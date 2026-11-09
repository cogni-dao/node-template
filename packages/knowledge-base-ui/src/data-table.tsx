// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/data-table`
 * Purpose: The package's own table body and column-visibility picker for bounded server pages, so knowledge Browse never needs a node's private data-grid (task.0059).
 * Scope: Client components over a node- or package-owned TanStack `Table`. Render only the rows the table holds; no fetching, paging or client filtering.
 * Invariants:
 *   - LOADING_IS_NOT_EMPTY: while `isLoading`, skeleton rows render and the empty message never shows.
 *   - ROWS_ARE_BUTTONS: a row with `onRowClick` is keyboard-activatable (Enter/Space) and clickable; cells that stop propagation (copy buttons) do not select.
 *   - PICKER_LISTS_HIDEABLE: the visibility picker lists every column that can hide, labelled by `meta.headerTitle`.
 * Side-effects: none
 * Links: task.0059
 * @public
 */

"use client";

import { flexRender, type Table } from "@tanstack/react-table";
import type { ReactElement, ReactNode } from "react";

import { cn } from "./cn.js";
import { Button } from "./ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";

export interface DataTableProps<TData> {
  readonly table: Table<TData>;
  readonly isLoading?: boolean;
  readonly emptyMessage?: ReactNode;
  readonly onRowClick?: (row: TData) => void;
  /** Skeleton rows while loading. Default 5. */
  readonly skeletonRows?: number;
  readonly className?: string;
}

export function DataTable<TData>({
  table,
  isLoading = false,
  emptyMessage = "No results.",
  onRowClick,
  skeletonRows = 5,
  className,
}: DataTableProps<TData>): ReactElement {
  const rows = table.getRowModel().rows;
  const width = table.getVisibleLeafColumns().length || 1;
  return (
    <div className={cn("overflow-x-auto rounded-lg border", className)}>
      <table className="w-full caption-bottom text-sm">
        <thead className="sticky top-0 z-10 bg-background">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b">
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  className="h-9 px-3 text-left align-middle font-normal"
                  style={{ width: header.getSize() }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {isLoading ? (
            Array.from({ length: skeletonRows }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
              <tr key={index} className="border-b" aria-hidden="true">
                <td colSpan={width} className="px-3 py-2">
                  <div className="h-4 w-full animate-pulse rounded bg-muted" />
                </td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={width}
                className="px-3 py-6 text-center text-muted-foreground text-sm"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "border-b transition-colors last:border-b-0 hover:bg-muted/50",
                  onRowClick && "cursor-pointer",
                )}
                {...(onRowClick && {
                  tabIndex: 0,
                  onClick: () => onRowClick(row.original),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowClick(row.original);
                    }
                  },
                })}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-1.5 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function columnLabel(column: {
  readonly id: string;
  readonly columnDef: { readonly meta?: unknown; readonly header?: unknown };
}): string {
  const meta = column.columnDef.meta as { headerTitle?: string } | undefined;
  if (meta?.headerTitle) return meta.headerTitle;
  return typeof column.columnDef.header === "string"
    ? column.columnDef.header
    : column.id;
}

export interface DataTableColumnsPickerProps<TData> {
  readonly table: Table<TData>;
  /** Trigger label. Default "Columns". */
  readonly label?: string;
}

export function DataTableColumnsPicker<TData>({
  table,
  label = "Columns",
}: DataTableColumnsPickerProps<TData>): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {table
          .getAllLeafColumns()
          .filter((column) => column.getCanHide())
          .map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => column.toggleVisibility(!!checked)}
            >
              {columnLabel(column)}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
