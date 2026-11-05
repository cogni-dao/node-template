// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/cn`
 * Purpose: Merge conditional class names with Tailwind-aware deduplication for the package's own primitives (task.0041).
 * Scope: Wraps the clsx + tailwind-merge peers; the same contract as a node's own `cn`, without importing a node UI kit.
 * Invariants: Returns a single string; filters falsy values; merges Tailwind conflicts.
 * Side-effects: none
 * Links: task.0041
 * @public
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
