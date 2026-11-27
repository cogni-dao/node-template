// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/route`
 * Purpose: Authenticated HTTP endpoint for listing all ledger epochs (including open).
 * Scope: SIWE-protected route; returns all epochs for the current node. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO, WRITE_ROUTES_AUTHED.
 * Side-effects: IO (HTTP response, database read)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/attribution-ledger.md, contracts/attribution.list-epochs.v1.contract
 * @public
 */

import { listEpochsView } from "@cogni/attribution-ledger";
import {
  EPOCH_PRESENTATION_EVENTS,
  handleEpochOverview,
  parseEpochPage,
} from "@cogni/attribution-ledger/http";
import { listEpochsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ledger.list-epochs",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    const url = new URL(request.url);
    const pagination = parseEpochPage(
      url.searchParams,
      EPOCH_PRESENTATION_EVENTS.overview,
      { nodeId: getNodeId() }
    );
    if (!pagination.ok) {
      ctx.log.info(pagination.result.event, pagination.result.event.event);
      return NextResponse.json(pagination.result.body, {
        status: pagination.result.status,
      });
    }
    const { limit, offset } = pagination.page;

    if (url.searchParams.get("view") === "overview") {
      const result = await handleEpochOverview(
        getContainer().attributionStore,
        getNodeId(),
        { limit, offset }
      );
      ctx.log.info(result.event, result.event.event);
      return NextResponse.json(result.body, { status: result.status });
    }
    const view = await listEpochsView(
      getContainer().attributionStore,
      getNodeId(),
      { limit, offset }
    );
    return NextResponse.json(listEpochsOperation.output.parse(view));
  }
);
