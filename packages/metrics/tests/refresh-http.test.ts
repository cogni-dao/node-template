// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it, vi } from "vitest";
import {
	handleRefreshTick,
	type RefreshDueResult,
	type RefreshTickPorts,
} from "../src/refresh-http.js";

const prefix = "n/metrics:n:refresh/";
const goodKey = `${prefix}2026-11-13T03:00:00.000Z`;
const grant = { executionGrantId: "00000000-0000-4000-8000-000000000001" };
const idleSummary = {
	scanned: 3,
	due: 0 as const,
	truncated: false,
	pruned: 0 as const,
	pruneFailed: false as const,
	observations: [],
};
const work: RefreshDueResult = {
	scanned: 3,
	due: 2,
	truncated: false,
	pruned: 1,
	pruneFailed: false,
	observations: [
		{ status: "ok" } as RefreshDueResult["observations"][number],
		{ status: "error" } as RefreshDueResult["observations"][number],
	],
};

function ports(over: Partial<RefreshTickPorts> = {}) {
	const receipts = {
		checkIdempotency: vi.fn(async () => ({ status: "new" as const })),
		createPendingRequest: vi.fn(async () => undefined),
		finalizeRequest: vi.fn(async () => undefined),
	};
	const run = vi.fn(async () => work);
	return {
		receipts,
		run,
		value: {
			service: { idleTick: () => null },
			receipts,
			run,
			...over,
		} as RefreshTickPorts,
	};
}
const input = (over: Record<string, unknown> = {}) => ({
	authorized: true,
	idempotencyKey: goodKey,
	keyPrefix: prefix,
	readBody: async () => grant,
	...over,
});

describe("refresh tick core", () => {
	it("rejects before any read: bearer, key, JSON and grant", async () => {
		const p = ports();
		expect(
			await handleRefreshTick(p.value, input({ authorized: false })),
		).toMatchObject({ status: 401 });
		expect(
			await handleRefreshTick(p.value, input({ idempotencyKey: "x" })),
		).toMatchObject({ status: 400, body: { error: "invalid_dispatch_key" } });
		expect(
			await handleRefreshTick(
				p.value,
				input({
					readBody: async () => {
						throw new Error("bad json");
					},
				}),
			),
		).toMatchObject({ status: 400, body: { error: "invalid_json" } });
		expect(
			await handleRefreshTick(p.value, input({ readBody: async () => ({}) })),
		).toMatchObject({ status: 400, body: { error: "grant_required" } });
		expect(p.receipts.checkIdempotency).not.toHaveBeenCalled();
	});
	it("answers an idle tick with no receipt and no run", async () => {
		const p = ports();
		const r = await handleRefreshTick(
			{ ...p.value, service: { idleTick: () => idleSummary } },
			input(),
		);
		expect(r).toMatchObject({
			status: 200,
			body: { ok: true, scanned: 3, due: 0 },
			event: { idle: true, dueCount: 0, outcome: "success" },
		});
		expect(p.receipts.checkIdempotency).not.toHaveBeenCalled();
		expect(p.run).not.toHaveBeenCalled();
	});
	it("runs a working tick once with one receipt and full log fields", async () => {
		const p = ports();
		const r = await handleRefreshTick(p.value, input());
		expect(r.event).toEqual({
			scanned: 3,
			dueCount: 2,
			definitionsTruncated: false,
			prunedCount: 1,
			pruneFailed: false,
			idle: false,
			measuredCount: 2,
			errorCount: 1,
			outcome: "error",
			errorCode: "metric_source_unavailable",
		});
		expect(p.run).toHaveBeenCalledWith(grant.executionGrantId);
		expect(p.receipts.createPendingRequest).toHaveBeenCalledTimes(1);
		expect(p.receipts.finalizeRequest).toHaveBeenCalledWith(goodKey, {
			ok: true,
			errorCode: null,
		});
	});
	it("replays, holds and refuses receipts the way the dispatcher expects", async () => {
		for (const [status, expected] of [
			["cached", { status: 200, body: { ok: true, replay: true } }],
			["pending", { status: 409, body: { error: "dispatch_pending" } }],
			["stale", { status: 409, body: { error: "dispatch_pending" } }],
			["mismatch", { status: 422, body: { error: "dispatch_payload_mismatch" } }],
		] as const) {
			const p = ports();
			p.receipts.checkIdempotency.mockResolvedValue({
				status,
				request: { ok: true },
			} as never);
			expect(await handleRefreshTick(p.value, input())).toMatchObject(expected);
			expect(p.run).not.toHaveBeenCalled();
		}
	});
	it("finalizes a failed run as internal and rethrows", async () => {
		const p = ports();
		p.run.mockRejectedValue(new Error("grant denied"));
		await expect(handleRefreshTick(p.value, input())).rejects.toThrow(
			"grant denied",
		);
		expect(p.receipts.finalizeRequest).toHaveBeenCalledWith(goodKey, {
			ok: false,
			errorCode: "internal",
		});
	});
});
