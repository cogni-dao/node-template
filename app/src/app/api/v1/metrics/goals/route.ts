// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

import { NextResponse } from "next/server";
import {
	metricHandlers,
	metricHttpError,
	metricResponse,
} from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.goalsRead", auth: { mode: "required", getSessionUser } },
	async (ctx, request, user) => {
		const started = Date.now();
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		try {
			const result = await metricHandlers().goals(
				new URL(request.url).searchParams,
			);
			if (result.ok) {
				const data = result.body;
				logEvent(ctx.log, EVENT_NAMES.GOALS_PROGRESS_READ, {
					reqId: ctx.reqId,
					routeId: ctx.routeId,
					goalCount: data.goals.length,
					metricCount: data.goals.reduce((n, g) => n + g.kpis.length, 0),
					hypothesisCount: data.goals.reduce(
						(n, g) => n + g.hypotheses.length,
						0,
					),
					outcome: "success",
					// A stale 200 is the last good result, not a fresh read.
					stale: data.stale !== undefined,
					...(data.stale
						? {
								staleReason: data.stale.reason,
								staleAgeSeconds: data.stale.ageSeconds,
							}
						: {}),
					status: result.status,
					durationMs: Date.now() - started,
				});
			} else {
				logEvent(ctx.log, EVENT_NAMES.GOALS_PROGRESS_READ, {
					reqId: ctx.reqId,
					routeId: ctx.routeId,
					status: result.status,
					durationMs: Date.now() - started,
					outcome: "error",
					errorCode: result.body.error,
				});
			}
			return metricResponse(result);
		} catch (error) {
			logEvent(ctx.log, EVENT_NAMES.GOALS_PROGRESS_READ, {
				reqId: ctx.reqId,
				routeId: ctx.routeId,
				status: 503,
				durationMs: Date.now() - started,
				outcome: "error",
				errorCode: "metrics_unavailable",
			});
			return metricHttpError(error);
		}
	},
);
