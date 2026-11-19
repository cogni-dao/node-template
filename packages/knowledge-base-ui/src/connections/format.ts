// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/connections/format`
 * Purpose: Helps a human read an amount at a glance: money is always dollars. The node owns the credits-to-dollars rate and injects it as `Money`, so this
 *   package never copies the rate.
 * Scope: Pure.
 * Side-effects: none
 * @internal
 */

/**
 * The node's money conversion, injected by the page (the node's payments module owns the rate). Amounts on the wire stay integer credits; people see and type
 * dollars only.
 */
export interface Money {
  /** Credits as dollars for display, such as "$5.00". */
  readonly format: (credits: number) => string;
  /** Typed dollars (such as 5 or 0.5) as whole credits, or null when the text is not a positive amount. */
  readonly toCredits: (dollars: number) => number | null;
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
