// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (chart)
 * Purpose: The minimal Recharts frame the Goals marks draw in, so the package never imports a node's private UI kit.
 * Scope: A responsive container that exposes each series colour as `--color-{key}` (the contract the marks' `var(--color-v)` fills read), plus the Recharts tooltip.
 * Invariants: Same container classes as the node kit's shadcn chart, merged with `cn`; the series colour is an inline custom property, so no generated `<style>` block is needed.
 * Side-effects: none
 * Links: ./marks.tsx
 * @internal
 */

"use client";

import {
  type ComponentProps,
  type CSSProperties,
  forwardRef,
  type ReactElement,
} from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "../cn.js";

export type ChartConfig = Record<string, { label?: string; color: string }>;

export const ChartTooltip = RechartsPrimitive.Tooltip;

export const ChartContainer = forwardRef<
  HTMLDivElement,
  Omit<ComponentProps<"div">, "children"> & {
    readonly config: ChartConfig;
    readonly children: ReactElement;
  }
>(({ className, children, config, style, ...props }, ref) => {
  const colors: Record<string, string> = {};
  for (const [key, item] of Object.entries(config))
    colors[`--color-${key}`] = item.color;
  return (
    <div
      ref={ref}
      style={{ ...(colors as CSSProperties), ...style }}
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
        className
      )}
      {...props}
    >
      <RechartsPrimitive.ResponsiveContainer>
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  );
});
ChartContainer.displayName = "GoalsChart";
