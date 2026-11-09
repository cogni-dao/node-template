// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/skeleton`
 * Purpose: A pulsing placeholder block while data loads. Vendored because the node UI kit is private.
 * Side-effects: none
 * @internal
 */

import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
