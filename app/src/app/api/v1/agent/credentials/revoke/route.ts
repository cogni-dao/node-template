// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/revoke`
 * Purpose: An agent revokes the bearer key it presents. Every later request
 *   with that key is 401.
 * Scope: Thin route — bearer auth, delegate to `@cogni-dao/agent-grants`
 *   (service-role write on agent_credentials), response. Legacy keys issued
 *   before revocable credentials have no row; they report revoked=false and
 *   expire on their own (≤30d).
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { revokeAgentCredential } from "@cogni-dao/agent-grants";
import { NextResponse } from "next/server";
import { getRequestBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.credentials.revoke",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser) => {
    const key = await getRequestBearerToken();
    if (!sessionUser || !key) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const credentialId = await revokeAgentCredential(resolveServiceDb(), {
      userId: sessionUser.id,
      key,
    });
    logEvent(ctx.log, EVENT_NAMES.AGENT_CREDENTIALS_REVOKED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      principalId: sessionUser.id,
      credentialId,
      outcome: credentialId ? "success" : "error",
      ...(credentialId ? {} : { errorCode: "no_live_credential" }),
    });
    return NextResponse.json({ revoked: credentialId !== null });
  }
);
