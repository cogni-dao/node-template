// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/account-credits`
 * Purpose: Factory for `AccountCreditsCapability`: the tool twin of `GET /api/v1/accounts/{accountId}/credits`.
 * Scope: Reads the credit balance of the account the run acts on (`scope.billing.billingAccountId`) as the ACTING PRINCIPAL, in an app-role tenant
 *   transaction. Decides nothing itself: the guard already offered and ran the tool only for a principal with a live `account:read` row for this
 *   account, and row-level security (`agent_has_scope`) repeats that test in the database.
 * Invariants:
 *   - RLS_DECIDES_ROWS: the read runs as the principal under the app role, never the service role. No live grant means no row, so `null`.
 *   - ACCOUNT_FROM_THE_RUN: the account is the run's account; the model cannot name another.
 * Side-effects: IO (one RLS-scoped read)
 * Links: packages/agent-grants (authorizeAccount), https://cognidao.org/knowledge/node-capability-grants-standard
 * @internal
 */

import type { AccountCreditsCapability } from "@cogni/ai-tools";
import { toUserId, type UserId } from "@cogni/ids";

import { getExecutionScope } from "@/adapters/server";
import { type AccountService, isBillingAccountNotFoundPortError } from "@/ports";

export interface AccountCreditsCapabilityDeps {
  /** An account service bound to one actor (RLS enforced). */
  readonly accountsForUser: (userId: UserId) => AccountService;
}

export function createAccountCreditsCapability(deps: AccountCreditsCapabilityDeps): AccountCreditsCapability {
  return {
    async read() {
      const scope = getExecutionScope();
      // The acting principal, bound for this tool call by the guard. A run with none reads nothing.
      if (!scope.principalId) return null;
      const billingAccountId = scope.billing.billingAccountId;
      try {
        const balanceCredits = await deps.accountsForUser(toUserId(scope.principalId)).getBalance(billingAccountId);
        return { billingAccountId, balanceCredits };
      } catch (error) {
        // RLS hides a foreign, ended or missing account: the same "not found" for all three.
        if (isBillingAccountNotFoundPortError(error)) return null;
        throw error;
      }
    },
  };
}
