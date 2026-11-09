// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/chip`
 * Purpose: A small status label (risk level, Allowed). Vendored because the node UI kit is private.
 * Side-effects: none
 * @internal
 */

import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";

const TONES = {
  neutral: "border-border bg-muted text-muted-foreground",
  // App theme tokens (--color-success, --color-warning) for the tint, so every theme applies; the label stays foreground
  // so it keeps its contrast on the light tint.
  success: "border-transparent bg-success/15 text-foreground",
  warning: "border-transparent bg-warning/15 text-foreground",
  danger: "border-transparent bg-destructive/15 text-destructive",
} as const;

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: keyof typeof TONES;
}

export function Chip({ className, tone = "neutral", ...props }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-medium text-xs",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
