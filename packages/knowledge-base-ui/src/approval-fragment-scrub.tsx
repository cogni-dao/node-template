// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/approval-fragment-scrub`
 * Purpose: Removes an AI approval token (`#agent-request=...`) from the address bar on every page except /profile.
 * Scope: A client component the node mounts once in its root Providers (the root client boundary). Runs once, on first client mount.
 * Invariants:
 *   - Removes only the `#agent-request=` fragment; any other fragment (for example `#attestation=`) is left alone.
 *   - On `/profile` it does nothing: the profile page reads and removes the token itself.
 *   - It does not protect against a script that reads the URL before hydration.
 * Side-effects: history.replaceState
 * Links: https://cognidao.org/knowledge/ai-access-surface-design (Token scrub)
 * @public
 */

"use client";

import { useEffect } from "react";

export const APPROVAL_FRAGMENT_PREFIX = "#agent-request=";

/** Pure rule, exported for tests: should this location's fragment be removed? */
export function shouldScrubApprovalFragment(location: {
  pathname: string;
  hash: string;
}): boolean {
  return (
    location.pathname !== "/profile" &&
    location.hash.startsWith(APPROVAL_FRAGMENT_PREFIX)
  );
}

export function ApprovalFragmentScrub(): null {
  useEffect(() => {
    if (!shouldScrubApprovalFragment(window.location)) return;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);
  return null;
}
