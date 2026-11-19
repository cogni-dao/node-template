// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/badge`
 * Purpose: The one small outlined tag of the admin tables ("outside", "Disconnected", "Suspended").
 * Scope: Presentation only. Tokens only.
 * Side-effects: none
 * @internal
 */

import type { ReactNode } from "react";

import { cn } from "../cn.js";

export function Badge(props: { children: ReactNode; tone?: "default" | "destructive"; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 font-medium text-xs",
        props.tone === "destructive" ? "border-destructive text-destructive" : "border-foreground/40 text-foreground",
        props.className
      )}
    >
      {props.children}
    </span>
  );
}
