// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/payments/credits.server`
 * Purpose: App-layer wiring for credits summary. Resolves dependencies, delegates to feature services, and maps port types to contract DTOs.
 * Scope: Server-only facade. Handles billing account resolution from session user, maps Date to ISO string for contract compliance; does not perform direct persistence or HTTP handling.
 * Invariants: Billing account from session identity only; return types use z.infer; Date fields map to ISO strings.
 * Side-effects: IO (via AccountService port).
 * Notes: Errors bubble to route handlers for HTTP mapping. Facades own DTO mapping (port types → contract types).
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/payments-design.md, src/contracts/AGENTS.md
 * @public
 */

import type { CreditsSummaryOutput } from "@cogni/node-contracts";
import type { SessionUser } from "@cogni/node-shared";
import { getContainer } from "@/bootstrap/container";
import { getCreditsSummary } from "@/features/payments/services/creditsSummary";
import type { RequestContext } from "@/shared/observability";
import { resolvePaymentAccount } from "./funding-account.server";

export async function getCreditsSummaryFacade(
  params: {
    sessionUser: SessionUser;
    limit?: number | undefined;
    /** An org account the caller funds (org:admin only, decided by identity); else the caller's own. */
    billingAccountId?: string | undefined;
  },
  _ctx: RequestContext
): Promise<CreditsSummaryOutput> {
  const container = getContainer();
  const { rlsUserId, billingAccount } = await resolvePaymentAccount(
    container,
    params.sessionUser,
    params.billingAccountId
  );
  const accountService = container.accountsForUser(rlsUserId);

  const result = await getCreditsSummary(accountService, {
    billingAccountId: billingAccount.id,
    limit: params.limit,
  });

  // Map port types (Date) to contract types (ISO string)
  return {
    billingAccountId: result.billingAccountId,
    balanceCredits: result.balanceCredits,
    ledger: result.ledger.map((entry) => ({
      id: entry.id,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      reference: entry.reference,
      metadata: entry.metadata,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}
