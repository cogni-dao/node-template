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

/** One row's failure: a short line in the destructive tone, with the HTTP status (when there is one) only as its tooltip. */
export interface RowFailure {
  /** The row it belongs to (an alias or an org user id). */
  readonly rowId: string;
  readonly text: string;
  /** The HTTP status, shown only as a title. */
  readonly code: number | null;
}

/**
 * The words for a failed click, never a raw status: 401 and 403 are "Not allowed.", a 409 whose code is `stale_seq` or `seq_jump` is "Out of sync. Try again.", anything else is `fallback`
 * ("Couldn't connect." on the customer's page, "Couldn't save." on the provider's).
 */
export function failureText(status: number | null, fallback: string, errorCode?: string | null): string {
  if (status === 401 || status === 403) return "Not allowed.";
  if (status === 409 && (errorCode === "stale_seq" || errorCode === "seq_jump")) return "Out of sync. Try again.";
  return fallback;
}
