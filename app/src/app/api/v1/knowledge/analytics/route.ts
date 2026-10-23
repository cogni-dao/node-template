// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/knowledge/analytics`
 * Purpose: Authenticated, node-local knowledge activity with explicit unavailable sources.
 * Scope: Thin composition over shared analytics and existing read ports. No mutations or log credentials.
 * Invariants: KNOWLEDGE_READ_REQUIRES_PRINCIPAL; ONE_COLLECTION_PER_PROCESS; NO_SHARED_RESPONSE_CACHE.
 * Side-effects: Bounded serial store reads; registry completion coverage receipt plus terminal HTTP receipt through the route wrapper.
 * Links: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-1e912cd7
 * @public
 */
import {
  collectKnowledgeAnalytics,
  KNOWLEDGE_ANALYTICS_VERSION,
  KnowledgeAnalyticsQuerySchema,
} from "@cogni/knowledge-store/analytics";
import { EVENT_NAMES, logEvent } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// No queue and no detached timeout: retain admission until the underlying port read settles.
let collecting = false;
const headers = { "Cache-Control": "private, no-store" };
// Do not forward an arbitrary adapter exception or reason string into operational logs.
const SAFE_REASONS = new Set([
  "source_error",
  "source_not_bound",
  "invalid_contribution_receipt",
  "invalid_event_timestamps",
  "inventory_limit",
  "contribution_limit",
  "change_row_limit",
  "lookup_event_limit",
  "call_budget",
  "deadline",
  "cancelled",
  "request_budget",
  "saturated",
  "authz_denied",
  "source_unavailable",
]);

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "knowledge.analytics",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
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
    const started = Date.now();
    try {
      const report = await collectKnowledgeAnalytics({
        nodeId: container.nodeId,
        hours: parsed.data.hours,
        ...(parsed.data.end ? { end: parsed.data.end } : {}),
        signal: request.signal,
        // No lookup binding: node identity does not imply operator node.flight authority.
        sources,
      });
      const coverage = Object.fromEntries(
        Object.entries(report.coverage).map(([name, source]) => [
          name,
          {
            status: source.status,
            reason:
              source.reason && SAFE_REASONS.has(source.reason)
                ? source.reason
                : source.reason
                  ? "source_error"
                  : null,
          },
        ])
      );
      const statuses = Object.values(report.coverage).map(
        (source) => source.status
      );
      logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_ANALYTICS_COMPLETE, {
        reqId: ctx.reqId,
        queryVersion: report.queryVersion,
        durationMs: Date.now() - started,
        status: statuses.every((status) => status === "complete")
          ? "complete"
          : statuses.every((status) => status === "unavailable")
            ? "unavailable"
            : "partial",
        coverage,
        counts: report.summary,
      });
      return NextResponse.json(report, { headers });
    } catch (error) {
      logEvent(ctx.log, EVENT_NAMES.KNOWLEDGE_ANALYTICS_COMPLETE, {
        reqId: ctx.reqId,
        queryVersion: KNOWLEDGE_ANALYTICS_VERSION,
        durationMs: Date.now() - started,
        status: "error",
        reason: "collection_error",
      });
      throw error;
    } finally {
      collecting = false;
    }
  }
);
