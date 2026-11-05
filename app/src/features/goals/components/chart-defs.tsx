// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/components/chart-defs`
 * Purpose: The SVG paint servers of a goal chart: the area gradient and the
 *   two gap textures (missing = 45° hatch; failed = 45° + 135° cross-hatch).
 * Scope: A plain function, not a component, called inline as a direct child of
 *   a Recharts chart. Recharts 2.15.4 renderByOrder keeps only lowercase SVG
 *   tags and registered Recharts types, so a custom <ChartDefs/> would vanish.
 * Invariants: ONLY_RAW_SVG_FILE (the one goals file that may emit raw SVG);
 *   ids come from the caller's sanitized useId, so several charts never collide.
 *   Every chart and series takes an explicit id: Recharts' default clip ids
 *   come from a process-global counter that differs between SSR and client.
 * Side-effects: none
 * Links: ./TimeSeriesCard.tsx
 * @public
 */

import type { ReactElement } from "react";

export interface ChartIds {
  /** Passed as `id` to the chart: Recharts' clip-path id, stable across SSR. */
  readonly chart: string;
  /** Passed as `id` to the Area/Line/Bar: its clip-path id, stable across SSR. */
  readonly series: string;
  readonly fill: string;
  readonly gapMissing: string;
  readonly gapFailed: string;
}

/** Ids from React's useId, stripped to [\w-] so url(#id) always resolves. */
export function chartIds(rawId: string): ChartIds {
  const id = `goal-chart-${rawId.replace(/[^\w-]/g, "")}`;
  return {
    chart: id,
    series: `${id}-series`,
    fill: `${id}-fill`,
    gapMissing: `${id}-gap-missing`,
    gapFailed: `${id}-gap-failed`,
  };
}

export function chartDefs(ids: ChartIds): ReactElement {
  return (
    <defs key="goal-chart-defs">
      <linearGradient id={ids.fill} x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.28} />
        <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.04} />
      </linearGradient>
      <pattern
        id={ids.gapMissing}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <path
          d="M0 0V6"
          stroke="hsl(var(--muted-foreground))"
          strokeOpacity={0.3}
          strokeWidth={1.5}
        />
      </pattern>
      <pattern
        id={ids.gapFailed}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <path
          d="M0 0V6M0 0H6"
          stroke="hsl(var(--muted-foreground))"
          strokeOpacity={0.55}
          strokeWidth={1.5}
        />
      </pattern>
    </defs>
  );
}
