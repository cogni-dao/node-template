// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/button`
 * Purpose: Minimal shadcn button the work board controls render, so the package never imports a node's private UI kit (task.0044).
 * Scope: Markup and classes match the node kit's shadcn button; class-variance-authority is replaced by two lookup tables.
 * Invariants: Same class strings as the kit for each variant/size, merged with `cn` in the same order.
 * Side-effects: none
 * Links: task.0044
 * @internal
 */

"use client";

import { Slot } from "radix-ui";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { cn } from "../cn.js";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

const VARIANTS = {
  default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
  outline:
    "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
  secondary:
    "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
} as const;

const SIZES = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  icon: "h-9 w-9",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof VARIANTS;
  readonly size?: keyof typeof SIZES;
  readonly asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = "default", size = "default", asChild = false, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot.Root : "button";
    return (
      <Comp
        className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
