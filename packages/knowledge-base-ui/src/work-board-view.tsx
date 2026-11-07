// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-view`
 * Purpose: The complete work board body: sort/filter bar over the board, rendering a node's TanStack table rows in its visible status columns (task.0044).
 * Scope: Client composition of `WorkBoardFilterBar` and `WorkBoard`. Cards are `table.getRowModel()` rows, so client-side and server-side filtering both update them. The node owns data, URL state and navigation.
 * Invariants: Cards appear only in `visibleStatuses` columns; their order is the table's row order.
 * Side-effects: none
 * Links: task.0044, task.0041
 * @public
 */

"use client";

import type { Table } from "@tanstack/react-table";
import type { ReactElement } from "react";

import {
  WorkBoard,
  type WorkBoardItem,
  type WorkBoardProps,
} from "./work-board.js";
import { WorkBoardFilterBar } from "./work-board-toolbar.js";

export interface WorkBoardViewProps<TItem extends WorkBoardItem>
  extends Omit<WorkBoardProps<TItem>, "items" | "statuses"> {
  readonly table: Table<TItem>;
  readonly visibleStatuses: readonly string[];
}

export function WorkBoardView<TItem extends WorkBoardItem>({
  table,
  visibleStatuses,
  isLoading,
  ...board
}: WorkBoardViewProps<TItem>): ReactElement {
  return (
    <>
      <WorkBoardFilterBar table={table} isLoading={isLoading} />
      <WorkBoard
        {...board}
        items={table.getRowModel().rows.map((row) => row.original)}
        statuses={visibleStatuses}
        isLoading={isLoading}
      />
    </>
  );
}
