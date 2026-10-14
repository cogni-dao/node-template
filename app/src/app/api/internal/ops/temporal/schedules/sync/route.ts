// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Authenticated node-local trigger for sovereign Workflow schedule reconciliation. */
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { runAgentWorkflowSchedulesSyncJob } from "@/bootstrap/jobs/syncAgentWorkflowSchedules.job";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bearer(header: string | null): string | null {
  if (!header || header.length > 512) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] && match[1].length <= 256 ? match[1] : null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "temporal.schedules.sync.internal", auth: { mode: "none" } },
  async (_ctx, request) => {
    const configured = serverEnv().INTERNAL_OPS_TOKEN;
    const provided = bearer(request.headers.get("authorization"));
    if (!configured) {
      return NextResponse.json({ error: "service not configured" }, { status: 500 });
    }
    if (!provided || !safeEqual(provided, configured)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(await runAgentWorkflowSchedulesSyncJob());
  }
);
