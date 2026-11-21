// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/ui/PhaseList`
 * Purpose: Inline vertical checklist for a short, ordered workflow.
 * Scope: Presentational. Renders one row per phase with text plus a done/active/pending/error glyph.
 * Invariants: Status is never communicated by color alone; domain state and actions stay in callers.
 * Side-effects: none
 * Links: src/app/(app)/gov/review/view.tsx
 * @public
 */

import { cn } from "../../cn";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";

export type PhaseState = "done" | "active" | "pending" | "error";

export interface Phase {
  readonly label: string;
  readonly state: PhaseState;
  readonly detail?: string;
  readonly href?: string;
}

function PhaseGlyph({ state }: { readonly state: PhaseState }): ReactElement {
  switch (state) {
    case "done":
      return (
        <CheckCircle2 aria-hidden="true" className="text-success size-5" />
      );
    case "active":
      return (
        <Loader2
          aria-hidden="true"
          className="text-primary size-5 animate-spin"
        />
      );
    case "error":
      return <XCircle aria-hidden="true" className="text-destructive size-5" />;
    case "pending":
      return (
        <Circle
          aria-hidden="true"
          className="text-muted-foreground/40 size-5"
        />
      );
  }
}

export function PhaseList({
  phases,
}: {
  readonly phases: readonly Phase[];
}): ReactElement {
  return (
    <ol className="space-y-3">
      {phases.map((phase) => (
        <li key={phase.label} className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 shrink-0">
            <PhaseGlyph state={phase.state} />
          </span>
          <span className="min-w-0 text-sm">
            <span
              className={cn(
                "block",
                phase.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground",
                phase.state === "active" && "font-medium"
              )}
            >
              {phase.label}
            </span>
            {phase.detail ? (
              <span className="text-muted-foreground block text-xs break-words">
                {phase.detail}
              </span>
            ) : null}
            {phase.href ? (
              <a
                href={phase.href}
                target="_blank"
                rel="noreferrer"
                className="text-primary block text-xs break-all underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
