// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Ops registration is explicit, idempotent and preserves paused schedules. */
import { verifySchedulerBearer } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { ensureMetricsRefreshSchedule } from "@/bootstrap/jobs/metrics-refresh.job";
import { serverEnv } from "@/shared/env";
export const runtime = "nodejs";
export const POST = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.sync.internal", auth: { mode: "none" } },
	async (_ctx, request) => {
		if (
			!verifySchedulerBearer(
				request.headers.get("authorization"),
				serverEnv().SCHEDULER_API_TOKEN,
			)
		)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		return NextResponse.json(await ensureMetricsRefreshSchedule());
	},
);
