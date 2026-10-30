// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Authenticated metrics endpoint. Typed package contracts, shared service. */
import { NextResponse } from "next/server";
import { metricHttpError, metricList } from "@/app/_facades/metrics.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging(
	{ routeId: "metrics.metricList", auth: { mode: "required", getSessionUser } },
	async (_ctx, _request, user) => {
		if (!user)
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		try {
			const response = await metricList();
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return metricHttpError(error);
		}
	},
);
