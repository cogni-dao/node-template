// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/artifacts`
 * Purpose: POST records an immutable review or validation artifact on a work item; GET lists them, newest first (task.0028).
 * Scope: Thin shells: session check, id, body parse, one `@cogni/work-items` handler call, one log event, response. The independence check, PASS-grade and the insert live in the package.
 * Invariants:
 *   - SAME_DOOR: POST needs the `work_item:review` grant (route id `work.items.artifacts.create`, capability `work.item.review`); a signed-in human passes. GET needs a session, like history.
 *   - AUTHOR_IS_STAMPED: the author is `sessionUser.id`; a body never names one.
 *   - Errors, each with an `errorCode`: 400 `invalid_input` (an invalid JSON body too), 403 grant, 404 `not_found`, 409 `artifact_author_not_independent` or `work_item_write_outcome_unknown` (inspect, never replay), 503 `artifacts_unavailable` (no store wired too). Nothing is written in the 400, 404, 409 independence and 503 cases.
 *   - One terminal log event per call (codes and counts only): `work.items.artifact_recorded` on success, `work.items.artifact_refused` on every other write outcome, `work.items.artifacts_read` for the list. A failure also warns once as `work.items.artifact_unavailable`.
 * Side-effects: IO (HTTP response, Doltgres read and write)
 * Links: @cogni-dao/work-items recordWorkItemArtifact, hub work-cicd-gates-design
 * @public
 */

import {
  type ArtifactResult,
  artifactInvalidJson,
  artifactsNotConfigured,
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

/** One terminal log event per call, then the response. A failed call also warns once, under one event name. */
function respond(
  ctx: {
    readonly log: Parameters<typeof logEvent>[0];
    readonly reqId: string;
    readonly routeId: string;
  },
  startedAt: number,
  { status, body, log }: ArtifactResult
): NextResponse {
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
  return NextResponse.json(body, { status });
}

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
    const startedAt = Date.now();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond(ctx, startedAt, artifactInvalidJson(id));
    }

    const deps = getContainer().workItemArtifacts;
    if (!deps) return respond(ctx, startedAt, artifactsNotConfigured(id, "write"));

    return respond(
      ctx,
      startedAt,
      await recordWorkItemArtifact(deps, id, sessionUser.id, body)
    );
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
    const startedAt = Date.now();

    const deps = getContainer().workItemArtifacts;
    if (!deps) return respond(ctx, startedAt, artifactsNotConfigured(id, "read"));

    return respond(ctx, startedAt, await listWorkItemArtifacts(deps, id));
  }
);
