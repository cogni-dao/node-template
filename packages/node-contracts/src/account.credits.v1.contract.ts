// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/account.credits.v1`
 * Purpose: Contract for GET /api/v1/accounts/{accountId}/credits: the credit balance of ONE account the caller may read. The caller is the account's
 *   owner, or an AI the owner opened it to (the personal `account:read` grant, turned On on the owner's profile).
 * Scope: Output shape only. Authority is `authorizeAccount()` plus RLS; an answer of "no" is one non-disclosing 404 `not_found`.
 * Invariants: CONTRACTS_ARE_TRUTH. ACCOUNT_NAMED_BY_THE_PATH: the account id comes from the path and is never resolved from the caller.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard (A5)
 * @public
 */

import { z } from "zod";

export const accountCreditsOperation = {
  id: "account.credits.v1",
  output: z.object({
    accountId: z.string().min(1),
    balanceCredits: z.number().nonnegative(),
  }),
} as const;
