// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/cognition/route`
 * Purpose: GET /api/v1/cognition — the node's session-start cognition substrate
 *   bundle. Composes the irreducible session invariants (code-owned)
 *   with a live skills index + domain pointers from the knowledge hub, plus a
 *   rendered markdown bundle a SessionStart hook echoes into agent context.
 * Scope: Single authed GET (any principal: cookie-session human OR bearer
 *   agent). Reads via container.knowledgeStorePort. Index-first for skills +
 *   domains — their full bodies stay behind the same authed read routes
 *   (KNOWLEDGE_READ_REQUIRES_PRINCIPAL); the current-node orientation entry is
 *   rendered IN FULL so the bootstrap IS the agent's operating map.
 *   The public bootstrap seam stays /api/v1/agent/register: register → key → cognition.
 * Invariants:
 *   - INDEX_FIRST: returns skill/domain pointers; the current-node orientation
 *     entry is the one full body (ORIENTATION_LOADED_IN_FULL).
 *   - IRREDUCIBLE_INVARIANTS_ALWAYS_PRESENT: invariants + markdown render even
 *     when the hub is unconfigured or empty.
 *   - NO_INTERNAL_BIND_ADDR: origin derived from forwarded headers first.
 *   - ONE_READ_PER_REVISION: hub inputs come from `readCognitionSnapshot`
 *     (memoized per store HEAD; a slow or failed revision check
 *     serves the last complete snapshot and logs `stale`); a weak ETag
 *     over revision, build, origin, name and mission
 *     answers a matching If-None-Match with 304 (bug.0018).
 *   - SERVER_TIMING: every 200/304 carries `Server-Timing` (hub read and
 *     total, with memo/read/stale), so latency is provable from any client.
 *   - NO_GOAL_PROGRESS: goal KPI readings are not bootstrap; agents read them
 *     live from /api/v1/metrics/goals.
 * Side-effects: IO (HTTP response, Doltgres reads via container port)
 * Links: docs/spec/node-baas-architecture.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import {
	CognitionBundleResponseSchema,
	type CognitionDomainPointer,
} from "@cogni/node-contracts";
import {
	type GoalsSection,
	readCognitionSnapshot,
} from "@cogni/knowledge-store";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeMission, getNodeName } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import {
	type OrientationEntry,
	renderBundle,
	SESSION_BOOTSTRAP_INVARIANTS,
} from "./_bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Authed but principal-agnostic (index-only, identical for every caller). The
// hub inputs are memoized per store revision, so a repeat costs one bounded
// revision read; clients revalidate every use and a matching ETag returns 304.
const CACHE_CONTROL = "private, no-cache, must-revalidate";

/** External origin this request reached us through (forwarded headers first). */
function publicOrigin(request: Request): string {
	const url = new URL(request.url);
	const host =
		request.headers.get("x-forwarded-host") ??
		request.headers.get("host") ??
		url.host;
	const proto =
		request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	return `${proto}://${host}`;
}

/** True when an If-None-Match header names this entity tag (weak compare) or `*`. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	const bare = etag.replace(/^W\//, "");
	return ifNoneMatch
		.split(",")
		.map((tag) => tag.trim().replace(/^W\//, ""))
		.some((tag) => tag === bare || tag === "*");
}

export const GET = wrapRouteHandlerWithLogging(
	{
		routeId: "cognition.bundle",
		auth: { mode: "required", getSessionUser },
	},
	async (ctx, request, sessionUser) => {
		if (!sessionUser) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
		const started = performance.now();
		const container = getContainer();
		const origin = publicOrigin(request);
		const node = container.nodeId;
		const name = getNodeName();
		const mission = getNodeMission();
		const buildSha = serverEnv().APP_BUILD_SHA ?? "unknown";
		const generatedAt = new Date().toISOString();

		// Cognition is delivered live from the hub; the irreducible invariants below
		// are the only piece that must survive an unconfigured/empty hub. A
		// node-specific `<name>-agent-orientation` wins over the generic
		// `cogni-agent-orientation` starter seed every node inherits. Goal KPI
		// readings are not bootstrap: agents read them live (GET /api/v1/metrics/goals).
		const port = container.knowledgeStorePort;
		const readStarted = performance.now();
		const read = port
			? await readCognitionSnapshot(port, [
					`${name}-agent-orientation`,
					"cogni-agent-orientation",
				])
			: null;
		const readMs = performance.now() - readStarted;
		// Server-Timing (W3C): any client can read the server cost without Loki.
		const serverTiming = (total: number) =>
			[
				`hub;dur=${readMs.toFixed(1)};desc="${read?.memoHit ? "memo" : "read"}${read?.stale ? " stale" : ""}"`,
				`total;dur=${total.toFixed(1)}`,
			].join(", ");
		const domainPointers: CognitionDomainPointer[] = [
			...(read?.snapshot.domains ?? []),
		];
		const governingIndex = read?.snapshot.governingIndex ?? [];
		const skillsIndex = governingIndex.map((r) => ({
			id: r.id,
			domain: r.domain,
			entryType: r.entryType,
			title: r.useWhen,
		}));
		const orientation: OrientationEntry | null =
			read?.snapshot.orientation ?? null;
		// A failure is rendered visibly in the bundle and logged, never silently omitted.
		const goals: GoalsSection = read?.snapshot.goals ?? {
			status: "unavailable",
			reason: "knowledge hub not configured",
		};
		if (goals.status === "unavailable") {
			ctx.log.warn({ reason: goals.reason }, "cognition.goals_unavailable");
		}
		// Only a complete, HEAD-confirmed bundle is revalidatable; a degraded or
		// stale one is never confirmed by 304 or reused.
		const revision = read?.snapshot.revision ?? null;
		const etag =
			revision && goals.status === "ok" && !read?.stale
				? `W/"${createHash("sha256")
						.update(
							[revision, buildSha, origin, name, mission ?? ""].join("\u0000"),
						)
						.digest("base64url")
						.slice(0, 27)}"`
				: null;
		if (etag && matchesEtag(request.headers.get("if-none-match"), etag)) {
			ctx.log.info(
				{ revision, notModified: true },
				"cognition.bundle_not_modified",
			);
			return new NextResponse(null, {
				status: 304,
				headers: {
					ETag: etag,
					"Cache-Control": CACHE_CONTROL,
					"Server-Timing": serverTiming(performance.now() - started),
				},
			});
		}

		const toolingInvariants = [...SESSION_BOOTSTRAP_INVARIANTS];
		const recallProtocol =
			`RECALL both planes before writing: merged via GET ${origin}/api/v1/knowledge?domain=<domain>, ` +
			`and your open contribution branch via GET ${origin}/api/v1/knowledge/contributions/{id}/diff. ` +
			"Refine in place over writing new (REFINE_OVER_EXTEND).";

		const rendered = renderBundle({
			node,
			name,
			mission,
			generatedAt,
			origin,
			buildSha,
			toolingInvariants,
			skillsIndex,
			governingIndex,
			domainPointers,
			orientation,
			goals,
		});
		const { governingRender, markdown } = rendered;

		ctx.log.info(
			{
				node,
				name,
				skills: skillsIndex.length,
				governingMode: governingRender.mode,
				governingOverBudget: governingRender.overBudget,
				domains: domainPointers.length,
				orientation: orientation?.id ?? null,
				goalsStatus: goals.status,
				goals: goals.status === "ok" ? goals.goals.map((g) => g.id) : [],
				hub: Boolean(port),
				revision,
				memoHit: read?.memoHit ?? false,
				stale: read?.stale ?? false,
				...(read && !read.memoHit ? { readMs: read.snapshot.readMs } : {}),
			},
			"cognition.bundle_success",
		);

		const response = NextResponse.json(
			CognitionBundleResponseSchema.parse({
				node,
				name,
				mission,
				version: "v1",
				buildSha,
				generatedAt,
				toolingInvariants,
				skillsIndex,
				governingIndex,
				governingRender,
				domainPointers,
				recallProtocol,
				markdown,
			}),
		);
		response.headers.set("Cache-Control", etag ? CACHE_CONTROL : "no-store");
		if (etag) response.headers.set("ETag", etag);
		response.headers.set(
			"Server-Timing",
			serverTiming(performance.now() - started),
		);
		return response;
	},
);
