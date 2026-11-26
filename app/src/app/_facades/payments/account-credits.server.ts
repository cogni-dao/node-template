// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/payments/account-credits.server`
 * Purpose: Read ONE account's credit summary (balance and ledger) as the CALLER, for the gated account reads: `GET /api/v1/accounts/{accountId}/credits` and
 *   `GET /api/v1/payments/credits/summary?accountId=`. Both are the route twins of the tool `core__account_credits_read` (scope `account:read`, the one
 *   account scope: "Read your account data").
 * Scope: Server-only. The door (`sameDoor` + an account param) has already decided owner | delegated | nothing; this reads under row-level security.
 * Invariants:
 *   - RLS_DECIDES_ROWS: the read runs in an app-role tenant transaction with `app.current_user_id` = the CALLER (the owner, or the agent), so a delegated agent sees rows only through
 *     `agent_has_scope` and the door and the database cannot disagree.
 *   - ORG_OWNER_SCOPE (task.0181): row-level security keys an account on its `owner_user_id`, and an org's account belongs to the org's own users row, so an org role (`org:owner`,
 *     `org:admin`) can never read it as the caller. After the door allowed, a caller who holds an org role on THIS account reads it through the org owner's scope: the database user is
 *     the account's `owner_user_id`, taken on the server from the account row, never from the request (the same read the payer path uses, `payerScopeUserFor`). Owner and delegated-AI
 *     reads are unchanged.
 *   - ACCOUNT_404_NON_DISCLOSING: an account the database hides from the caller is `null`; the route answers one 404.
 * Side-effects: IO (RLS-scoped reads of billing_accounts and credit_ledger)
 * @public
 */

import { toUserId } from "@cogni/ids";
import type { CreditsSummaryOutput } from "@cogni/node-contracts";

import { getContainer } from "@/bootstrap/container";
import { getCreditsSummary } from "@/features/payments/services/creditsSummary";
import { isBillingAccountNotFoundPortError } from "@/ports";

/**
 * Whose scope reads this account: the caller's own (an owner, or an AI with an `account:read` grant), or, for a caller who holds an org role on this very account, the org's own users id.
 * The door has already allowed the caller; this only picks the database user. A caller with no org role keeps their own scope, so a stranger or a removed admin still gets the 404.
 */
async function readerOf(container: ReturnType<typeof getContainer>, callerUserId: string, accountId: string): Promise<string> {
  if (!(await container.agentAuthority.holdsOrgRole({ callerUserId, accountId }))) return callerUserId;
  const account = await container.serviceAccountService.getBillingAccountById(accountId);
  if (!account || (await container.agentAuthority.principalKind(account.ownerUserId)) !== "org") return callerUserId;
  return account.ownerUserId;
}

export async function readAccountCredits(params: {
  /** The caller's user id: the RLS actor. */
  callerUserId: string;
  accountId: string;
  limit?: number | undefined;
}): Promise<CreditsSummaryOutput | null> {
  try {
    const container = getContainer();
    const actor = await readerOf(container, params.callerUserId, params.accountId);
    const summary = await getCreditsSummary(container.accountsForUser(toUserId(actor)), {
      billingAccountId: params.accountId,
      limit: params.limit,
    });
    return {
      billingAccountId: summary.billingAccountId,
      balanceCredits: summary.balanceCredits,
      ledger: summary.ledger.map((entry) => ({
        id: entry.id,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        reason: entry.reason,
        reference: entry.reference,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    // RLS returned no row for this caller (the door agreed, the database did not, or the account vanished): the same 404.
    if (isBillingAccountNotFoundPortError(error)) return null;
    throw error;
  }
}
