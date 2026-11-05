// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/relative-time`
 * Purpose: Human-friendly relative timestamp presenter used by the shared work board (task.0041).
 * Scope: Pure presentation. Storage stays ISO; this is the human-view projection. No I/O.
 * Invariants:
 *   - MISSING_IS_DASH: an empty or absent ISO renders an em dash, never a `<time>` element.
 *   - ISO_IN_TOOLTIP: the absolute ISO is the `dateTime` attribute and the title.
 * Side-effects: none
 * Links: task.0041, story.0018
 * @public
 */

"use client";

import type { ReactElement } from "react";

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DTF_SAME_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});
const DTF_OTHER_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Format an ISO timestamp as a human-friendly relative string.
 *
 *   < 1 min     → "just now"
 *   < 60 min    → "5 minutes ago"
 *   < 24 hr     → "3 hours ago"
 *   < 7 days    → "2 days ago"
 *   ≥ 7 days    → "May 12" (same year) or "May 12, 2025" (different year)
 *
 * Returns the input unchanged if it is not a parseable timestamp.
 */
export function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return RTF.format(-diffMin, "minute");
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return RTF.format(-diffHr, "hour");
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return RTF.format(-diffDay, "day");
  const d = new Date(ms);
  return (
    d.getFullYear() === new Date().getFullYear()
      ? DTF_SAME_YEAR
      : DTF_OTHER_YEAR
  ).format(d);
}

export interface RelativeTimeProps {
  readonly iso: string | null | undefined;
  readonly className?: string;
}

/**
 * Inline `<time>` element rendering the relative form, with the absolute ISO
 * available in the tooltip + as `dateTime` for accessibility.
 */
export function RelativeTime({
  iso,
  className,
}: RelativeTimeProps): ReactElement {
  if (!iso) {
    return (
      <span className={className ?? "text-muted-foreground"}>&mdash;</span>
    );
  }
  return (
    <time
      dateTime={iso}
      title={iso}
      className={className ?? "text-muted-foreground text-xs"}
    >
      {formatRelativeTime(iso)}
    </time>
  );
}
