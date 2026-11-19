// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/ui/alert-dialog`
 * Purpose: Minimal shadcn alert dialog (root, content, title, cancel, action) on the `radix-ui` peer, so a rare destructive action asks one short question in a real dialog (story.0038).
 * Scope: Markup and classes match the node kit's shadcn alert dialog for the parts the connection sections use. Content renders in a portal with an overlay; focus is trapped and Escape cancels (Radix).
 * Invariants: The title is the one sentence; no description is rendered (`aria-describedby` is cleared). Cancel and Action are real buttons of at least 32px (44px on a phone).
 * Side-effects: none
 * @internal
 */

"use client";

import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";

import { cn } from "../cn.js";

export const AlertDialog = AlertDialogPrimitive.Root;

export const AlertDialogContent = forwardRef<
  ComponentRef<typeof AlertDialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80" />
    <AlertDialogPrimitive.Content
      ref={ref}
      aria-describedby={undefined}
      className={cn(
        "fixed top-1/2 left-1/2 z-50 grid w-full max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-md border bg-background p-6 shadow-lg",
        className,
      )}
      {...props}
    />
  </AlertDialogPrimitive.Portal>
));
AlertDialogContent.displayName = "AlertDialogContent";

export const AlertDialogTitle = forwardRef<
  ComponentRef<typeof AlertDialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn("font-semibold text-foreground text-lg", className)} {...props} />
));
AlertDialogTitle.displayName = "AlertDialogTitle";

export const AlertDialogCancel = AlertDialogPrimitive.Cancel;
export const AlertDialogAction = AlertDialogPrimitive.Action;
