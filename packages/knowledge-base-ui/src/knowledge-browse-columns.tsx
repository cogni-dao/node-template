// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-browse-columns`
 * Purpose: Column definitions of the bounded knowledge Browse table: header-owned sort and exact-value filters over the whole corpus (task.0059).
 * Scope: Pure TanStack column descriptors over `KnowledgeSummary`. Sorting and filtering are manual: the table state becomes the server query (`knowledgeBrowseTableStateToQuery`), never a filter over the loaded window.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: Domain, Type and Source headers hold their exact-value filter and Asc/Desc; Confidence and Created sort on click.
 *   - EXACT_GLOBAL_VALUES: filters list the node's known values plus typed exact entries (≤ 50 values, ≤ 500 chars each), never facets of the loaded window.
 *   - EMPTY_WINDOW_KEEPS_CONTROLS: headers disable only while a window is loading (`meta.isLoading`), so an empty result can still be refiltered.
 * Side-effects: none
 * Links: task.0059
 * @public
 */

"use client";

import type {
  KnowledgeBrowseQuery,
  KnowledgeSummary,
} from "@cogni/knowledge-store/contracts";
import {
  type Column,
  type ColumnDef,
  type ColumnFiltersState,
  createColumnHelper,
  type SortingState,
  type Table,
} from "@tanstack/react-table";
import type { ReactElement } from "react";

import { HeaderFilter } from "./header-filter.js";
import { ConfidenceBar, CopyLinkButton } from "./knowledge-cells.js";
import {
  KNOWLEDGE_FILTER_VALUE_LENGTH_MAX,
  KNOWLEDGE_FILTER_VALUES_MAX,
} from "./knowledge-browse-query.js";
import { RelativeTime } from "./relative-time.js";
import { WorkColumnHeader } from "./work-column-header.js";

export interface KnowledgeBrowseTableMeta {
  readonly isLoading?: boolean;
}

export interface KnowledgeBrowseColumnsOptions {
  /**
   * Canonical entry types offered by the Type filter. Required: pass the
   * store root's `EntryTypeSchema.options` (not exported from the browser-safe
   * `@cogni/knowledge-store/contracts`).
   */
  readonly entryTypeOptions: readonly string[];
  /** Canonical source types offered by the Source filter: the store root's `SourceTypeSchema.options`. */
  readonly sourceTypeOptions: readonly string[];
  /** Known domains offered by the Domain filter. Default none: exact entry only. */
  readonly domainOptions?: readonly string[];
  /** Permalink path of an entry for the copy button. Default `/knowledge/<id>`. */
  readonly entryHref?: (id: string) => string;
}

/** Sortable Browse columns (the store's `sort` values). */
export const KNOWLEDGE_BROWSE_SORTS = [
  "id",
  "domain",
  "entryType",
  "confidencePct",
  "sourceType",
  "createdAt",
] as const;

const DEFAULT_HREF = (id: string) => `/knowledge/${encodeURIComponent(id)}`;

function loading(table: Table<KnowledgeSummary>): boolean {
  return Boolean(
    (table.options.meta as KnowledgeBrowseTableMeta | undefined)?.isLoading,
  );
}

function ExactFilter({
  column,
  label,
  options,
}: {
  readonly column: Column<KnowledgeSummary, unknown>;
  readonly label: string;
  readonly options: readonly string[];
}): ReactElement {
  return (
    <HeaderFilter
      column={column}
      options={options}
      allowEntry
      showCounts={false}
      caption={`${label} · any selected exact value`}
      entryLabel={`Exact ${label}`}
      entryMaxLength={KNOWLEDGE_FILTER_VALUE_LENGTH_MAX}
      maxSelected={KNOWLEDGE_FILTER_VALUES_MAX}
      clearLabel={`Clear ${label}`}
    />
  );
}

const col = createColumnHelper<KnowledgeSummary>();

/** A Browse column; value types differ per column, as in TanStack's own `ColumnDef<T, any>[]` convention. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous column value types
export type KnowledgeBrowseColumnDef = ColumnDef<KnowledgeSummary, any>;

export function createKnowledgeBrowseColumns({
  entryTypeOptions,
  sourceTypeOptions,
  domainOptions = [],
  entryHref = DEFAULT_HREF,
}: KnowledgeBrowseColumnsOptions): KnowledgeBrowseColumnDef[] {
  const columns = [
    col.accessor("domain", {
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Domain"
          disabled={loading(table)}
          filter={
            <ExactFilter column={column} label="Domain" options={domainOptions} />
          }
        />
      ),
      size: 130,
      cell: (info) => (
        <span className="font-mono text-muted-foreground text-xs">
          {info.getValue()}
        </span>
      ),
      meta: { headerTitle: "Domain" },
    }),
    col.display({
      id: "entry",
      header: ({ column }) => <WorkColumnHeader column={column} title="Entry" />,
      enableSorting: false,
      minSize: 280,
      cell: ({ row }) => {
        const { id, title, entityId } = row.original;
        return (
          <div className="flex items-center gap-2 py-0.5">
            <CopyLinkButton path={entryHref(id)} label="Copy block link" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="line-clamp-1 text-sm">{title}</span>
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <span className="font-mono">{id}</span>
                {entityId && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono opacity-70">{entityId}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      },
      meta: { headerTitle: "Entry" },
    }),
    col.accessor("entryType", {
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Type"
          disabled={loading(table)}
          filter={
            <ExactFilter column={column} label="Type" options={entryTypeOptions} />
          }
        />
      ),
      size: 110,
      cell: (info) => (
        <span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
          {info.getValue()}
        </span>
      ),
      meta: { headerTitle: "Type" },
    }),
    col.accessor("confidencePct", {
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Confidence"
          disabled={loading(table)}
        />
      ),
      size: 130,
      cell: (info) => <ConfidenceBar value={info.getValue() ?? null} />,
      meta: { headerTitle: "Confidence" },
    }),
    col.accessor("sourceType", {
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Source"
          disabled={loading(table)}
          filter={
            <ExactFilter
              column={column}
              label="Source"
              options={sourceTypeOptions}
            />
          }
        />
      ),
      size: 110,
      cell: (info) => (
        <span className="inline-flex rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
          {info.getValue()}
        </span>
      ),
      meta: { headerTitle: "Source" },
    }),
    col.accessor("createdAt", {
      header: ({ column, table }) => (
        <WorkColumnHeader
          column={column}
          title="Created"
          disabled={loading(table)}
        />
      ),
      size: 110,
      cell: (info) => <RelativeTime iso={info.getValue()} />,
      meta: { headerTitle: "Created" },
    }),
  ];
  return columns as KnowledgeBrowseColumnDef[];
}

/** Default Browse order: newest first. */
export const DEFAULT_KNOWLEDGE_SORT: SortingState = [
  { id: "createdAt", desc: true },
];

function filterValues(filters: ColumnFiltersState, id: string): string[] {
  const value = filters.find((filter) => filter.id === id)?.value;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The server query a Browse table's sort, filters and committed search ask for. */
export function knowledgeBrowseTableStateToQuery({
  sorting,
  columnFilters,
  search,
}: {
  readonly sorting: SortingState;
  readonly columnFilters: ColumnFiltersState;
  readonly search?: string;
}): KnowledgeBrowseQuery {
  const sort = sorting[0];
  const sortId = (KNOWLEDGE_BROWSE_SORTS as readonly string[]).includes(
    sort?.id ?? "",
  )
    ? (sort?.id as (typeof KNOWLEDGE_BROWSE_SORTS)[number])
    : "createdAt";
  return {
    sort: sortId,
    direction: sort?.desc === false ? "asc" : "desc",
    domains: filterValues(columnFilters, "domain"),
    entryTypes: filterValues(columnFilters, "entryType"),
    sourceTypes: filterValues(columnFilters, "sourceType"),
    ...(search ? { search } : {}),
  };
}
