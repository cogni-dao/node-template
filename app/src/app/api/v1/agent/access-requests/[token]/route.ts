// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests/[token]`
 * Purpose: The signed-in account owner previews (GET) and decides (POST) an
 *   agent access request selected by its one-time approval token. Approval
 *   writes the grant in the same transaction.
 * Scope: Thin route — human browser session only (any bearer is refused),
 *   params/body parse, delegate to `@cogni-dao/agent-grants`, response.
 *   The token is never logged. Unknown, used, or expired tokens are 404.
 * Links: story.5115, packages/agent-grants
 * @public
 */

import {
  decideAccessRequest,
  previewAccessRequest,
} from "@cogni-dao/agent-grants";
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

type Params = { params: Promise<{ token: string }> };

const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  accountId: z.string().min(1).max(128).optional(),
});

export const GET = wrapRouteHandlerWithLogging<Params>(
  {
    routeId: "agent.access_requests.preview",
    auth: { mode: "required", getSessionUser: resolveHumanSessionIdentity },
  },
  async (_ctx, _request, sessionUser, context) => {
    if (!sessionUser || !context) return notFoundResponse();
    const { token } = await context.params;
    const preview = await withPrincipalTx(sessionUser.id, (tx) =>
      previewAccessRequest(tx, { token })
    );
    if (!preview) return notFoundResponse();
    return NextResponse.json({
      id: preview.id,
      requesterDisplayName: preview.requesterDisplayName,
      requestedScopes: preview.requestedScopes,
      grantExpiresAt: preview.grantExpiresAt.toISOString(),
    });
  }
);

export const POST = wrapRouteHandlerWithLogging<Params>(
  {
    routeId: "agent.access_requests.decide",
    auth: { mode: "required", getSessionUser: resolveHumanSessionIdentity },
  },
  async (ctx, request, sessionUser, context) => {
    if (!sessionUser || !context) return notFoundResponse();
    const { token } = await context.params;
    const parsed = decisionSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const decided = await withPrincipalTx(sessionUser.id, (tx) =>
      decideAccessRequest(tx, {
        token,
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
