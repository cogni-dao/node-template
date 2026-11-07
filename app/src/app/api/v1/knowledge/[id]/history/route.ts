// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/[id]/history`
 * Purpose: GET a knowledge entry's versions, newest first, each with its change reason (task.0052).
 * Scope: Thin route over the knowledge-store port's Dolt history read.
 * Invariants: NOTE_NOT_BODY, ONE_HISTORY_SHAPE, one terminal log event per read (counts only).
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: contracts/history.v1.contract, hub change-history-design
 * @public
 */

import { knowledgeHistoryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "knowledge.history", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const startedAt = Date.now();
    const done = (status: number, extra: Record<string, unknown>) =>
      logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_HISTORY_READ, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    const port = getContainer().knowledgeStorePort;
    if (!port?.history) {
      done(503, { outcome: "error", errorCode: "history_unavailable" });
      return NextResponse.json({ error: "history_unavailable" }, { status: 503 });
    }
    try {
      if (!(await port.knowledgeExists(id))) {
        done(404, { outcome: "error", errorCode: "not_found" });
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      const items = await port.history(id);
      done(200, {
        outcome: "success",
        versionCount: items.length,
        reasonCount: items.filter((v) => v.reason !== null).length,
      });
      return NextResponse.json(knowledgeHistoryOperation.output.parse({ items }));
    } catch (error) {
      done(503, { outcome: "error", errorCode: "history_unavailable" });
      ctx.log.warn(
        { errorName: (error as Error)?.name },
        "knowledge.history_unavailable"
      );
      return NextResponse.json({ error: "history_unavailable" }, { status: 503 });
    }
  }
);
