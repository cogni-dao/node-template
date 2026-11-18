// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/merge/route`
 * Purpose: POST to merge a contribution branch into main.
 * Scope: Auth-protected POST. Merging requires the one admin check (`agentAuthority.adminCheck`, ONE_ADMIN_CHECK), whatever the credential;
 *   a bearer also needs a live `knowledge:write` role row (door `knowledge.merge`, SAME_DOOR).
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION, MERGE_IS_NODE_ADMIN (bug.0044).
 * Side-effects: IO (HTTP response, Doltgres dolt_merge + dolt_commit via container service)
 * @public
 */

import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { handleMerge } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.merge",
    sameDoor: "knowledge.merge",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    return handleMerge(request, id, sessionUser);
  }
);
