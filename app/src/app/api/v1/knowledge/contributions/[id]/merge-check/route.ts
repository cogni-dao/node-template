// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/contributions/[id]/merge-check/route`
 * Purpose: Explicit native conflict check for an authenticated reviewer.
 * Scope: Node-owned HTTP/auth/logging binding over the shared domain capability.
 * Invariants: VALIDATE_IO; no caching; no caller SQL/refs/tables or merge authority.
 * Side-effects: IO (HTTP, admitted native reads and session-local main checkout)
 * Links: https://cognidao.org/work/items/task.5368
 * @public
 */
import { ContributionMergeCheckResponseSchema } from "@cogni/node-contracts";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";
import { handleMergeCheck } from "../../_handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "knowledge.contributions.merge_check",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const response = await handleMergeCheck(request, id, sessionUser);
    const result = ContributionMergeCheckResponseSchema.safeParse(
      await response.clone().json()
    );
    ctx.log.info(
      {
        event: EVENT_NAMES.KNOWLEDGE_MERGE_CHECK_COMPLETE,
        reqId: ctx.reqId,
        status: response.status,
        previewStatus: result.success ? result.data.status : "unavailable",
        reason: result.success ? result.data.reason : "invalid_request",
        conflictTableCount: result.success ? result.data.conflicts.length : 0,
        durationMs: performance.now() - startedAt,
      },
      EVENT_NAMES.KNOWLEDGE_MERGE_CHECK_COMPLETE
    );
    return response;
  }
);
