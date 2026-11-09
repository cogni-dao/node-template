// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/graph/route`
 * Purpose: GET /api/v1/knowledge/graph — the whole knowledge graph (every projected entry and every entry-to-entry citation) at one store revision.
 * Scope: Thin route: session check, `readKnowledgeGraph` from `@cogni/knowledge-store` (ETag/304, one pinned read per revision, deadline → retryable 503, byte budget), one log event, response. Any authenticated principal (cookie human or bearer agent).
 * Invariants: AUTH_VIA_GETSESSIONUSER (unauthenticated → 401 before any read, even with If-None-Match), KNOWLEDGE_READ_REQUIRES_PRINCIPAL, ONE_TERMINAL_LOG (`knowledge.graph_read`: counts, bytes, budgetExceeded).
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: @cogni-dao/knowledge-store readKnowledgeGraph, task.0059
 * @public
 */

import { readKnowledgeGraph } from "@cogni/knowledge-store";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "knowledge.graph", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const startedAt = Date.now();
    const { status, headers, body, log } = await readKnowledgeGraph(
      getContainer().knowledgeStorePort,
      {
        ifNoneMatch: request.headers.get("if-none-match"),
        signal: request.signal,
      }
    );
    const { event: _event, errorName, ...fields } = log;
    logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_GRAPH_READ, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    if (errorName !== undefined) {
      ctx.log.warn({ errorName }, "knowledge.graph_unavailable");
    }
    return new NextResponse(body, { status, headers });
  }
);
