// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: An authenticated agent requests node-declared scopes for itself and
 *   receives a one-time approval URL to hand to the account-owning human.
 * Scope: Thin route — bearer auth, body parse, delegate to
 *   `@cogni-dao/agent-grants`, response. The raw token is returned once and
 *   never logged or stored (only its sha256).
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { AgentGrantsError, createAccessRequest } from "@cogni-dao/agent-grants";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  NODE_AGENT_SCOPES,
  withPrincipalTx,
} from "@/app/_lib/agent-grants/node-agent-grants";
import { getRequestBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  scopes: z.array(z.string().min(1).max(64)).min(1).max(16),
});

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access_requests.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser || !(await getRequestBearerToken())) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    try {
      const created = await withPrincipalTx(sessionUser.id, (tx) =>
        createAccessRequest(tx, {
          principalId: sessionUser.id,
          displayName: sessionUser.displayName,
          scopes: parsed.data.scopes,
          declaredScopes: NODE_AGENT_SCOPES,
        })
      );
      logEvent(ctx.log, EVENT_NAMES.AGENT_GRANTS_ACCESS_REQUEST_CREATED, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        principalId: sessionUser.id,
        requestId: created.id,
        scopeCount: parsed.data.scopes.length,
        outcome: "success",
      });
      return NextResponse.json(
        {
          id: created.id,
          approvalUrl: `${publicOrigin(request)}/api/v1/agent/access-requests/${created.token}`,
          tokenExpiresAt: created.tokenExpiresAt.toISOString(),
        },
        { status: 201 }
      );
    } catch (error) {
      if (!(error instanceof AgentGrantsError)) throw error;
      logEvent(ctx.log, EVENT_NAMES.AGENT_GRANTS_ACCESS_REQUEST_CREATED, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        principalId: sessionUser.id,
        outcome: "error",
        errorCode: error.code,
      });
      return NextResponse.json(
        { error: error.code },
        { status: error.code === "pending_exists" ? 409 : 400 }
      );
    }
  }
);
