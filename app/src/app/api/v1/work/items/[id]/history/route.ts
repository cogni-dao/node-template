// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/history`
 * Purpose: GET a work item's versions, newest first, each with its change reason (task.0052).
 * Scope: Thin route; the facade reads Dolt history through the work-items port.
 * Invariants: NOTE_NOT_BODY, ONE_HISTORY_SHAPE, one terminal log event per read (counts only).
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: contracts/history.v1.contract, hub change-history-design
 * @public
 */

import { workItemsHistoryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getWorkItemHistory } from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.history", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const startedAt = Date.now();
    try {
      const history = await getWorkItemHistory(id);
      if (!history) {
        logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_HISTORY_READ, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          status: 404,
          durationMs: Date.now() - startedAt,
          outcome: "error",
          errorCode: "not_found",
        });
        return NextResponse.json(
          { error: `Work item not found: ${id}` },
          { status: 404 }
        );
      }
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_HISTORY_READ, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status: 200,
        durationMs: Date.now() - startedAt,
        outcome: "success",
        versionCount: history.items.length,
        reasonCount: history.items.filter((v) => v.reason !== null).length,
      });
      return NextResponse.json(workItemsHistoryOperation.output.parse(history));
    } catch (error) {
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_HISTORY_READ, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status: 503,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        errorCode: "history_unavailable",
      });
      ctx.log.warn(
        { errorName: (error as Error)?.name },
        "work.items.history_unavailable"
      );
      return NextResponse.json(
        { error: "history_unavailable" },
        { status: 503 }
      );
    }
  }
);
