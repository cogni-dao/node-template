// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/artifacts`
 * Purpose: POST records an immutable review or validation artifact on a work item; GET lists them, newest first (task.0028).
 * Scope: Thin shells: session check, id, body parse, one `@cogni/work-items` handler call, one log event, response. The independence check, PASS-grade and the insert live in the package.
 * Invariants:
 *   - SAME_DOOR: POST needs the `work_item:review` grant (route id `work.items.artifacts.create`, capability `work.item.review`); a signed-in human passes. GET needs a session, like history.
 *   - AUTHOR_IS_STAMPED: the author is `sessionUser.id`; a body never names one.
 *   - Errors: 400 `invalid input` (with issues), 403 grant, 404 item, 409 `artifact_author_not_independent`, 503 `artifacts_unavailable`. Nothing is written in any of them.
 *   - One terminal log event per call (codes and counts only): `work.items.artifact_recorded`, `work.items.artifact_refused`, `work.items.artifacts_read`.
 * Side-effects: IO (HTTP response, Doltgres read and write)
 * Links: @cogni-dao/work-items recordWorkItemArtifact, hub work-cicd-gates-design
 * @public
 */

import {
  listWorkItemArtifacts,
  recordWorkItemArtifact,
} from "@cogni/work-items";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const EVENT_BY_LOG = {
  "work.items.artifact_recorded": EVENT_NAMES.WORK_ITEMS_ARTIFACT_RECORDED,
  "work.items.artifact_refused": EVENT_NAMES.WORK_ITEMS_ARTIFACT_REFUSED,
  "work.items.artifacts_read": EVENT_NAMES.WORK_ITEMS_ARTIFACTS_READ,
} as const;

const NOT_CONFIGURED = {
  error: "artifacts_unavailable",
  errorCode: "artifacts_unavailable",
} as const;

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.artifacts.create",
    sameDoor: "work.item.review",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const deps = getContainer().workItemArtifacts;
    if (!deps) return NextResponse.json(NOT_CONFIGURED, { status: 503 });

    const startedAt = Date.now();
    const {
      status,
      body: result,
      log,
    } = await recordWorkItemArtifact(deps, id, sessionUser.id, body);
    const { event, errorName, ...fields } = log;
    logEvent(ctx.log, EVENT_BY_LOG[event], {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    if (errorName !== undefined) {
      ctx.log.warn({ errorName }, "work.items.artifact_unavailable");
    }
    return NextResponse.json(result, { status });
  }
);

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.artifacts.list",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    const deps = getContainer().workItemArtifacts;
    if (!deps) return NextResponse.json(NOT_CONFIGURED, { status: 503 });

    const startedAt = Date.now();
    const { status, body, log } = await listWorkItemArtifacts(deps, id);
    const { event, errorName, ...fields } = log;
    logEvent(ctx.log, EVENT_BY_LOG[event], {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    if (errorName !== undefined) {
      ctx.log.warn({ errorName }, "work.items.artifacts_unavailable");
    }
    return NextResponse.json(body, { status });
  }
);
