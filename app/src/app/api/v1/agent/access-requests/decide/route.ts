// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests/decide`
 * Purpose: The signed-in account owner approves or denies an agent access
 *   request selected by its one-time approval token. Approval writes the
 *   grant in the same transaction.
 * Scope: Thin route — human browser session only (any Authorization header is
 *   refused; same-origin enforced), body parse, delegate, response.
 * Invariants:
 *   - TOKEN_NEVER_IN_URL: the token travels only in the JSON body and is
 *     never logged.
 *   - NON_DISCLOSING_DENIAL: unknown, used, or expired tokens, and accounts
 *     the approver does not own, are one 404.
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { decideAccessRequest } from "@cogni-dao/agent-grants";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  NODE_AGENT_SCOPES,
  notFoundResponse,
  withPrincipalTx,
} from "@/app/_lib/agent-grants/node-agent-grants";
import { resolveHumanSessionIdentity } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(16).max(256),
  decision: z.enum(["approve", "deny"]),
  accountId: z.string().min(1).max(128).optional(),
});

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access_requests.decide",
    auth: { mode: "required", getSessionUser: resolveHumanSessionIdentity },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) return notFoundResponse();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const decided = await withPrincipalTx(sessionUser.id, (tx) =>
      decideAccessRequest(tx, {
        token: parsed.data.token,
        ownerId: sessionUser.id,
        accountId: parsed.data.accountId,
        decision: parsed.data.decision,
        declaredScopes: NODE_AGENT_SCOPES,
      })
    );
    logEvent(ctx.log, EVENT_NAMES.AGENT_GRANTS_DECIDED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      principalId: sessionUser.id,
      decision: parsed.data.decision,
      requestId: decided?.id ?? null,
      granteeId: decided?.requesterPrincipalId ?? null,
      accountId: decided?.billingAccountId ?? null,
      grantId: decided?.grantId ?? null,
      outcome: decided ? "success" : "error",
      ...(decided ? {} : { errorCode: "not_found" }),
    });
    if (!decided) return notFoundResponse();
    return NextResponse.json(decided);
  }
);
