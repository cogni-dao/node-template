// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/grants/[id]`
 * Purpose: The account owner soft-revokes a capability grant.
 * Scope: Thin route — human browser session only, delegate to
 *   `@cogni-dao/agent-grants`, response. Unknown, foreign, or already-revoked
 *   grants are the same 404.
 * Links: story.5115, packages/agent-grants
 * @public
 */

import { revokeOwnedGrant } from "@cogni-dao/agent-grants";
import { NextResponse } from "next/server";
import {
  notFoundResponse,
  withPrincipalTx,
} from "@/app/_lib/agent-grants/node-agent-grants";
import { resolveHumanSessionIdentity } from "@/app/_lib/auth/request-identity";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "agent.grants.revoke",
    auth: { mode: "required", getSessionUser: resolveHumanSessionIdentity },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser || !context) return notFoundResponse();
    const { id } = await context.params;
    const revoked = UUID_RE.test(id)
      ? await withPrincipalTx(sessionUser.id, (tx) =>
          revokeOwnedGrant(tx, { ownerId: sessionUser.id, grantId: id })
        )
      : null;
    logEvent(ctx.log, EVENT_NAMES.AGENT_GRANTS_REVOKED, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      principalId: sessionUser.id,
      grantId: revoked?.id ?? null,
      accountId: revoked?.billingAccountId ?? null,
      granteeId: revoked?.granteePrincipalId ?? null,
      outcome: revoked ? "success" : "error",
      ...(revoked ? {} : { errorCode: "not_found" }),
    });
    if (!revoked) return notFoundResponse();
    return NextResponse.json({
      id: revoked.id,
      revokedAt: revoked.revokedAt?.toISOString() ?? null,
    });
  }
);
