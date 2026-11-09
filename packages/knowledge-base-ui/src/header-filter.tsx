// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/header-filter`
 * Purpose: Multi-select facet filter for header-owned popovers or dropdowns, shared by every node's work and knowledge tables (task.0044, task.0059).
 * Scope: Client component reading `column.getFacetedUniqueValues()` (an empty map when the table has no faceted model, e.g. a bounded server page), plus `options` and typed exact entries. Does not fetch data or own URL state.
 * Invariants:
 *   - HEADER_OWNS_SORT_AND_FILTER: facet controls belong to the column header, not a parallel toolbar chip. Deselecting the last value clears the filter.
 *   - CALLER_VALIDATES: with `validate`, a value whose addition the caller rejects (e.g. by parsing the next filter with the store's query schema) is disabled with that reason as its title, and a rejected typed entry is refused with the reason shown in an alert. The component copies no limits of its own.
 * Side-effects: none
 * Links: task.0044, task.0059, task.0432
 * @public
 */

"use client";

import type { Column } from "@tanstack/react-table";
import { Check } from "lucide-react";
import { type ReactElement, useState } from "react";

import { cn } from "./cn.js";
import { Input } from "./ui/input.js";

export interface HeaderFilterProps<TData, TValue> {
  readonly column: Column<TData, TValue>;
  /** Optional value → display-label mapping. */
  readonly formatLabel?: (value: string) => string;
  readonly options?: readonly string[];
  readonly allowEntry?: boolean;
  readonly showCounts?: boolean;
  /** Accessible name and placeholder of the entry box. Default "Project ID". */
  readonly entryLabel?: string;
  /** Why the next selection would be invalid, or `null` when it is accepted. */
  readonly validate?: (next: readonly string[]) => string | null;
  /** Caption above the values, e.g. "Domain · any selected exact value". */
  readonly caption?: string;
  /** Label of the clear button. Default "Clear". */
  readonly clearLabel?: string;
}

export function HeaderFilter<TData, TValue>({
  column,
  formatLabel,
  options,
  allowEntry = false,
  showCounts = true,
  entryLabel = "Project ID",
  validate,
  caption,
  clearLabel = "Clear",
}: HeaderFilterProps<TData, TValue>): ReactElement {
  const [entry, setEntry] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const facets = column.getFacetedUniqueValues();
  const selected = new Set((column.getFilterValue() as string[]) ?? []);
  const values = [
    ...new Set([...facets.keys(), ...(options ?? []), ...selected]),
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort((a, b) => a.localeCompare(b));

  /** The caller's reason adding `value` is invalid, if any. */
  const refusal = (value: string): string | null =>
    selected.has(value) || !validate ? null : validate([...selected, value]);

  /** Toggle `value`; returns false when the caller refused the addition. */
  function toggle(value: string): boolean {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else {
      const reason = refusal(value);
      if (reason) {
        setRefused(reason);
        return false;
      }
      next.add(value);
    }
    setRefused(null);
    column.setFilterValue(next.size === 0 ? undefined : Array.from(next));
    return true;
  }

  if (values.length === 0 && !allowEntry) {
    return <span className="text-muted-foreground text-xs">No values</span>;
  }

  return (
    <div className="flex max-h-64 min-w-56 flex-col gap-0.5 overflow-y-auto pr-1">
      {caption && (
        <p className="px-2 pb-1 text-muted-foreground text-xs">{caption}</p>
      )}
      {values.map((v) => {
        const isSelected = selected.has(v);
        const reason = refusal(v);
        return (
          <button
            key={v}
            type="button"
            aria-pressed={isSelected}
            disabled={reason !== null}
            title={reason ?? undefined}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggle(v);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : "opacity-50",
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </span>
            <span className="flex-1 truncate capitalize">
              {formatLabel ? formatLabel(v) : v}
            </span>
            {showCounts && (
              <span className="shrink-0 pl-2 font-mono text-muted-foreground text-xs tabular-nums">
                {facets.get(v)}
              </span>
            )}
          </button>
        );
      })}
      {allowEntry && (
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!entry) return;
            if (selected.has(entry) || toggle(entry)) setEntry("");
          }}
        >
          <Input
            aria-label={entryLabel}
            placeholder={entryLabel}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
          />
          <button type="submit">Add</button>
        </form>
      )}
      {refused && (
        <p role="alert" className="px-2 pt-1 text-destructive text-xs">
          {refused}
        </p>
      )}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            column.setFilterValue(undefined);
          }}
          className="mt-1 rounded-sm px-2 py-1 text-center text-muted-foreground text-xs hover:bg-accent"
        >
          {clearLabel}
        </button>
      )}
    </div>
  );
}
