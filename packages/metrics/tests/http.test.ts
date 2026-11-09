// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics` tests/http
 * Purpose: Prove the framework-neutral route core: each of the seven handlers
 *   returns the contract shape, invalid input is a 400, a typed MetricError
 *   keeps its status, an unexpected failure is a quiet 503, and a pending
 *   compute is a 409.
 * Scope: Handlers over a stub service; no Next.js, no database.
 * Invariants: INVALID_INPUT_IS_400; TYPED_ERRORS; ONE_WIRE_CONTRACT.
 * Side-effects: none
 * Links: ../src/http.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
	createMetricHttpHandlers,
	METRIC_HTTP_HEADERS,
	type MetricHttpPorts,
	type MetricRouteService,
	metricErrorResult,
} from "../src/http";
import { MetricError } from "../src/contracts";

const ID = "00000000-0000-4000-8000-000000000001";

function observation(status: "ok" | "pending" = "ok") {
	return {
		id: ID,
		metricId: "open-work",
		definitionRevision: "1",
		definitionHash: "hash",
		calculatorVersion: "work.count@1",
		paramsHash: "params",
		node: "n",
		environment: "e",
		dataScope: "s",
		window: { start: "2026-11-01T00:00:00Z", end: "2026-11-01T01:00:00Z" },
		sourceWatermarks: [{ source: "work", asOf: "2026-11-01T01:00:00Z" }],
		observedAt: "2026-11-01T01:00:00Z",
		status,
		value: status === "ok" ? 3 : null,
		unit: "items",
		reason: null,
		evidenceRefs: ["node:work"],
	};
}
const definition = {
	id: "open-work",
	title: "Open work",
	revision: "1",
	spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 60 },
};
const view = {
	definition,
	latestAttempt: observation(),
	lastGood: observation(),
	viewState: "ok",
};

function setup(overrides: Partial<MetricRouteService> = {}) {
	const service = {
		list: vi.fn(async () => ({ items: [view], nextCursor: null, catalog: [] })),
		read: vi.fn(async () => view),
		history: vi.fn(async () => [observation()]),
		historyRange: vi.fn(async () => ({
			metricId: "open-work",
			unit: "items",
			from: "2026-11-01T00:00:00.000Z",
			to: "2026-11-01T02:00:00.000Z",
			step: "1h",
			buckets: [],
		})),
		observation: vi.fn(async () => ({ definition, observation: observation() })),
		compute: vi.fn(async () => observation()),
		bindings: vi.fn(async () => []),
		...overrides,
	} as unknown as MetricRouteService;
	const subject = vi.fn<MetricHttpPorts["subject"]>(async () => null);
	const onUnexpectedError = vi.fn();
	const goalProgress = vi.fn(async () => ({
		asOf: "2026-11-01T01:00:00.000Z",
		environment: "local",
		goals: [],
	}));
	const handlers = createMetricHttpHandlers({
		goalProgress,
		service: () => service,
		subject,
		onUnexpectedError,
	});
	return { handlers, service, subject, onUnexpectedError, goalProgress };
}

describe("metric HTTP core", () => {
	it("serves goals, list and read with their contract shapes", async () => {
		const { handlers, service } = setup();
		const goals = await handlers.goals();
		expect(goals).toMatchObject({ ok: true, status: 200 });
		if (goals.ok) expect(goals.body.goals).toEqual([]);

		const list = await handlers.list(new URLSearchParams("limit=5&after=x"));
		expect(list).toMatchObject({ ok: true, status: 200 });
		expect(service.list).toHaveBeenCalledWith(5, "x");

		const read = await handlers.read("open-work");
		expect(read.ok && read.body.history).toHaveLength(1);
		expect(read.ok && read.body.definition.id).toBe("open-work");
	});

	it("rejects invalid list, history, compute and observation input with 400", async () => {
		const { handlers, service } = setup();
		expect(await handlers.list(new URLSearchParams("limit=0"))).toEqual({
			ok: false,
			status: 400,
			body: { error: "invalid_input" },
		});
		const history = await handlers.history("m", new URLSearchParams("step=1h"));
		expect(history).toMatchObject({ ok: false, status: 400 });
		expect(history.body).toHaveProperty("issues");
		expect(
			await handlers.observation("m", "not-a-uuid"),
		).toEqual({ ok: false, status: 400, body: { error: "invalid_observation_id" } });
		expect(
			await handlers.compute("m", async () => {
				throw new SyntaxError("bad json");
			}),
		).toEqual({ ok: false, status: 400, body: { error: "invalid_json" } });
		expect(await handlers.compute("m", async () => ({}))).toMatchObject({
			ok: false,
			status: 400,
			body: { error: "invalid_input" },
		});
		expect(service.historyRange).not.toHaveBeenCalled();
		expect(service.compute).not.toHaveBeenCalled();
		expect(service.observation).not.toHaveBeenCalled();
	});

	it("reads ranged history and one immutable observation", async () => {
		const { handlers, service } = setup();
		const query = new URLSearchParams({
			from: "2026-11-01T00:00:00.000Z",
			to: "2026-11-01T02:00:00.000Z",
			step: "1h",
		});
		expect(await handlers.history("open-work", query)).toMatchObject({
			ok: true,
			status: 200,
		});
		expect(service.historyRange).toHaveBeenCalledWith("open-work", {
			from: "2026-11-01T00:00:00.000Z",
			to: "2026-11-01T02:00:00.000Z",
			step: "1h",
		});
		const snap = await handlers.observation("open-work", ID);
		expect(snap.ok && snap.body.observation.id).toBe(ID);
	});

	it("computes with 200, and answers 409 while the reading is pending", async () => {
		const done = setup();
		const ok = await done.handlers.compute("open-work", async () => ({
			requestKey: "k1",
		}));
		expect(ok).toMatchObject({ ok: true, status: 200 });
		const pending = setup({ compute: vi.fn(async () => observation("pending")) } as never);
		const waiting = await pending.handlers.compute("open-work", async () => ({
			requestKey: "k1",
		}));
		expect(waiting).toMatchObject({ ok: true, status: 409 });
	});

	it("projects a goal or hypothesis subject and 404s anything else", async () => {
		const { handlers, subject, service } = setup();
		subject.mockResolvedValueOnce({
			id: "goal-1",
			title: "Goal",
			entryType: "goal",
			kpiBindings: [],
			evaluateAt: new Date("2027-01-31T00:00:00Z"),
		});
		const found = await handlers.subject("goal-1");
		expect(found).toMatchObject({
			ok: true,
			body: { id: "goal-1", entryType: "goal", kpis: [] },
		});
		expect(service.bindings).toHaveBeenCalledWith([], {
			hypothesis: false,
			deadline: "2027-01-31T00:00:00.000Z",
		});
		subject.mockResolvedValueOnce({ id: "x", title: "X", entryType: "fact" });
		expect(await handlers.subject("x")).toEqual({
			ok: false,
			status: 404,
			body: { error: "subject_not_found" },
		});
		expect(await handlers.subject("missing")).toMatchObject({ status: 404 });
	});

	it("keeps a MetricError's status and hides every other failure behind 503", async () => {
		const { handlers, onUnexpectedError } = setup({
			read: vi.fn(async () => {
				throw new MetricError("metric_not_found", 404);
			}),
			list: vi.fn(async () => {
				throw new Error("db password leaked");
			}),
		} as never);
		expect(await handlers.read("nope")).toEqual({
			ok: false,
			status: 404,
			body: { error: "metric_not_found" },
		});
		expect(onUnexpectedError).not.toHaveBeenCalled();
		const failed = await handlers.list(new URLSearchParams());
		expect(failed).toEqual({
			ok: false,
			status: 503,
			body: { error: "metrics_unavailable" },
		});
		expect(onUnexpectedError).toHaveBeenCalledTimes(1);
	});

	it("answers 503 on every service read when the node has no metrics service", async () => {
		const handlers = createMetricHttpHandlers({
			goalProgress: async () => ({
				asOf: "2026-11-01T00:00:00.000Z",
				environment: "local",
				goals: [],
			}),
			service: () => undefined,
			subject: async () => null,
		});
		for (const result of [
			await handlers.read("m"),
			await handlers.list(new URLSearchParams()),
			await handlers.compute("m", async () => ({ requestKey: "k" })),
		])
			expect(result).toEqual({
				ok: false,
				status: 503,
				body: { error: "metrics_unavailable" },
			});
	});

	it("publishes the no-store header every metrics response must carry", () => {
		expect(METRIC_HTTP_HEADERS).toEqual({ "Cache-Control": "no-store" });
	});

	it("maps errors through metricErrorResult alone", () => {
		expect(metricErrorResult(new MetricError("subject_not_found", 404))).toEqual({
			ok: false,
			status: 404,
			body: { error: "subject_not_found" },
		});
		const seen = vi.fn();
		expect(metricErrorResult(new Error("x"), seen).status).toBe(503);
		expect(seen).toHaveBeenCalledOnce();
	});
});
