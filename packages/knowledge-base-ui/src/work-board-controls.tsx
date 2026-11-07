// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board-controls`
 * Purpose: The work board's sort and filter controls: rank sort + rank range, and sort + facet filter for type, status and project (task.0044).
 * Scope: Client components over a TanStack `Column`; they write sort and filter state through the table, so a node maps that state to its own URL or query. No fetching.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: each control pairs a column's sort header with its filter popover.
 *   - STATUS_SET_FROM_PACKAGE: status options come from `@cogni/work-items` `VALID_TRANSITIONS`.
 * Side-effects: none
 * Links: task.0044, story.5111
 * @public
 */

"use client";

import { VALID_TRANSITIONS } from "@cogni/work-items";
import type { Column } from "@tanstack/react-table";
import { ListFilter } from "lucide-react";
import type { ReactElement } from "react";

import { HeaderFilter } from "./header-filter.js";
import { NumberRangeFilter } from "./number-range-filter.js";
import { Button } from "./ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { WorkColumnHeader, WorkItemRankHeader } from "./work-column-header.js";

/** Every work item status, in lifecycle order. */
export const WORK_STATUSES: readonly string[] = [...VALID_TRANSITIONS.keys()];
/** Statuses a board shows and filters to by default: everything but done and cancelled. */
export const ACTIVE_WORK_STATUSES: readonly string[] = WORK_STATUSES.filter(
  (status) => status !== "done" && status !== "cancelled",
);
/** Work item types offered by the type filter. */
export const WORK_TYPES: readonly string[] = [
  "task",
  "bug",
  "story",
  "spike",
  "subtask",
];

/** `needs_implement` → `implement`. */
export function formatWorkStatus(status: string): string {
  return status.replace("needs_", "").replace(/_/g, " ");
}

/** `proj.alpha` → `alpha`. */
export function formatWorkProject(projectId: string): string {
  return projectId.replace("proj.", "");
}

/** The faceted work columns the board filters on, by TanStack column id. */
export type WorkFacet = "type" | "status" | "projectId";

export function WorkRankControls<TData, TValue>({
  column,
}: {
  readonly column: Column<TData, TValue>;
}): ReactElement {
  return (
    <div className="flex items-center gap-1">
      <WorkItemRankHeader column={column} />
      <NumberRangeFilter column={column} label="Rank" />
    </div>
  );
}

export interface WorkFacetControlsProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  readonly facet: WorkFacet;
  /** Disables the sort header, e.g. from `workHeaderDisabled(table)`. */
  readonly disabled?: boolean;
}

export function WorkFacetControls<TData, TValue>({
  column,
  facet,
  disabled = false,
}: WorkFacetControlsProps<TData, TValue>): ReactElement {
  const title =
    facet === "type" ? "Type" : facet === "status" ? "Status" : "Project";
  return (
    <div className="flex items-center">
      <WorkColumnHeader column={column} title={title} disabled={disabled} />
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 min-w-6 px-1.5"
            aria-label={`Filter ${facet === "projectId" ? "projects" : title.toLowerCase()}`}
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
          <HeaderFilter
            column={column}
            options={
              facet === "type"
                ? WORK_TYPES
                : facet === "status"
                  ? WORK_STATUSES
                  : []
            }
            allowEntry={facet === "projectId"}
            formatLabel={
              facet === "status"
                ? formatWorkStatus
                : facet === "projectId"
                  ? formatWorkProject
                  : (v) => v
            }
            showCounts={false}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
