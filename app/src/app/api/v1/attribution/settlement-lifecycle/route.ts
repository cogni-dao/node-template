// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/attribution/settlement-lifecycle/route`
 * Purpose: Authenticated endpoint for persisted epoch settlement and chain-proven publication progress.
 * Scope: Auth and dependency composition only. Does not mutate settlement state or contain lifecycle derivation.
 * Invariants: NODE_SCOPED, VALIDATE_IO, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: IO (HTTP response, database reads, EVM RPC read).
 * Links: packages/node-contracts/src/attribution.settlement-lifecycle.v1.contract.ts
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { handleSettlementLifecycle } from "@/app/api/v1/attribution/_lib/settlement-lifecycle";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { readLiveDistributionMerkleRoot } from "@/bootstrap/settlement-runtime";
import {
  getNodeId,
  getNodeTokenomicsConfig,
  getScopeId,
} from "@/shared/config";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "ledger.settlement-lifecycle",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx) => {
    const tokenomics = getNodeTokenomicsConfig();
    const result = await handleSettlementLifecycle({
      store: getContainer().attributionStore,
      nodeId: getNodeId(),
      scopeId: getScopeId(),
      chainId: tokenomics.chainId,
      distributorAddress: tokenomics.distributorAddress,
      readLiveRoot: readLiveDistributionMerkleRoot,
    });

    logEvent(ctx.log, EVENT_NAMES.ATTRIBUTION_SETTLEMENT_LIFECYCLE_READ, {
      ...result.event,
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status: result.status,
    });
    return NextResponse.json(result.body, { status: result.status });
  }
);
