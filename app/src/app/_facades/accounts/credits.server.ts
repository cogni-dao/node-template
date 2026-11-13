// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/accounts/credits.server`
 * Purpose: App-layer read of ONE named account's credit balance, for `GET /api/v1/accounts/{accountId}/credits`.
 * Scope: Server-only. Reads through the account service with the CALLER as the RLS context user (`getBalance` under `withTenantScope`), so the database
 *   decides again after the route's `authorizeAccount()` allowed. Decides no authority itself.
 * Invariants:
 *   - RLS_BACKSTOP: the context user is the caller, never the account's owner. An agent sees the owner's row only through the `billing_accounts_agent_grant_read`
 *     policy (a live personal `account:read` grant). No grant, an expired or revoked grant, or another person's account reads zero rows: `null`.
 *   - ACCOUNT_NAMED_BY_THE_PATH: the account id is the caller's input; nothing here resolves "the" account from the caller.
 * Side-effects: IO (via the AccountService port)
 * Links: packages/agent-grants (authorizeAccount), https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { toUserId } from "@cogni/ids";
import { getContainer } from "@/bootstrap/container";
import { isBillingAccountNotFoundPortError } from "@/ports";

/** The balance, or null when the database shows the caller no such account. */
export async function getAccountBalanceFacade(params: {
  callerUserId: string;
  accountId: string;
}): Promise<{ accountId: string; balanceCredits: number } | null> {
  const accountService = getContainer().accountsForUser(toUserId(params.callerUserId));
  try {
    return {
      accountId: params.accountId,
      balanceCredits: await accountService.getBalance(params.accountId),
    };
  } catch (error) {
    if (isBillingAccountNotFoundPortError(error)) return null;
    throw error;
  }
}
