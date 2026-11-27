// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/payments/credits/summary`
 * Purpose: HTTP endpoint to fetch billing balance and recent credit ledger entries for widget payments UI.
 * Scope: Enforces SIWE session, validates query params with contract schema, delegates to payments facade; does not access database directly or perform DTO mapping.
 * Invariants: Billing account derived from the session by default; `?accountId=` names another account and runs the account door (sameDoor account:read: owner, or a delegated agent, else one 404); returns ledger ordered newest first; facade handles all DTO mapping.
 * Side-effects: IO (reads billing data via AccountService port).
 * Notes: Used by /credits page for balance and history display. Routes are thin validators; DTO mapping happens in facades.
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/payments-design.md, src/contracts/AGENTS.md
 * @public
 */

import { fundingRefusalHttp } from "@cogni/agent-grants/http";
import { creditsSummaryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { readAccountCredits } from "@/app/_facades/payments/account-credits.server";
import { getCreditsSummaryFacade } from "@/app/_facades/payments/credits.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { AuthUserNotFoundError } from "@/features/payments/errors";
import { logRequestWarn, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

/**
 * Local error handler for credits summary route.
 * Maps domain errors to HTTP responses; returns null for unhandled errors.
 */
function handleRouteError(
  ctx: RequestContext,
  error: unknown
): NextResponse | null {
  // Funding an org account (story.0080): identity's refusal keeps its own code and status.
  const fundingRefusal = fundingRefusalHttp(error);
  if (fundingRefusal) {
    logRequestWarn(ctx.log, error, (fundingRefusal.body as { error: string }).error.toUpperCase());
    return NextResponse.json(fundingRefusal.body, { status: fundingRefusal.status, headers: fundingRefusal.headers });
  }

  // Zod validation errors
  if (error && typeof error === "object" && "issues" in error) {
    logRequestWarn(ctx.log, error, "VALIDATION_ERROR");
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  // Auth errors
  if (error instanceof AuthUserNotFoundError) {
    logRequestWarn(ctx.log, error, "AUTH_USER_NOT_FOUND");
    return NextResponse.json(
      { error: "User not provisioned; please re-authenticate" },
      { status: 401 }
    );
  }

  return null;
}

export const GET = wrapRouteHandlerWithLogging(
  {
    // Optional account door (task.5465): with `?accountId=` this is the gated read of THAT account (the owner by session, or an agent holding a live
    // `account:read` grant for exactly it; else one 404). Without it, the caller's own account, as before.
    routeId: "payments.credits_summary",
    sameDoor: "core__account_credits_read",
    sameDoorAccountQuery: "accountId",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    try {
      const { searchParams } = new URL(request.url);
      const parsedLimit = searchParams.get("limit");
      const limit = parsedLimit ? Number(parsedLimit) : undefined;

      const input = creditsSummaryOperation.input.parse({
        limit,
        billingAccountId: searchParams.get("billingAccountId") ?? undefined,
      });

      // The named account was authorized by the door above: read it as the caller under row-level security.
      const namedAccount = searchParams.get("accountId");
      if (namedAccount !== null) {
        if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper
        const named = await readAccountCredits({ callerUserId: sessionUser.id, accountId: namedAccount, limit: input.limit });
        return named
          ? NextResponse.json(creditsSummaryOperation.output.parse(named))
          : NextResponse.json({ error: "not_found" }, { status: 404 });
      }

      if (!sessionUser) throw new Error("sessionUser required"); // Enforced by wrapper
      const summary = await getCreditsSummaryFacade(
        {
          sessionUser,
          limit: input.limit,
          billingAccountId: input.billingAccountId,
        },
        ctx
      );

      // Facade already returns contract-compliant shape (createdAt as ISO string)
      return NextResponse.json(creditsSummaryOperation.output.parse(summary));
    } catch (error) {
      const errorResponse = handleRouteError(ctx, error);
      if (errorResponse) return errorResponse;
      throw error; // Unhandled - let wrapper catch
    }
  }
);
