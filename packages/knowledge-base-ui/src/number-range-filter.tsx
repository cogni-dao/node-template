// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/number-range-filter`
 * Purpose: Min/max popover for TanStack's built-in `inNumberRange` filter, e.g. the work board's rank range (task.0044).
 * Scope: Client component writing `[min, max]` through `column.setFilterValue`; either bound may be undefined. No fetching or URL state.
 * Invariants: Each bound edit composes with the latest filter value, so two edits in one tick both apply; "Clear" removes the filter.
 * Side-effects: none
 * Links: task.0044
 * @public
 */

"use client";

import type { Column } from "@tanstack/react-table";
import { ListFilter } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";

/** The filter value `inNumberRange` reads; an undefined bound is open-ended. */
export type NumberRange = [number | undefined, number | undefined];

export interface NumberRangeFilterProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  readonly label: string;
}

export function NumberRangeFilter<TData, TValue>({
  column,
  label,
}: NumberRangeFilterProps<TData, TValue>): ReactElement {
  const range = (column.getFilterValue() as NumberRange | undefined) ?? [
    undefined,
    undefined,
  ];
  const rangeLabel =
    range[0] === undefined
      ? range[1] === undefined
        ? ""
        : `≤${range[1]}`
      : range[1] === undefined
        ? `≥${range[0]}`
        : `${range[0]}–${range[1]}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto min-h-6 w-auto max-w-[120px] min-w-6 gap-1 whitespace-normal px-1.5"
          aria-label={`Filter ${label.toLowerCase()}`}
        >
          {rangeLabel && (
            <span className="break-all text-left font-mono text-primary text-xs">
              {rangeLabel}
            </span>
          )}
          <ListFilter
            className={
              column.getIsFiltered()
                ? "size-3.5 shrink-0 text-primary"
                : "size-3.5 shrink-0 text-muted-foreground"
            }
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-3" align="start">
        <p className="font-medium text-sm">{label} range</p>
        <div className="flex items-center gap-2">
          {([0, 1] as const).map((index) => (
            <Input
              key={index}
              aria-label={`${label} ${index === 0 ? "minimum" : "maximum"}`}
              type="number"
              step="any"
              placeholder={index === 0 ? "Min" : "Max"}
              value={range[index] ?? ""}
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                const bound =
                  event.target.value === "" || !Number.isFinite(value)
                    ? undefined
                    : value;
                column.setFilterValue((previous: NumberRange | undefined) => {
                  const next: NumberRange = previous
                    ? [...previous]
                    : [undefined, undefined];
                  next[index] = bound;
                  return next;
                });
              }}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => column.setFilterValue(undefined)}
        >
          Clear {label.toLowerCase()}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
