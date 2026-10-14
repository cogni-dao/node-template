// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Authenticated one-call health surface for the node-owned Temporal substrate. */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { checkAgentWorkflowHealth } from "@/bootstrap/jobs/checkAgentWorkflowHealth.job";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "temporal.health", auth: { mode: "required", getSessionUser } },
  async () => {
    const health = await checkAgentWorkflowHealth();
    return NextResponse.json(health, {
      status: health.status === "healthy" ? 200 : 503,
    });
  }
);
