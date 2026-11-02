// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Numeric bounds for TanStack's built-in inNumberRange filter. */
"use client";

import { Button } from "@cogni/node-ui-kit/shadcn/button";
import { Input } from "@cogni/node-ui-kit/shadcn/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cogni/node-ui-kit/shadcn/popover";
import type { Column } from "@tanstack/react-table";
import { ListFilter } from "lucide-react";

export function NumberRangeFilter<TData>({
  column,
  label,
}: {
  readonly column: Column<TData, number | undefined>;
  readonly label: string;
}) {
  const range = (column.getFilterValue() as
    | [number | undefined, number | undefined]
    | undefined) ?? [undefined, undefined];
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
          size="icon"
          className="h-6 min-w-6 gap-1 px-1.5"
          aria-label={`Filter ${label.toLowerCase()}`}
        >
          {rangeLabel && (
            <span className="font-mono text-primary text-xs">{rangeLabel}</span>
          )}
          <ListFilter
            className={
              column.getIsFiltered()
                ? "size-3.5 text-primary"
                : "size-3.5 text-muted-foreground"
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
              min={0}
              step="any"
              placeholder={index === 0 ? "Min" : "Max"}
              value={range[index] ?? ""}
              onChange={(event) => {
                const next = [...range];
                next[index] =
                  event.target.value === ""
                    ? undefined
                    : event.target.valueAsNumber;
                column.setFilterValue(next);
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
