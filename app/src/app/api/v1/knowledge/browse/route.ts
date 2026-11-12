// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated bounded knowledge metadata and explicitly continued search. */
import {
  KnowledgeBrowseCursorError,
  KnowledgeBrowseQueryError
} from "@cogni/knowledge-store";
import {
  KnowledgeBrowsePageSchema,
  KnowledgeBrowseQuerySchema
} from "@cogni/knowledge-store/contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  EVENT_NAMES,
  KNOWLEDGE_READ_ERROR_CODES,
  logEvent
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "knowledge.browse", sameDoor: "knowledge.read", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let status = 500;
    let errorCode:
      | (typeof KNOWLEDGE_READ_ERROR_CODES)[keyof typeof KNOWLEDGE_READ_ERROR_CODES]
      | undefined = KNOWLEDGE_READ_ERROR_CODES.INTERNAL_ERROR;
    let counts:
      | { count: number; scannedRows: number; hasMore: boolean }
      | undefined;
    let searchMode: boolean | undefined;
    try {
      if (!sessionUser) {
        status = 401;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.UNAUTHORIZED;
        return NextResponse.json({ error: "unauthorized" }, { status });
      }
      const port = getContainer().knowledgeStorePort;
      if (!port) {
        status = 503;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.STORE_UNCONFIGURED;
        return NextResponse.json(
          { error: "knowledge store not configured" },
          { status }
        );
      }
      const parsed = KnowledgeBrowseQuerySchema.safeParse(
        (() => {
          const params = new URL(request.url).searchParams;
          return {
            ...Object.fromEntries(params),
            ...Object.fromEntries(
              ["domains", "entryTypes", "sourceTypes"]
                .filter((key) => params.has(key))
                .map((key) => [key, params.getAll(key)])
            )
          };
        })()
      );
      if (!parsed.success) {
        status = 400;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.INVALID_QUERY;
        return NextResponse.json({ error: "invalid query" }, { status });
      }
      searchMode = Boolean(parsed.data.search);
      const result = KnowledgeBrowsePageSchema.parse(
        await port.browseKnowledge(parsed.data, { signal: request.signal })
      );
      const response = NextResponse.json(result);
      status = 200;
      errorCode = undefined;
      counts = {
        count: result.items.length,
        scannedRows: result.scannedRows,
        hasMore: result.nextCursor !== null
      };
      return response;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "KNOWLEDGE_BUSY"
      ) {
        status = 503;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.UNAVAILABLE;
        return NextResponse.json(
          { error: "Knowledge read unavailable", retryable: true },
          { status, headers: { "Retry-After": "1" } }
        );
      }
      if (error instanceof KnowledgeBrowseCursorError) {
        status = 400;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.INVALID_CURSOR;
        return NextResponse.json({ error: error.message }, { status });
      }
      if (error instanceof KnowledgeBrowseQueryError) {
        status = 400;
        errorCode = KNOWLEDGE_READ_ERROR_CODES.INVALID_QUERY;
        return NextResponse.json({ error: "invalid query" }, { status });
      }
      status = 500;
      errorCode = KNOWLEDGE_READ_ERROR_CODES.INTERNAL_ERROR;
      return NextResponse.json({ error: "Internal server error" }, { status });
    } finally {
      logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_BROWSE_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: performance.now() - startedAt,
        outcome: errorCode ? "error" : "success",
        ...(errorCode && { errorCode }),
        ...counts,
        ...(searchMode !== undefined && { searchMode })
      });
    }
  }
);
