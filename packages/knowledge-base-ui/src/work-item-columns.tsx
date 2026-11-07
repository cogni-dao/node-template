// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-item-columns`
 * Purpose: TanStack column definitions that drive both the work board and a work table: rank, priority, type, item, status, project, updated and estimate (task.0044).
 * Scope: Pure column descriptors + inline cells. No fetching, no router; a node may inject the item cell (e.g. to render a link).
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: every header renders a package header control, so sort and facet filters live there.
 *   - RANK_FROM_PACKAGE: `rankScore` is `@cogni/work-items` `rankScore(scores)`; it sorts descending first and unscored items sort last.
 *   - FACET_FILTERS: type, status and projectId use `arrIncludesSome`; rankScore uses `inNumberRange`, so client-side and server-side filtering agree.
 *   - Column visibility is not in the header; a table's toolbar owns it.
 * Side-effects: none
 * Links: task.0044, story.5111
 * @public
 */

"use client";

import { rankScore } from "@cogni/work-items";
import {
  type ColumnDef,
  createColumnHelper,
  type Row,
} from "@tanstack/react-table";
import type { ReactNode } from "react";

import type { WorkBoardItem } from "./work-board.js";
import {
  formatWorkProject,
  WorkFacetControls,
  WorkRankControls,
} from "./work-board-controls.js";
import { WorkColumnHeader, workHeaderDisabled } from "./work-column-header.js";
import { StatusPill, TypeIcon } from "./work-item-icons.js";

/** The structural subset of a work item the board and table columns read. */
export interface WorkItemRow extends WorkBoardItem {
  readonly priority?: number | null | undefined;
  readonly estimate?: number | null | undefined;
  readonly createdAt?: string | null | undefined;
}

export interface WorkItemColumnsOptions<TItem extends WorkItemRow> {
  /** Renders the Item cell; defaults to the title over the id. */
  readonly renderItem?: (item: TItem) => ReactNode;
}

function defaultItemCell({ id, title }: WorkItemRow): ReactNode {
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <span className="line-clamp-2 text-sm md:line-clamp-1">{title}</span>
      <span className="font-mono text-muted-foreground text-xs">{id}</span>
    </div>
  );
}

/** Global search over id, title and labels (case-insensitive), for client-side filtering. */
export function workItemGlobalFilterFn<TItem extends WorkItemRow>(
  row: Row<TItem>,
  _columnId: string,
  filterValue: unknown,
): boolean {
  const q = String(filterValue).toLowerCase();
  const item = row.original;
  return (
    item.id.toLowerCase().includes(q) ||
    item.title.toLowerCase().includes(q) ||
    item.labels.some((label) => label.toLowerCase().includes(q))
  );
}

/** Builds the work column set for a node's own row type. */
export function createWorkItemColumns<TItem extends WorkItemRow>(
  options: WorkItemColumnsOptions<TItem> = {},
  // biome-ignore lint/suspicious/noExplicitAny: TanStack column arrays mix value types.
): ColumnDef<TItem, any>[] {
  const col = createColumnHelper<TItem>();
  const renderItem = options.renderItem ?? defaultItemCell;
  return [
    col.accessor((row) => row.priority ?? undefined, {
      id: "priority",
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Pri"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 60,
      cell: (info) => {
        const v = info.getValue();
        if (v == null)
          return <span className="text-muted-foreground">&mdash;</span>;
        return (
          <span className="inline-flex w-7 justify-center rounded-md bg-muted px-1.5 py-0.5 font-medium text-xs">
            P{v}
          </span>
        );
      },
      sortingFn: (a, b) => {
        const pa = a.original.priority ?? 999;
        const pb = b.original.priority ?? 999;
        return pa - pb;
      },
      meta: { headerTitle: "Pri" },
    }),

    col.accessor((row) => rankScore(row.scores ?? undefined), {
      id: "rankScore",
      header: ({ column }) => <WorkRankControls column={column} />,
      size: 220,
      minSize: 220,
      cell: (info) => {
        const v = info.getValue();
        if (v === undefined)
          return <span className="text-muted-foreground">&mdash;</span>;
        return <span className="font-mono text-xs">{v.toFixed(1)}</span>;
      },
      sortDescFirst: true,
      sortUndefined: "last",
      filterFn: "inNumberRange",
      meta: { headerTitle: "Rank" },
    }),

    col.accessor((row) => row.type, {
      id: "type",
      header: ({ column, table }) => (
        <WorkFacetControls
          column={column}
          facet="type"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 110,
      minSize: 110,
      cell: (info) => <TypeIcon type={info.getValue()} />,
      filterFn: "arrIncludesSome",
      meta: { headerTitle: "Type" },
    }),

    col.display({
      id: "item",
      header: ({ column }) => <WorkColumnHeader column={column} title="Item" />,
      minSize: 250,
      cell: ({ row }) => renderItem(row.original),
      meta: { headerTitle: "Item" },
    }),

    col.accessor((row) => row.status, {
      id: "status",
      header: ({ column, table }) => (
        <WorkFacetControls
          column={column}
          facet="status"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 150,
      cell: (info) => <StatusPill status={info.getValue()} />,
      filterFn: "arrIncludesSome",
      meta: { headerTitle: "Status" },
    }),

    col.accessor((row) => row.projectId, {
      id: "projectId",
      header: ({ column, table }) => (
        <WorkFacetControls
          column={column}
          facet="projectId"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 140,
      cell: (info) => {
        const v = info.getValue();
        if (!v) return null;
        return (
          <span className="truncate text-muted-foreground text-xs">
            {formatWorkProject(v)}
          </span>
        );
      },
      filterFn: "arrIncludesSome",
      meta: { headerTitle: "Project" },
    }),

    col.accessor((row) => row.updatedAt ?? undefined, {
      id: "updatedAt",
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Updated"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 110,
      cell: (info) => {
        const v = info.getValue() || info.row.original.createdAt;
        if (!v) return <span className="text-muted-foreground">&mdash;</span>;
        return (
          <span className="text-muted-foreground text-xs">{v.slice(0, 10)}</span>
        );
      },
      sortingFn: (a, b) => {
        const da = a.original.updatedAt || a.original.createdAt || "";
        const db = b.original.updatedAt || b.original.createdAt || "";
        return da.localeCompare(db);
      },
      meta: { headerTitle: "Updated" },
    }),

    col.accessor((row) => row.estimate ?? undefined, {
      id: "estimate",
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Est"
          disabled={workHeaderDisabled(table)}
        />
      ),
      size: 70,
      minSize: 70,
      cell: (info) => {
        const v = info.getValue();
        return (
          <span className="text-center text-muted-foreground text-xs">
            {v ?? "—"}
          </span>
        );
      },
      meta: { headerTitle: "Est" },
    }),
  ];
}
