// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/payments/utils/formatDollars`
 * Purpose: The one way a credit amount is shown to a person as dollars (the credits page and the org pages).
 * Scope: Formatting only. The rate is `creditsToUsd` from `@cogni/node-core` (protocol constant CREDITS_PER_USD); this file holds no copy of it.
 * Invariants: Two decimals, grouped digits, no currency symbol (the caller adds "$").
 * Side-effects: none
 * @public
 */

import { creditsToUsd } from "@cogni/node-core";

export function formatCreditsAsDollars(credits: number): string {
  return creditsToUsd(credits).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
