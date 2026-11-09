// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-view`
 * Purpose: The complete work board body: sort/filter bar over the board, rendering a node's per-status column pages (task.0044, task.0055).
 * Scope: Client composition of `WorkBoardFilterBar` and `WorkBoard`. The TanStack `table` carries filter, sort and search state only (manual filtering); cards come from the `columns` pages, never from table rows. The node owns data, URL state and navigation; `useWorkBoard` supplies the bounded data.
 * Invariants:
 *   - COLUMN_PAGES_ONLY: cards are the given column pages in the given column order; there is no rows-from-a-full-array mode.
 * Side-effects: none
 * Links: task.0044, task.0041, task.0055
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
  extends WorkBoardProps<TItem> {
  readonly table: Table<TItem>;
}

export function WorkBoardView<TItem extends WorkBoardItem>({
  table,
  ...board
}: WorkBoardViewProps<TItem>): ReactElement {
  return (
    <>
      <WorkBoardFilterBar table={table} isLoading={board.isLoading} />
      <WorkBoard {...board} />
    </>
  );
}
