// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/steward`
 * Purpose: The one error type that distinguishes "the server refused the steward withdrawal" from "the outcome is unknown".
 * Scope: Pure error class + a name-based guard. No React: a server action or any non-React caller may throw it.
 * Invariants: A `StewardWithdrawalRejected` means nothing was sent (retry allowed). Every other failure after a POST is an
 *   unknown outcome and the UI must lock until a human checks the wallet. The guard also matches by `name` so two copies
 *   of this package in one tree still agree.
 * Side-effects: none
 * Links: ./react/FinanceReport.tsx (FundSteward)
 * @public
 */

export class StewardWithdrawalRejected extends Error {
  override readonly name = "StewardWithdrawalRejected";
}

/** True for a `StewardWithdrawalRejected` from this or any other copy of the package. */
export function isStewardWithdrawalRejected(error: unknown): boolean {
  return (
    error instanceof StewardWithdrawalRejected ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "StewardWithdrawalRejected")
  );
}
