// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ReactElement } from "react";

export interface WorkMetric {
  readonly metricId: string;
  readonly baselineObservationId?: string | null | undefined;
  readonly direction: "up" | "down" | null;
  readonly moved?: "as_declared" | "against" | "flat" | "unknown" | null | undefined;
  readonly unknownReason?: string | undefined;
  readonly baseline?:
    | {
        readonly value: number | null;
        readonly observedAt: string | null;
        readonly unit?: string | undefined;
        readonly id?: string | undefined;
      }
    | null
    | undefined;
  readonly current?:
    | {
        readonly value: number | null;
        readonly observedAt: string | null;
        readonly unit?: string | undefined;
        readonly id?: string | undefined;
        readonly status?: string | undefined;
        readonly viewState?: string | undefined;
        readonly metricTitle?: string | undefined;
      }
    | null
    | undefined;
}

export function workMetricVerdict(move: WorkMetric): string {
  if (move.direction === null)
    return move.unknownReason || (move.current?.viewState && move.current.viewState !== "ok")
      ? "affected · unknown"
      : "affected";
  return move.moved === "as_declared"
    ? "as expected"
    : move.moved === "against"
      ? "against expectation"
      : move.moved === "flat"
        ? "flat"
        : "unknown";
}

/** The expected direction as a glyph; null when the move names none. */
export function workMetricArrow(direction: WorkMetric["direction"]): "↑" | "↓" | null {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : null;
}

/** The Metric column and board line: the metric's title, its expected direction and the result. */
export function WorkMetricSummary({ move }: { readonly move: WorkMetric }): ReactElement {
  const arrow = workMetricArrow(move.direction);
  return (
    <span className="line-clamp-2 break-words text-muted-foreground text-xs">
      {arrow && (
        <span
          role="img"
          aria-label={move.direction === "up" ? "expected to rise" : "expected to fall"}
          className="mr-1 font-semibold text-foreground"
        >
          {arrow}
        </span>
      )}
      {move.current?.metricTitle ?? move.metricId} · {workMetricVerdict(move)}
    </span>
  );
}
