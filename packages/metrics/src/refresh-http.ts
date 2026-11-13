// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/http` (refresh tick)
 * Purpose: Framework-neutral core of the scheduler's refresh route. It checks
 *   the dispatch key and body and answers an idle tick from the in-memory
 *   refresh clock. Before any dispatch record or grant read, the idle answer
 *   touches no database. Every tick that does work keeps one idempotent
 *   dispatch receipt.
 * Scope: Pure over injected ports. The node route keeps the scheduler bearer
 *   check, its own dispatch-receipt port, the grant-checked runner, request
 *   logging and the framework response.
 * Invariants: IDLE_TOUCHES_NO_DATABASE; ONE_RECEIPT_PER_WORKING_TICK; the
 *   returned `event` is the complete `metric.refresh_complete` field set.
 * Links: ./index.ts (idleTick, refreshDue), packages/metrics/AGENTS.md
 * @public
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { MetricService } from "./index.js";

export type RefreshDueResult = Awaited<ReturnType<MetricService["refreshDue"]>>;

/** The dispatch-receipt operations a node already owns for scheduled tasks. */
export interface RefreshDispatchReceipts {
	checkIdempotency(
		key: string,
		hash: string,
	): Promise<{
		status: "new" | "cached" | "pending" | "stale" | "mismatch";
		request?: { ok?: boolean | null } | null;
	}>;
	createPendingRequest(
		key: string,
		hash: string,
		runId: string,
		meta: null,
	): Promise<unknown>;
	finalizeRequest(
		key: string,
		result: { ok: boolean; errorCode: string | null },
	): Promise<unknown>;
}

export interface RefreshTickPorts {
	/** The node's metric service; absent means metrics are not configured. */
	service: Pick<MetricService, "idleTick"> | undefined;
	receipts: RefreshDispatchReceipts;
	/** Validates the execution grant's scope, then runs `refreshDue`. */
	run(executionGrantId: string): Promise<RefreshDueResult>;
}

export interface RefreshTickInput {
	/** The node's scheduler-bearer verdict. */
	authorized: boolean;
	idempotencyKey: string | null;
	/** `<nodeId>/metrics:<nodeId>:refresh/`; an ISO time must follow it. */
	keyPrefix: string;
	/** Reads the JSON body; a throw means invalid JSON. */
	readBody(): Promise<unknown>;
}

export interface RefreshTickResult {
	status: number;
	body: Record<string, unknown>;
	/** The `metric.refresh_complete` fields, when the tick completed. */
	event?: Record<string, unknown>;
}

const BodySchema = z.strictObject({ executionGrantId: z.uuid() });

export async function handleRefreshTick(
	ports: RefreshTickPorts,
	input: RefreshTickInput,
): Promise<RefreshTickResult> {
	if (!input.authorized)
		return { status: 401, body: { error: "unauthorized" } };
	const key = input.idempotencyKey;
	if (
		!key?.startsWith(input.keyPrefix) ||
		!z.iso
			.datetime({ offset: true })
			.safeParse(key.slice(input.keyPrefix.length)).success
	)
		return { status: 400, body: { error: "invalid_dispatch_key" } };
	let raw: unknown;
	try {
		raw = await input.readBody();
	} catch {
		return { status: 400, body: { error: "invalid_json" } };
	}
	const body = BodySchema.safeParse(raw);
	if (!body.success) return { status: 400, body: { error: "grant_required" } };
	// An idle tick does no work, so it needs no dispatch receipt or grant read.
	const idle = ports.service?.idleTick();
	if (idle)
		return {
			status: 200,
			body: { ok: true, ...idle },
			event: {
				scanned: idle.scanned,
				dueCount: 0,
				definitionsTruncated: idle.truncated,
				prunedCount: 0,
				pruneFailed: false,
				idle: true,
				measuredCount: 0,
				errorCount: 0,
				outcome: "success",
				errorCode: null,
			},
		};
	const receipts = ports.receipts;
	const hash = createHash("sha256")
		.update(JSON.stringify(body.data))
		.digest("hex");
	const previous = await receipts.checkIdempotency(key, hash);
	if (previous.status === "cached")
		return {
			status: 200,
			body: { ok: previous.request?.ok === true, replay: true },
		};
	if (previous.status === "pending" || previous.status === "stale")
		return { status: 409, body: { error: "dispatch_pending" } };
	if (previous.status === "mismatch")
		return { status: 422, body: { error: "dispatch_payload_mismatch" } };
	try {
		await receipts.createPendingRequest(key, hash, randomUUID(), null);
	} catch (error) {
		const raced = await receipts.checkIdempotency(key, hash);
		if (raced.status !== "new")
			return { status: 409, body: { error: "dispatch_pending" } };
		throw error;
	}
	let result: RefreshDueResult;
	try {
		result = await ports.run(body.data.executionGrantId);
	} catch (error) {
		await receipts.finalizeRequest(key, { ok: false, errorCode: "internal" });
		throw error;
	}
	await receipts.finalizeRequest(key, { ok: true, errorCode: null });
	const failed = result.observations.filter(
		(x) => x.status === "error" || x.status === "unavailable",
	);
	return {
		status: 200,
		body: { ok: true, ...result },
		event: {
			scanned: result.scanned,
			dueCount: result.due,
			definitionsTruncated: result.truncated,
			prunedCount: result.pruned,
			pruneFailed: result.pruneFailed,
			idle: false,
			measuredCount: result.observations.length,
			errorCount: failed.length,
			outcome: failed.length ? "error" : "success",
			errorCode: failed.length ? "metric_source_unavailable" : null,
		},
	};
}
