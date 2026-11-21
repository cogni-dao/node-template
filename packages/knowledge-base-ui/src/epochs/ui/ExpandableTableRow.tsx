// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/ui/ExpandableTableRow`
 * Purpose: Reusable expandable row for shadcn Table — click to reveal detail content.
 * Scope: Kit component. Wraps TableRow + TableCell with expand/collapse state. Does not perform data fetching or server-side logic.
 * Invariants: Supports nesting (expandedContent can contain another Table with ExpandableTableRows).
 * Side-effects: none
 * Links: src/components/vendor/shadcn/table.tsx
 * @public
 */

"use client";

import { TableCell, TableRow } from "./table";
import { cn } from "../../cn";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

interface ExpandableTableRowProps {
  readonly cells: readonly ReactNode[];
  /** Optional className per cell (same index as cells). */
  readonly cellClassNames?: readonly (string | undefined)[];
  /** Legacy: free-form content rendered in a single colSpan cell. */
  readonly expandedContent?: ReactNode;
  /** Preferred: pre-built TableRow elements rendered as siblings when expanded. */
  readonly expandedRows?: readonly ReactNode[];
  readonly colSpan: number;
  readonly defaultExpanded?: boolean;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly className?: string;
}

export function ExpandableTableRow({
  cells,
  cellClassNames,
  expandedContent,
  expandedRows,
  colSpan,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  className,
}: ExpandableTableRowProps): ReactElement {
  const [localExpanded, setExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? localExpanded;
  const toggle = () => {
    setExpanded(!expanded);
    onExpandedChange?.(!expanded);
  };
  const hasRows = expandedRows != null && expandedRows.length > 0;
  const hasContent = hasRows || expandedContent != null;

  return (
    <>
      <TableRow
        className={cn(
          hasContent && "cursor-pointer select-none",
          expanded && "bg-muted/30",
          className
        )}
        onClick={hasContent ? toggle : undefined}
      >
        <TableCell className="w-8 px-2">
          {hasContent ? (
            <button
              type="button"
              aria-label={expanded ? "Collapse details" : "Expand details"}
              aria-expanded={expanded}
              className="focus-visible:ring-ring flex min-h-11 min-w-11 items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                toggle();
              }}
            >
              {expanded ? (
                <ChevronDown className="text-muted-foreground h-4 w-4" />
              ) : (
                <ChevronRight className="text-muted-foreground h-4 w-4" />
              )}
            </button>
          ) : (
            <span className="inline-block w-4" />
          )}
        </TableCell>
        {cells.map((cell, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static column order
          <TableCell key={i} className={cellClassNames?.[i]}>
            {cell}
          </TableCell>
        ))}
      </TableRow>
      {expanded && hasRows && expandedRows}
      {expanded && !hasRows && expandedContent != null && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="p-0">
            <div className="border-muted bg-muted/10 border-t px-4 py-3">
              {expandedContent}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
