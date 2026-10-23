// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/analytics`
 * Purpose: Authenticated, node-local knowledge activity with explicit unavailable sources.
 * Scope: Thin composition over shared analytics and existing read ports. No mutations or log credentials.
 * Invariants: KNOWLEDGE_READ_REQUIRES_PRINCIPAL; ONE_COLLECTION_PER_PROCESS; NO_SHARED_RESPONSE_CACHE.
 * Side-effects: Bounded serial store reads; terminal HTTP receipt through the route wrapper.
 * Links: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-1e912cd7
 * @public
 */
import {
  collectKnowledgeAnalytics,
  KnowledgeAnalyticsQuerySchema,
} from "@cogni/knowledge-store/analytics";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// No queue and no detached timeout: retain admission until the underlying port read settles.
let collecting = false;
const headers = { "Cache-Control": "private, no-store" };

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.analytics",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser)
      return NextResponse.json(
        { error: "unauthorized" },
        { status: 401, headers }
      );
    const params = new URL(request.url).searchParams;
    const parsed = KnowledgeAnalyticsQuerySchema.safeParse({
      hours: params.get("hours") ?? undefined,
      end: params.get("end") ?? undefined,
    });
    if (
      !parsed.success ||
      (parsed.data.end && Date.parse(parsed.data.end) > Date.now())
    ) {
      return NextResponse.json(
        { error: "invalid_window" },
        { status: 400, headers }
      );
    }
    const container = getContainer();
    const sources = container.knowledgeAnalyticsSources;
    if (!sources)
      return NextResponse.json(
        { error: "knowledge_unavailable" },
        { status: 503, headers }
      );
    if (collecting)
      return NextResponse.json(
        { error: "analytics_busy" },
        { status: 429, headers: { ...headers, "Retry-After": "5" } }
      );
    collecting = true;
    try {
      const report = await collectKnowledgeAnalytics({
        nodeId: container.nodeId,
        hours: parsed.data.hours,
        ...(parsed.data.end ? { end: parsed.data.end } : {}),
        signal: request.signal,
        // No lookup binding: node identity does not imply operator node.flight authority.
        sources,
      });
      return NextResponse.json(report, { headers });
    } finally {
      collecting = false;
    }
  }
);
