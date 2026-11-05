// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Exact global values stay selectable without loading a registry or page facets. */
"use client";
import { EntryTypeSchema, SourceTypeSchema } from "@cogni/knowledge-store";
import type { KnowledgeSummary } from "@cogni/node-contracts";
import type { Column } from "@tanstack/react-table";
import { useState } from "react";

const MAX_FILTER_VALUES = 50;

export function BrowseHeaderFilter({
  column,
  label,
}: {
  readonly column: Column<KnowledgeSummary, string>;
  readonly label: string;
}) {
  const [value, setValue] = useState("");
  const selected = (column.getFilterValue() as string[] | undefined) ?? [];
  const options =
    column.id === "entryType"
      ? EntryTypeSchema.options
      : column.id === "sourceType"
        ? SourceTypeSchema.options
        : [];
  const atCapacity = selected.length >= MAX_FILTER_VALUES;
  const toggle = (entry: string) => {
    if (selected.includes(entry)) {
      column.setFilterValue(selected.filter((v) => v !== entry));
    } else if (!atCapacity) {
      column.setFilterValue([...selected, entry]);
    }
  };
  return (
    <div className="flex min-w-52 flex-col gap-2 p-2">
      <p className="text-muted-foreground text-xs">
        {label} · any selected exact value
      </p>
      {[...new Set([...selected, ...options])].map((entry) => (
        <label key={entry} className="flex items-center gap-2 text-xs">
          <input
            onKeyDown={(e) => e.stopPropagation()}
            type="checkbox"
            checked={selected.includes(entry)}
            disabled={atCapacity && !selected.includes(entry)}
            onChange={() => toggle(entry)}
          />
          {entry}
        </label>
      ))}
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (value && !selected.includes(value)) toggle(value);
          setValue("");
        }}
      >
        <input
          onKeyDown={(e) => e.stopPropagation()}
          maxLength={500}
          aria-label={`Exact ${label}`}
          placeholder={`Exact ${label}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 rounded border bg-background p-1 text-xs"
        />
        <button type="submit" className="text-xs underline">
          Add
        </button>
      </form>
      {atCapacity && (
        <p className="text-muted-foreground text-xs">
          Maximum 50 values selected. Remove one to add another.
        </p>
      )}
      <button
        type="button"
        onClick={() => column.setFilterValue([])}
        className="text-left text-xs underline"
      >
        Clear {label}
      </button>
    </div>
  );
}
