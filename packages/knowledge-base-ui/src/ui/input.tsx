// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/input`
 * Purpose: Minimal shadcn text input for the work board controls, independent of a node's private UI kit (task.0044).
 * Scope: Markup and classes match the node kit's shadcn input.
 * Invariants: Forwards every native input prop and ref.
 * Side-effects: none
 * Links: task.0044
 * @internal
 */

"use client";

import { type ComponentProps, forwardRef } from "react";

import { cn } from "../cn.js";

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";
