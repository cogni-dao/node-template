// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (range-toggle)
 * Purpose: The single-select 1D / 1W / 1M / 3M control of the open chart, on the `radix-ui` toggle group, so the package never imports a node's private UI kit.
 * Scope: Markup and classes match the node kit's shadcn ToggleGroup at size `sm`.
 * Invariants: A radix single group reports "" when the active item is pressed again; `onValueChange` is only called with a real range, so one range is always selected.
 * Side-effects: none
 * Links: ./kpi-chart.tsx
 * @internal
 */

"use client";

import { ToggleGroup } from "radix-ui";

import { cn } from "../cn.js";
import { HISTORY_RANGES, type HistoryRange } from "./presentation.js";

const ITEM =
  "inline-flex h-7 min-w-8 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-transparent px-2.5 font-medium text-xs outline-none transition-[color,box-shadow] hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground";

export function RangeToggle({
  value,
  onChange,
}: {
  readonly value: HistoryRange;
  readonly onChange: (range: HistoryRange) => void;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as HistoryRange)}
      aria-label="Chart range"
      className="flex items-center justify-center gap-1 rounded-lg border border-border/70 p-1"
    >
      {HISTORY_RANGES.map((r) => (
        <ToggleGroup.Item key={r.id} value={r.id} className={cn(ITEM)}>
          {r.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
