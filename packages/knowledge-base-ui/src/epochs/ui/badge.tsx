// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ReactNode } from "react";
import { cn } from "../../cn";
const tones = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "text-foreground",
};
export function Badge({
  intent = "default",
  size = "md",
  className,
  children,
}: {
  intent?: keyof typeof tones;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        tones[intent],
        size === "sm" && "px-2 py-0.5",
        className
      )}
    >
      {children}
    </span>
  );
}
