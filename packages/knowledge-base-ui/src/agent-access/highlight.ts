// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/highlight`
 * Purpose: An AI's one-time link names one waiting ask (by a token in the URL fragment). The row it opens is scrolled into view and highlighted.
 * Scope: Presentation only, shared by the admin table and the profile table. Salvaged in shape from the reverted #366 `highlightId`, keyed by the
 *   row (principal and permission) the server's preview returned, never by the token.
 * Invariants: HUMAN_SURFACE_TOKENLESS: the one DOM id below holds no token, id or scope string.
 * Side-effects: scrolls the page
 * @internal
 */

"use client";

import { useEffect } from "react";

/** The one DOM id the highlighted row carries. A constant, so no token, user id or scope string reaches the markup. */
export const HIGHLIGHT_DOM_ID = "ai-access-highlight";

/** Scroll the highlighted row into view once it is on the page. jsdom has no scrollIntoView, so it is optional. */
export function useScrollToHighlight(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    document.getElementById(HIGHLIGHT_DOM_ID)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [active]);
}

export const HIGHLIGHT_CLASS = "bg-accent/50 ring-1 ring-ring";
