// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-query`
 * Purpose: Map the board's TanStack filter, sort and search state to the shared bounded summary query (task.0055).
 * Scope: Pure function. A node with its own URL state may build the query itself; this is the default mapping for a table whose state lives in React state.
 * Invariants: Only sort columns the summary read supports are emitted; the page window (`limit`, `cursor`) and `statuses` belong to the board hook, not to this mapping.
 * Side-effects: none
 * Links: task.0055, task.0044
 * @public
 */

import {
  WORK_ITEM_SORT_FIELDS,
  type WorkItemSortBy,
  type WorkSummaryQuery,
} from "@cogni/work-items";
import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";

export interface WorkBoardTableState {
  readonly sorting: SortingState;
  readonly columnFilters: ColumnFiltersState;
  readonly globalFilter: string;
}

const FACET_PARAMS = [
  ["type", "types"],
  ["status", "statuses"],
  ["projectId", "projectIds"],
] as const;

/** The query a table's filters, sort and search ask the server for (no `limit`/`cursor`). */
export function workBoardTableStateToQuery(
  state: WorkBoardTableState,
): WorkSummaryQuery {
  const query: {
    -readonly [K in keyof WorkSummaryQuery]: WorkSummaryQuery[K];
  } = {};
  for (const [id, key] of FACET_PARAMS) {
    const value = state.columnFilters.find((filter) => filter.id === id)?.value;
    if (Array.isArray(value) && value.length > 0) {
      query[key] = value.map(String);
    }
  }
  const range = state.columnFilters.find((filter) => filter.id === "rankScore")
    ?.value;
  if (Array.isArray(range)) {
    const [min, max] = range as unknown[];
    if (typeof min === "number" && Number.isFinite(min)) query.rankMin = min;
    if (typeof max === "number" && Number.isFinite(max)) query.rankMax = max;
  }
  const sort = state.sorting[0];
  if (sort && (WORK_ITEM_SORT_FIELDS as readonly string[]).includes(sort.id)) {
    query.sortBy = sort.id as WorkItemSortBy;
    query.sortDirection = sort.desc ? "desc" : "asc";
  }
  if (state.globalFilter) query.text = state.globalFilter;
  return query;
}
