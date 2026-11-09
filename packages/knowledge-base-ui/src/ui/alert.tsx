// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/alert`
 * Purpose: One inline message (error or notice) with role="alert". Vendored because the node UI kit is private.
 * Side-effects: none
 * @internal
 */

import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";

const VARIANTS = {
  default: "border-border bg-muted/40 text-foreground",
  destructive: "border-destructive/50 bg-destructive/10 text-destructive",
} as const;

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  readonly variant?: keyof typeof VARIANTS;
}

export function Alert({ className, variant = "default", ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn("rounded-md border px-3 py-2 text-sm", VARIANTS[variant], className)}
      {...props}
    />
  );
}
