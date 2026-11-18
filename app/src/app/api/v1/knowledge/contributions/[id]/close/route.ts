// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/close/route`
 * Purpose: POST to reject + close a contribution without merging.
 * Scope: Auth-protected POST. Closing another principal's contribution requires the one admin check (`agentAuthority.adminCheck`, ONE_ADMIN_CHECK), whatever the credential;
 *   an owner closes their own inbox with no admin, so the route declares `bearerWrite` and the service runs the same pure admin check for anyone else's inbox.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION, MERGE_IS_NODE_ADMIN (bug.0044).
 * Side-effects: IO (HTTP response, Doltgres dolt_branch -D + UPDATE via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleClose } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.close",
    bearerWrite:
      "a principal closes its own inbox; closing another principal's inbox runs the one admin check (agentAuthority.adminCheck) in the service, whatever the credential",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleClose(request, id, sessionUser);
  }
);
