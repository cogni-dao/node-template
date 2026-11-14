// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/account-credits`
 * Purpose: Capability interface for reading ONE account's credit balance, for the tool twin of `GET /api/v1/accounts/{accountId}/credits`.
 * Scope: Interface only. The implementation (injected at bootstrap) reads the run's account as the acting principal, under row-level security.
 * Invariants:
 *   - ACCOUNT_FROM_THE_RUN: the tool takes no account argument. The account is the one the run acts on (the person who owns the schedule or chat),
 *     so a model can never name another person's account.
 *   - RLS_DECIDES_ROWS: the implementation reads in an app-role tenant transaction as the acting principal; an account the principal holds no live
 *     grant for returns nothing.
 * Side-effects: none (interface only)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

export interface AccountCreditsInfo {
  readonly billingAccountId: string;
  readonly balanceCredits: number;
}

export interface AccountCreditsCapability {
  /** The credit balance of the run's account, or null when the acting principal may not read it (no live grant, or no such account). */
  read(): Promise<AccountCreditsInfo | null>;
}
