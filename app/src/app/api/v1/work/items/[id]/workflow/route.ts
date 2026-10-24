// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/workflow/route`
 * Purpose: Record one checkpoint and immediately return current stage guidance.
 * Scope: Authenticated schema validation, facade delegation and one terminal event.
 * Invariants: VALIDATE_IO, CREATOR_AUTHORIZATION_REQUIRED, NO_ACTION_REPLAY.
 * Side-effects: IO (node-owned checkpoint CAS and structured terminal log).
 * @public
 */
import { createHash } from "node:crypto";
import { workItemsWorkflowOperation } from "@cogni/node-contracts";
import { CICD_WORKFLOWS } from "@cogni/work-items";
import { NextResponse } from "next/server";
import {
  recordWorkItemWorkflow,
  WorkflowConflictError,
  WorkItemForbiddenError,
  WorkItemLeaseConflictError,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.workflow",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    const began = performance.now();
    let status = 500;
    let errorCode: string | undefined = EVENT_NAMES.WORKFLOW_INTERNAL;
    let replayed = false;
    let checkpointId = "none";
    let workItemId: string | undefined;
    let workflowId = "unknown";
    let revision: number | undefined;
    let receiptFingerprint: string | undefined;
    const respond = (body: unknown, code: number, reason?: string) => {
      status = code;
      errorCode = reason;
      return NextResponse.json(body, { status: code });
    };
    try {
      if (!sessionUser)
        return respond(
          { error: "unauthorized" },
          401,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      if (!context)
        return respond(
          { error: "invalid route" },
          400,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      const { id } = await context.params;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return respond(
          { error: "invalid JSON" },
          400,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        ("id" in body && body.id !== id)
      )
        return respond(
          { error: "invalid input" },
          400,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      const parsed = workItemsWorkflowOperation.input.safeParse({
        ...body,
        id,
      });
      if (!parsed.success)
        return respond(
          { error: "invalid input" },
          400,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      workItemId = parsed.data.id.length <= 48 ? parsed.data.id : undefined;
      const definition = CICD_WORKFLOWS.find(
        (entry) => entry.id === parsed.data.event.workflowId,
      );
      workflowId = definition?.id ?? "unknown";
      revision = parsed.data.expectedRevision;
      if ("receiptKey" in parsed.data.event)
        receiptFingerprint = createHash("sha256")
          .update(parsed.data.event.receiptKey)
          .digest("hex");
      const event = parsed.data.event;
      if (
        "checkpointId" in event &&
        definition?.checkpoints.some((step) => step.id === event.checkpointId)
      )
        checkpointId = event.checkpointId;
      const result = workItemsWorkflowOperation.output.parse(
        await recordWorkItemWorkflow(parsed.data, sessionUser.id),
      );
      revision = result.item.revision;
      replayed = result.replayed;
      checkpointId = result.item.workflowRun?.checkpointId ?? "complete";
      return respond(result, 200);
    } catch (error) {
      if (error instanceof WorkflowConflictError)
        return respond(
          { error: error.code },
          409,
          EVENT_NAMES.WORKFLOW_CONFLICT,
        );
      if (
        error instanceof WorkItemLeaseConflictError ||
        (error as Error)?.name === "WorkItemRevisionConflictError"
      )
        return respond(
          { error: "stale_revision_or_claim", reconcile: true },
          409,
          EVENT_NAMES.WORKFLOW_CONFLICT,
        );
      if (error instanceof WorkItemForbiddenError)
        return respond(
          { error: "forbidden" },
          403,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      if (error instanceof WorkItemNotFoundError)
        return respond(
          { error: "not_found" },
          404,
          EVENT_NAMES.WORKFLOW_INVALID,
        );
      if (error instanceof WorkItemsBackendNotReadyError)
        return respond(
          { error: "workflow_unavailable", reconcile: true },
          503,
          EVENT_NAMES.WORKFLOW_UNAVAILABLE,
        );
      return respond(
        { error: "workflow_internal", reconcile: true },
        500,
        EVENT_NAMES.WORKFLOW_INTERNAL,
      );
    } finally {
      logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_WORKFLOW_COMPLETE, {
        reqId: ctx.reqId,
        routeId: "work.items.workflow",
        status,
        durationMs: performance.now() - began,
        outcome: status < 400 ? "success" : "error",
        replayed,
        workflowId,
        checkpointId,
        ...(workItemId ? { workItemId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(receiptFingerprint ? { receiptFingerprint } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
  },
);
