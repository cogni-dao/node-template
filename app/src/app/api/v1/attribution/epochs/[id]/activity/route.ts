// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/activity/route`
 * Purpose: Authenticated HTTP endpoint for epoch activity — UNION of window receipts and epoch-selected receipts with selection join.
 * Scope: SIWE-protected route; exposes PII fields (platformUserId, platformLogin, etc.). Auth, parsing and logging only; the view is @cogni-dao/attribution buildEpochActivityView (story.0076).
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, ACTIVITY_AUTHED.
 * Side-effects: IO (HTTP response, database read)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/attribution-ledger.md, contracts/attribution.epoch-activity.v1.contract
 * @public
 */

import { handleEpochContributorReceipts } from "@cogni/attribution-ledger/http";

import {
  buildEpochActivityView,
  persistSelectionUpdates,
} from "@cogni/attribution-ledger";
import { epochActivityOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-activity",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    let epochId: bigint;
    try {
      epochId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "Invalid epoch ID" }, { status: 400 });
    }

    const url = new URL(request.url);
    const { limit, offset } = epochActivityOperation.input.parse({
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });

    const store = getContainer().attributionStore;
    const claimantKey = url.searchParams.get("claimantKey");
    if (claimantKey !== null) {
      if (claimantKey.length < 1 || claimantKey.length > 512)
        return NextResponse.json(
          { error: "Invalid claimant key" },
          { status: 400 }
        );
      const result = await handleEpochContributorReceipts(
        store,
        getNodeId(),
        epochId,
        claimantKey,
        { limit, offset }
      );
      ctx.log.info(result.event, result.event.event);
      return NextResponse.json(result.body, { status: result.status });
    }

    const result = await buildEpochActivityView(
      store,
      getNodeId(),
      epochId,
      id,
      { limit, offset }
    );
    if (!result) {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    if (result.pendingSelectionUpdates.length > 0) {
      // Background: fill selection rows so later reads need no resolution.
      void persistSelectionUpdates(store, result.pendingSelectionUpdates);
    }
    if (result.resolvedCount > 0) {
      logEvent(ctx.log, EVENT_NAMES.LEDGER_IDENTITY_RESOLVED_AT_READ, {
        reqId: ctx.reqId,
        routeId: "ledger.epoch-activity",
        epochId: id,
        resolvedCount: result.resolvedCount,
        unresolvedCount: result.unresolvedCount,
      });
    }

    return NextResponse.json(epochActivityOperation.output.parse(result.view));
  }
);
