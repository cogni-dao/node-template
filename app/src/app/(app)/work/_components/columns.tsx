// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/columns`
 * Purpose: TanStack column definitions for the work-items DataGrid.
 * Scope: Pure column descriptors + inline cells. No fetching, no router.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: every header renders via reui
 *     `DataGridColumnHeader` so sort lives there. Discrete-value columns
 *     (type / status / projectId) inline a `HeaderFilter` so per-column
 *     multi-select filtering lives in the same dropdown.
 *   - Column visibility is NOT in the header dropdown — it lives in a single
 *     toolbar `Columns` button at top-right of `view.tsx`.
 *   - filterFn: "arrIncludesSome" on facet columns so HeaderFilter's
 *     setFilterValue(string[]) works.
 * @internal
 */

"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { DataGridColumnHeader } from "@cogni/node-ui-kit/reui/data-grid/data-grid-column-header";
import { Button } from "@cogni/node-ui-kit/shadcn/button";
import { Input } from "@cogni/node-ui-kit/shadcn/input";
import { rankScore } from "@cogni/work-items";
import { type Column, createColumnHelper } from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { NumberRangeFilter } from "./NumberRangeFilter";
import { StatusPill, TypeIcon } from "./work-item-icons";

function WorkFacet({
  column,
  title,
  options,
  allowEntry = false,
}: {
  readonly column: Column<WorkItemDto, string | undefined>;
  readonly title: string;
  readonly options: readonly string[];
  readonly allowEntry?: boolean;
}) {
  const [entry, setEntry] = useState("");
  const selected = (column.getFilterValue() as string[] | undefined) ?? [];
  const values = [
    ...new Set([
      ...options,
      ...selected,
      ...[...column.getFacetedUniqueValues().keys()].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ]),
  ].sort();
  const toggle = (v: string) => {
    const next = selected.includes(v)
      ? selected.filter((x) => x !== v)
      : [...selected, v];
    column.setFilterValue(next.length ? next : undefined);
  };
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="text-sm"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        {title}{" "}
        {column.getIsSorted() === "asc"
          ? "↑"
          : column.getIsSorted() === "desc"
            ? "↓"
            : ""}
      </button>
      <details className="relative">
        <summary className="cursor-pointer text-xs">Filter</summary>
        <div className="absolute z-20 flex w-52 flex-col gap-1 rounded border bg-popover p-2 shadow">
          {values.map((v) => (
            <label key={v} className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={() => toggle(v)}
              />
              {v.replace("needs_", "").replaceAll("_", " ")}
            </label>
          ))}
          {allowEntry && (
            <div className="flex gap-1">
              <Input
                aria-label="Project ID"
                value={entry}
                onChange={(e) => setEntry(e.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  if (entry && !selected.includes(entry)) toggle(entry);
                  setEntry("");
                }}
              >
                Add
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => column.setFilterValue(undefined)}
          >
            Clear
          </button>
        </div>
      </details>
    </div>
  );
}

const col = createColumnHelper<WorkItemDto>();

const formatProject = (v: string) => v.replace("proj.", "");

/** App binding: the shared generic header otherwise forces ascending first. */
export function WorkItemRankHeader<TData>({
  column,
}: {
  readonly column: Column<TData, number | undefined>;
}) {
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

export const columns = [
  col.accessor("priority", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Pri" />
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

  // story.5111: WSJF rank from the package; unscored items always sort last.
  col.accessor((row) => rankScore(row.scores), {
    id: "rankScore",
    header: ({ column }) => (
      <div className="flex items-center gap-1">
        <WorkItemRankHeader column={column} />
        <NumberRangeFilter column={column} label="Rank" />
      </div>
    ),
    size: 65,
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

  col.accessor("type", {
    header: ({ column }) => (
      <WorkFacet
        column={column}
        title="Type"
        options={["task", "bug", "story", "spike", "subtask"]}
      />
    ),
    size: 55,
    cell: (info) => <TypeIcon type={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Type" },
  }),

  col.display({
    id: "item",
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Item" />
    ),
    minSize: 250,
    cell: ({ row }) => {
      const { id, title } = row.original;
      return (
        <div className="flex flex-col gap-0.5 py-0.5">
          <span className="line-clamp-1 text-sm">{title}</span>
          <span className="font-mono text-muted-foreground text-xs">{id}</span>
        </div>
      );
    },
    meta: { headerTitle: "Item" },
  }),

  col.accessor("status", {
    header: ({ column }) => (
      <WorkFacet
        column={column}
        title="Status"
        options={[
          "needs_triage",
          "needs_research",
          "needs_design",
          "needs_implement",
          "needs_closeout",
          "needs_merge",
          "done",
          "blocked",
          "cancelled",
        ]}
      />
    ),
    size: 150,
    cell: (info) => <StatusPill status={info.getValue()} />,
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Status" },
  }),

  col.accessor("projectId", {
    header: ({ column }) => (
      <WorkFacet column={column} title="Project" options={[]} allowEntry />
    ),
    size: 140,
    cell: (info) => {
      const v = info.getValue();
      if (!v) return null;
      return (
        <span className="truncate text-muted-foreground text-xs">
          {formatProject(v)}
        </span>
      );
    },
    filterFn: "arrIncludesSome",
    meta: { headerTitle: "Project" },
  }),

  col.accessor("updatedAt", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Updated" />
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

  col.accessor("estimate", {
    header: ({ column }) => (
      <DataGridColumnHeader column={column} title="Est" />
    ),
    size: 55,
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
