// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/accounts/[accountId]/credits`
 * Purpose: The ONE scoped account read of the agent-grants PoC — the credit
 *   balance of an account the caller owns or holds an `account:read` grant on.
 * Scope: Thin route — auth (bearer or session), authorize() and the read in
 *   one RLS tenant transaction, response.
 * Invariants:
 *   - AUTHORIZE_THEN_RLS: authorize() must allow AND the RLS-clamped read must
 *     return the row (billing_accounts delegated policy, migration 0034).
 *   - NON_DISCLOSING_DENIAL: unknown account, foreign account, missing,
 *     expired, revoked, or wrong-scope grant are all the same 404.
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { authorize } from "@cogni-dao/agent-grants";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  ACCOUNT_READ_SCOPE,
  notFoundResponse,
  withPrincipalTx,
} from "@/app/_lib/agent-grants/node-agent-grants";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { billingAccounts } from "@/shared/db/schema";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ accountId: string }>;
}>(
  {
    routeId: "accounts.credits.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser || !context) return notFoundResponse();
    const { accountId } = await context.params;

    const result = await withPrincipalTx(sessionUser.id, async (tx) => {
      const access = await authorize(tx, {
        principalId: sessionUser.id,
        accountId,
        requiredScope: ACCOUNT_READ_SCOPE,
      });
      if (!access) return null;
      const [row] = await tx
        .select({ balanceCredits: billingAccounts.balanceCredits })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
        .limit(1);
      return row ? { access, balanceCredits: row.balanceCredits } : null;
    });

    if (!result) {
      logEvent(ctx.log, EVENT_NAMES.ACCOUNT_READ_DENIED, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        principalId: sessionUser.id,
        accountId,
        scope: ACCOUNT_READ_SCOPE,
        outcome: "error",
        errorCode: "not_authorized",
      });
      return notFoundResponse();
    }
    logEvent(ctx.log, EVENT_NAMES.ACCOUNT_READ_ALLOWED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      principalId: sessionUser.id,
      accountId,
      scope: ACCOUNT_READ_SCOPE,
      accessKind: result.access.accessKind,
      grantId: result.access.grantId,
      outcome: "success",
    });
    return NextResponse.json({
      accountId,
      balanceCredits: result.balanceCredits.toString(),
      accessKind: result.access.accessKind,
    });
  }
);
