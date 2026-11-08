// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/board/route`
 * Purpose: HTTP endpoint for the work board's first page of every visible status column.
 * Scope: Auth-protected GET. Thin: decodes with the published codec, reads through the existing summaries facade, encodes with the published column schema.
 * Invariants: VALIDATE_IO, AUTH_VIA_GETSESSIONUSER, NODE_STORE_IS_LOCAL, BOUNDED_BOARD (one summary page per requested status, at most `WORK_BOARD_COLUMN_PAGE` rows each, read sequentially by `loadWorkBoardColumns`; each column cursor continues through `/api/v1/work/summaries`; task.0055).
 * Observability: the completion event carries `durationMs` (whole request), `columnCount` and `columnDurationsMs` (one entry per sequential column read, in column order).
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: task.0055, ../summaries/route.ts
 * @public
 */

import {
  loadWorkBoardColumns,
  normalizeWorkItemOrder,
  parseWorkBoardSearchParams,
  WorkBoardColumnsSchema,
  type WorkItemOrder,
} from "@cogni/work-items";
import { NextResponse } from "next/server";

import {
  InvalidCursorError,
  listWorkSummaries,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  EVENT_NAMES,
  logEvent,
  WORK_ITEMS_LIST_ERROR_CODES,
} from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/board — First page of each visible board column.
 *
 * Query params: the `/api/v1/work/summaries` filters (types, projectIds, text,
 * rankMin, rankMax, sortBy, sortDirection, ...) plus a required `statuses` list
 * naming the visible columns. `limit` and `cursor` do not apply: each column
 * returns up to 20 rows and its own `pageInfo.endCursor`, which is valid for
 * `/api/v1/work/summaries?statuses=<status>&<same filters>&cursor=...`.
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "work.board.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const startedAt = performance.now();
    let status = 500;
    let count = 0;
    let hasMore = false;
    let columnCount = 0;
    const columnDurationsMs: number[] = [];
    let order: WorkItemOrder | undefined;
    let errorCode:
      | (typeof WORK_ITEMS_LIST_ERROR_CODES)[keyof typeof WORK_ITEMS_LIST_ERROR_CODES]
      | undefined = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
    try {
      const parsed = parseWorkBoardSearchParams(
        new URL(request.url).searchParams,
      );
      if (!parsed.ok) {
        status = 400;
        errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_INPUT;
        return NextResponse.json(
          { error: "invalid input", issues: parsed.issues },
          { status },
        );
      }
      order = normalizeWorkItemOrder({
        ...(parsed.query.sortBy !== undefined && {
          sortBy: parsed.query.sortBy,
        }),
        ...(parsed.query.sortDirection !== undefined && {
          sortDirection: parsed.query.sortDirection,
        }),
      });
      let result: Awaited<ReturnType<typeof loadWorkBoardColumns>>;
      try {
        // Time each sequential column read so board latency (≈ the sum) is measurable.
        const timedList: typeof listWorkSummaries = async (input) => {
          const columnStartedAt = performance.now();
          try {
            return await listWorkSummaries(input);
          } finally {
            columnDurationsMs.push(
              Math.round(performance.now() - columnStartedAt),
            );
          }
        };
        result = await loadWorkBoardColumns(
          timedList,
          parsed.query,
          parsed.statuses,
        );
      } catch (e) {
        if (e instanceof InvalidCursorError) {
          status = 400;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.INVALID_CURSOR;
          return NextResponse.json(
            { error: "invalid cursor", code: "invalid_cursor" },
            { status },
          );
        }
        if (e instanceof WorkItemsBackendNotReadyError) {
          status = 503;
          errorCode = WORK_ITEMS_LIST_ERROR_CODES.BACKEND_UNAVAILABLE;
          return NextResponse.json({ error: e.message }, { status });
        }
        throw e;
      }

      const response = NextResponse.json(WorkBoardColumnsSchema.parse(result));
      status = 200;
      errorCode = undefined;
      count = result.columns.reduce(
        (total, column) => total + column.items.length,
        0,
      );
      columnCount = result.columns.length;
      hasMore = result.columns.some((column) => column.pageInfo.hasMore);
      return response;
    } catch {
      status = 500;
      errorCode = WORK_ITEMS_LIST_ERROR_CODES.INTERNAL_ERROR;
      return NextResponse.json({ error: "Internal server error" }, { status });
    } finally {
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_LIST_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status,
        durationMs: performance.now() - startedAt,
        outcome: errorCode ? "error" : "success",
        count,
        hasMore,
        columnCount,
        columnDurationsMs,
        ...order,
        ...(errorCode && { errorCode }),
      });
    }
  },
);
