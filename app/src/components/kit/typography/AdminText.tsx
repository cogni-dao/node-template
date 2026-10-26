// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { cn } from "@cogni/node-ui-kit/util/cn";
/**
 * Module: `@components/kit/typography/AdminText`
 * Purpose: Compact semantic text hierarchy for administrative reports.
 * Scope: Presentation only; existing theme tokens, no data or domain rules.
 * Invariants: Feature callers choose typed variants, not typography classes.
 * Side-effects: none
 * Links: src/styles/ui/typography.ts
 * @public
 */
import type { VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { adminText } from "@/styles/ui";

export function AdminText({
  as: Tag = "p",
  variant,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "role"> &
  VariantProps<typeof adminText> & {
    as?: "h1" | "h2" | "h3" | "p" | "span" | "div" | "dt" | "dd";
  }) {
  return <Tag {...props} className={cn(adminText({ variant }), className)} />;
}
