// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/approval-fragment`
 * Purpose: The one-time approval link rides in the URL fragment (`#agent-request=<token>`), so no server, log or referrer ever sees it. This module
 *   reads it where it is used and removes it everywhere else.
 *   - `useApprovalFragment()` runs on the two pages that open an approval link (`/profile`, `/admin/ai-access`): it reads the token, removes it from
 *     the address bar and history entry at once, and hands the token to the page, which highlights the row and sends the token back to decide.
 *   - `ApprovalFragmentScrub` lives in the root layout: on every other path it removes the fragment, so a link opened on the wrong page leaves nothing behind.
 * Scope: Browser only (`window.location`, `history.replaceState`). Touches only the `agent-request` key; any other fragment value (for example
 *   `#attestation=<jwt>`) is left exactly as it was.
 * Invariants:
 *   - HUMAN_SURFACE_TOKENLESS: a person never sees, types or copies a token; it is stripped from history on landing.
 *   - STRIP_ONLY_OUR_KEY: other fragment parameters survive, in their original order.
 * Side-effects: `history.replaceState`
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

"use client";

import { useEffect, useState } from "react";

/** The fragment key that carries the one-time link token. Equal to `APPROVAL_FRAGMENT_KEY` in `@cogni-dao/agent-grants`. */
export const APPROVAL_FRAGMENT_PARAM = "agent-request";

/** The two pages that open an approval link, and so keep the fragment until their hook has read it. */
export const APPROVAL_PAGES: readonly string[] = ["/profile", "/admin/ai-access"];

const isApprovalPage = (pathname: string): boolean =>
  APPROVAL_PAGES.some((page) => pathname === page || pathname === `${page}/`);

/** The token in a hash like `#agent-request=T&x=y`, and the hash without it (null when no other value remains). */
export function splitApprovalFragment(hash: string): { token: string | null; rest: string | null } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { token: null, rest: null };
  const parts = raw.split("&");
  let token: string | null = null;
  const kept: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key === APPROVAL_FRAGMENT_PARAM && token === null) {
      token = eq === -1 ? "" : part.slice(eq + 1);
      continue;
    }
    kept.push(part);
  }
  return { token: token === null ? null : token, rest: kept.length > 0 ? kept.join("&") : null };
}

/** Remove our key from the address bar and the current history entry. Returns the token that was there, or null. */
function stripFromAddressBar(): string | null {
  if (typeof window === "undefined") return null;
  const { token, rest } = splitApprovalFragment(window.location.hash);
  if (token === null) return null;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
  return token;
}

/**
 * For a page that opens an approval link: the token from the fragment (read once, removed from the address bar at once), or null.
 * The token is kept in state, so a re-render never loses it; it is gone on the next page load.
 */
export function useApprovalFragment(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const found = stripFromAddressBar();
    if (found) setToken(found);
  }, []);
  return token;
}

/**
 * For the root layout: removes `#agent-request=` on every path except the two approval pages. `pathname` is optional; pass the router's pathname so a
 * client-side navigation re-runs the check (a full page load always does).
 */
export function ApprovalFragmentScrub({ pathname }: { readonly pathname?: string | undefined }): null {
  useEffect(() => {
    const scrub = () => {
      if (typeof window === "undefined") return;
      if (!isApprovalPage(pathname ?? window.location.pathname)) stripFromAddressBar();
    };
    scrub();
    window.addEventListener("hashchange", scrub);
    return () => window.removeEventListener("hashchange", scrub);
  }, [pathname]);
  return null;
}
