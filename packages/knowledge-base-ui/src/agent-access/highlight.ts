// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/highlight`
 * Purpose: A deep link (`?request=<id>`, `?claim=<id>`) names one row. The row is scrolled into view and highlighted.
 * Scope: Presentation only, shared by the admin table and the owner's "Your AIs".
 * Side-effects: scrolls the page
 * @internal
 */

"use client";

import { useEffect } from "react";

/** Scroll the highlighted row into view once it is on the page. jsdom has no scrollIntoView, so it is optional. */
export function useScrollToHighlight(domId: string | null, ready: boolean): void {
  useEffect(() => {
    if (!ready || !domId) return;
    document.getElementById(domId)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [domId, ready]);
}

export const HIGHLIGHT_CLASS = "bg-accent/50 ring-1 ring-ring";
