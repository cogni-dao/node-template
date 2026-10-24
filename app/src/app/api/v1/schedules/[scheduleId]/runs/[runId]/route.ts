// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/api/v1/schedules/[scheduleId]/runs/[runId]
 * Purpose: Read the chosen run's complete saved assistant text.
 * Scope: Authorized on-demand read; no tool payloads, traces or execution side effects.
 * Invariants: Caller-owned schedule and thread; exact assistant ID; no-store.
 * Side-effects: IO (database reads)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
import { toUserId } from "@cogni/ids";
import { schedulesOutputOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import {
  invalidScheduleRead,
  scheduleReadback,
  scheduleReadError,
  scheduleReadHeaders,
} from "../../../readback.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ scheduleId: string; runId: string }>;
}>(
  { routeId: "schedules.output", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    const startedAt = performance.now();
    if (!context) throw new Error("Route context required");
    const params = schedulesOutputOperation.input.safeParse(
      await context.params
    );
    if (!params.success)
      return invalidScheduleRead(
        ctx,
        EVENT_NAMES.SCHEDULE_OUTPUT_READ,
        startedAt
      );
    try {
      const { scheduleId, runId } = params.data;
      const result = await scheduleReadback().output(
        toUserId(sessionUser.id),
        scheduleId,
        runId
      );
      logEvent(ctx.log, EVENT_NAMES.SCHEDULE_OUTPUT_READ, {
        reqId: ctx.reqId,
        status: 200,
        outcome: "success",
        durationMs: performance.now() - startedAt,
        routeId: "schedules.output",
        scheduleId,
        runId,
        availability: result.availability,
      });
      return NextResponse.json(schedulesOutputOperation.output.parse(result), {
        headers: scheduleReadHeaders,
      });
    } catch (error) {
      return scheduleReadError(
        error,
        ctx,
        EVENT_NAMES.SCHEDULE_OUTPUT_READ,
        startedAt
      );
    }
  }
);
