// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/format`
 * Purpose: Helps a human read an amount at a glance: credits are always a short number with their unit ("500 cr").
 * Scope: Pure.
 * Side-effects: none
 * @internal
 */

/** A short amount with its unit: "500 cr", "2,500 cr". */
export function formatCredits(n: number): string {
  return `${n.toLocaleString()} cr`;
}

/** A URL's host, or the raw text when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
