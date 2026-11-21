// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/epochs/[id]/claimants/route`
 * Purpose: Authenticated HTTP endpoint for claimant-aware finalized epoch attribution.
 * Scope: SIWE-protected GET endpoint. Returns claimant-based finalized attribution for finalized epochs. Does not contain business logic.
 * Invariants: NODE_SCOPED, ALL_MATH_BIGINT, VALIDATE_IO.
 * Side-effects: IO (HTTP response, database read)
 * Links: src/contracts/attribution.epoch-claimants.v1.contract.ts
 * @public
 */

import { handleEpochContributorSummary } from "@cogni/attribution-ledger/http";
import { PaginationQuerySchema } from "@cogni/attribution-ledger/contracts";
import { getNodeId } from "@/shared/config";

import { epochClaimantsOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { readFinalizedEpochClaimants } from "@/app/_facades/attribution/claimants.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "ledger.epoch-claimants",
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

    const store = getContainer().attributionStore;
    const url = new URL(request.url);
    if (url.searchParams.get("view") === "summary") {
      const page = PaginationQuerySchema.parse({
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
      });
      const result = await handleEpochContributorSummary(
        store,
        getNodeId(),
        epochId,
        page
      );
      ctx.log.info(result.event, result.event.event);
      return NextResponse.json(result.body, { status: result.status });
    }

    const epoch = await store.getEpoch(epochId);
    if (!epoch || epoch.status !== "finalized") {
      return NextResponse.json({ error: "Epoch not found" }, { status: 404 });
    }

    return NextResponse.json(
      epochClaimantsOperation.output.parse(
        await readFinalizedEpochClaimants(epochId)
      )
    );
  }
);
