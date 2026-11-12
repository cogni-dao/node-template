// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-toolbar`
 * Purpose: The work board's toolbar (search, clear filters, Board columns picker) and its sort/filter bar, driven by a node's TanStack table (task.0044).
 * Scope: Client components. Search, filters and sort are written through the `Table` instance; visible board columns are controlled by the node. The node maps both to its own URL or query and owns trailing actions such as a view switch.
 * Invariants:
 *   - TABLE_IS_STATE: search → `setGlobalFilter`, clear → `setColumnFilters([])`, reset → `setSorting`; no hidden local state.
 *   - COLUMNS_UPDATER: the picker always calls `onVisibleStatusesChange` with an updater, so edits in one tick compose.
 *   - HIDDEN_SORT_DISCLOSED: a sort on a column without a board control is named, with a reset to rank.
 * Side-effects: none
 * Links: task.0044
 * @public
 */

"use client";

import type { ColumnSort, OnChangeFn, Table } from "@tanstack/react-table";
import type { ReactElement, ReactNode } from "react";

import { Button } from "./ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import { Input } from "./ui/input.js";
import {
  formatWorkStatus,
  WORK_STATUSES,
  type WorkFacet,
  WorkFacetControls,
  WorkRankControls,
} from "./work-board-controls.js";
import { workHeaderDisabled } from "./work-column-header.js";

const BOARD_FACETS: readonly WorkFacet[] = ["type", "status"];
const BOARD_SORTS: readonly string[] = ["rankScore", ...BOARD_FACETS];
/** The board's default sort: highest rank first. */
export const DEFAULT_WORK_SORT: readonly ColumnSort[] = [
  { id: "rankScore", desc: true },
];

export interface WorkBoardColumnsPickerProps {
  readonly visibleStatuses: readonly string[];
  readonly onVisibleStatusesChange: OnChangeFn<string[]>;
  /** Pickable statuses; defaults to every work item status. */
  readonly statuses?: readonly string[];
}

export function WorkBoardColumnsPicker({
  visibleStatuses,
  onVisibleStatusesChange,
  statuses = WORK_STATUSES,
}: WorkBoardColumnsPickerProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 text-sm focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          Board columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {statuses.map((status) => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={visibleStatuses.includes(status)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => {
              onVisibleStatusesChange((current) =>
                checked
                  ? [...current, status]
                  : current.filter((value) => value !== status),
              );
            }}
          >
            {formatWorkStatus(status)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface WorkBoardToolbarProps<TData> {
  readonly table: Table<TData>;
  /** Board columns; the picker renders only when both are given and `showBoardColumns` is not false. */
  readonly visibleStatuses?: readonly string[];
  readonly onVisibleStatusesChange?: OnChangeFn<string[]>;
  readonly statuses?: readonly string[];
  readonly showBoardColumns?: boolean;
  readonly searchPlaceholder?: string;
  /** Trailing actions, right-aligned (e.g. a node's board/table switch). */
  readonly children?: ReactNode;
}

export function WorkBoardToolbar<TData>({
  table,
  visibleStatuses,
  onVisibleStatusesChange,
  statuses,
  showBoardColumns = true,
  searchPlaceholder = "Search id, title, labels... ( / )",
  children,
}: WorkBoardToolbarProps<TData>): ReactElement {
  const state = table.getState();
  const globalFilter =
    typeof state.globalFilter === "string" ? state.globalFilter : "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        data-search-input
        className="h-9 w-full sm:w-56"
        placeholder={searchPlaceholder}
        value={globalFilter}
        onChange={(event) => table.setGlobalFilter(event.target.value)}
      />
      {state.columnFilters.length > 0 && (
        <button
          type="button"
          className="inline-flex min-h-6 items-center text-muted-foreground text-xs underline hover:text-foreground"
          onClick={() => table.setColumnFilters([])}
        >
          Clear filters
        </button>
      )}
      {showBoardColumns && visibleStatuses && onVisibleStatusesChange && (
        <WorkBoardColumnsPicker
          visibleStatuses={visibleStatuses}
          onVisibleStatusesChange={onVisibleStatusesChange}
          {...(statuses && { statuses })}
        />
      )}
      {children && (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      )}
    </div>
  );
}

export interface WorkBoardFilterBarProps<TData> {
  readonly table: Table<TData>;
  /** Disables facet sort headers while loading; falls back to `meta.isLoading`. */
  readonly isLoading?: boolean;
}

export function WorkBoardFilterBar<TData>({
  table,
  isLoading,
}: WorkBoardFilterBarProps<TData>): ReactElement {
  const rank = table.getColumn("rankScore");
  const disabled = workHeaderDisabled(table, isLoading);
  const sort = table.getState().sorting[0];
  return (
    <>
      <fieldset
        className="mb-4 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border px-4 py-2"
        aria-label="Board filters and sorting"
      >
        {rank && <WorkRankControls column={rank} />}
        {BOARD_FACETS.map((facet) => {
          const column = table.getColumn(facet);
          return (
            column && (
              <WorkFacetControls
                key={facet}
                column={column}
                facet={facet}
                disabled={disabled}
              />
            )
          );
        })}
      </fieldset>
      {sort && !BOARD_SORTS.includes(sort.id) && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span>
            Sorted by {sort.id} ({sort.desc ? "descending" : "ascending"})
          </span>
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() =>
              table.setSorting(DEFAULT_WORK_SORT.map((entry) => ({ ...entry })))
            }
          >
            Reset to rank
          </button>
        </div>
      )}
    </>
  );
}
