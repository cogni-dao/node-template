// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/reassign/route`
 * Purpose: HTTP endpoint for a node admin to move every work item created by one principal to another (bug.0013: agent re-key after AUTH_SECRET rotation).
 * Scope: POST only. Session-authenticated node admin; agent bearer keys are rejected. Delegates authorization and the write to the work-items facade.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH, SESSION_ONLY (bearer → 403 session_required), REASSIGN_IS_NODE_ADMIN (403 authz_denied / 503 authz_unavailable), DRY_RUN_WRITES_NOTHING.
 * Side-effects: IO (HTTP response, users read, Doltgres write), one `work.items.reassigned` log event per write
 * Links: contracts/work.items.reassign.v1.contract, https://node-template.cognidao.org/work/items/bug.0013
 * @public
 */

import { workItemsReassignOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import {
  NodeAdminRequiredError,
  ReassignTargetNotFoundError,
  reassignWorkItemCreator,
  WorkItemsBackendNotReadyError,
  WorkItemWriteOutcomeUnknownError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/work/items/reassign — `{fromPrincipalId, toPrincipalId, dryRun?}`.
 * Returns `{fromPrincipalId, toPrincipalId, dryRun, count, ids}`.
 */
export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "work.items.reassign",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // SESSION_ONLY: an agent key is never a node-admin credential here, even if
    // its principal could otherwise resolve to an admin.
    if (/^bearer\s/i.test(request.headers.get("authorization") ?? "")) {
      return NextResponse.json(
        {
          error: "work item reassignment requires a browser session",
          errorCode: "session_required",
        },
        { status: 403 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = workItemsReassignOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const result = await reassignWorkItemCreator(parsed.data, {
        id: sessionUser.id,
        walletAddress: sessionUser.walletAddress,
      });
      ctx.log.info(
        {
          from: result.fromPrincipalId,
          to: result.toPrincipalId,
          count: result.count,
          actor: sessionUser.id,
          dryRun: result.dryRun,
        },
        result.dryRun
          ? "work.items.reassign_previewed"
          : "work.items.reassigned"
      );
      return NextResponse.json(workItemsReassignOperation.output.parse(result));
    } catch (e) {
      if (e instanceof NodeAdminRequiredError) {
        return NextResponse.json(
          { error: e.message, errorCode: e.errorCode, action: e.action },
          { status: e.status }
        );
      }
      if (e instanceof ReassignTargetNotFoundError) {
        return NextResponse.json(
          { error: e.message, errorCode: "target_principal_not_found" },
          { status: 404 }
        );
      }
      if (e instanceof WorkItemWriteOutcomeUnknownError) {
        return NextResponse.json(
          {
            error: e.code,
            retryable: false,
            lookup: e.receipt.lookup,
            message: e.message,
          },
          { status: 409 }
        );
      }
      if (e instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      throw e;
    }
  }
);
