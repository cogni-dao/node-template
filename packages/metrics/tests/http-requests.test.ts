// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * http.requests@1: request health from `http_requests_total` over a fake
 * instant reader. Each test names the defect it guards: a query that widens
 * scope, a missing feed read as 0, an error text leaking into a reading.
 */
import { describe, expect, it } from "vitest";
import type { CalculatorContext, MetricCalculator } from "../src/contracts.js";
import {
	createGoalMetrics,
	PACKAGE_CALCULATOR_IDS,
	RESERVED_CALCULATOR_FAMILIES,
} from "../src/knowledge.js";
import {
	createHttpRequestsCalculator,
	HTTP_REQUESTS_ID,
	httpRequestQueries,
	PROM_MAX_SERIES,
	type PromInstantReader,
	type PromInstantSample,
} from "../src/prometheus.js";
import { createTickReads } from "../src/tick-reads.js";
import { fakeSql, noObservations } from "./fakes.js";

const END = "2026-11-18T12:00:00.000Z";
const endSec = Date.parse(END) / 1000;
const HOURS = 24;
const MATCHERS = 'app="cogni-template",env="test-env",node="node-1"';
const window = {
	start: new Date((endSec - HOURS * 3600) * 1000).toISOString(),
	end: END,
};
const Q = httpRequestQueries(MATCHERS, HOURS);
type QueryName = keyof typeof Q;

const one = (value: number | string): PromInstantSample[] => [
	{ metric: {}, value: [endSec, String(value)] },
];
const routes = (rows: Record<string, number>): PromInstantSample[] =>
	Object.entries(rows).map(([route, n]) => ({
		metric: { route },
		value: [endSec, String(n)],
	}));
const vector = (result: PromInstantSample[]) => ({
	resultType: "vector",
	result,
});

/** A feed that is fresh, covers the window, and served 1000 requests of which 20 failed. */
const healthy: Record<QueryName, PromInstantSample[]> = {
	freshness: one(endSec - 60),
	coverage: one(endSec - HOURS * 3600 + 300),
	volume: one(1000),
	success_ratio: one(98),
	route_totals: routes({ "a.route": 600, "b.route": 400 }),
	route_failures: routes({ "a.route": 20 }),
};

/** A reader answering each pinned query from `answers`; every call is recorded. */
function fakeReader(answers: Partial<Record<QueryName, PromInstantSample[]>> = {}) {
	const calls: Array<{ query: string; time: Date; signal?: AbortSignal }> = [];
	const table = { ...healthy, ...answers };
	const reader: PromInstantReader = {
		async queryInstant(params) {
			calls.push(params);
			const name = (Object.keys(Q) as QueryName[]).find(
				(k) => Q[k] === params.query,
			);
			if (!name) throw new Error(`unpinned query: ${params.query}`);
			return vector(table[name]);
		},
	};
	return { reader, calls };
}

function context(signal = new AbortController().signal) {
	let reads = 0;
	const ctx: CalculatorContext = {
		window,
		signal,
		budget: {
			timeoutMs: 15000,
			maxSourceCalls: 3,
			maxRows: PROM_MAX_SERIES,
			maxResponseBytes: 1048576,
		},
		async read(source) {
			if (++reads > 3) throw new Error("source_call_budget");
			return source(signal, ctx.budget);
		},
	};
	return { ctx, reads: () => reads };
}

function calculator(
	reader?: PromInstantReader,
	over: Partial<Parameters<typeof createHttpRequestsCalculator>[0]> = {},
): MetricCalculator {
	return createHttpRequestsCalculator({
		node: "node-1",
		environment: "test-env",
		share: (_key, fn, signal) => fn(signal),
		...(reader
			? { prometheus: { query: reader, labels: { app: "cogni-template" } } }
			: {}),
		...over,
	});
}

const params = (
	output: "success_ratio" | "worst_route_failure",
	more: Record<string, unknown> = {},
) => ({ output, hours: HOURS, minRequests: 100, ...more });

describe("http.requests@1 queries", () => {
	it("pins the ratio query text and its served-route exclusion", () => {
		expect(Q.success_ratio).toBe(
			`100 * (sum(increase(http_requests_total{${MATCHERS},status!="5xx",route!~"meta\\\\..*|.*\\\\.internal"}[24h])) or vector(0)) / sum(increase(http_requests_total{${MATCHERS},route!~"meta\\\\..*|.*\\\\.internal"}[24h]))`,
		);
		// Defect guarded: a window where every request failed returned an empty
		// vector (numerator absent), which would read as unknown instead of 0%.
		expect(Q.success_ratio).toContain("or vector(0)");
		expect(Q.freshness).toBe(
			`max(last_over_time(timestamp(http_requests_total{${MATCHERS}})[30m:1m]))`,
		);
		expect(Q.coverage).toBe(
			`min(min_over_time(timestamp(http_requests_total{${MATCHERS}})[24h:5m]))`,
		);
	});

	it("carries the node and env matchers on every query a read issues", async () => {
		// Defect guarded: a query without the node matcher would read another node's traffic.
		for (const output of ["success_ratio", "worst_route_failure"] as const) {
			const { reader, calls } = fakeReader();
			await calculator(reader).compute(params(output), context().ctx);
			expect(calls.length).toBeGreaterThanOrEqual(4);
			for (const { query } of calls) {
				expect(query).toContain('node="node-1"');
				expect(query).toContain('env="test-env"');
				expect(query).toContain('app="cogni-template"');
			}
		}
	});

	it("refuses fixed labels that name the node or env label, and values outside the selector set", () => {
		// Defect guarded: a labels input overriding node or env widens the scope.
		const make = (labels: Record<string, string>, labelNames?: object) => () =>
			createGoalMetrics({
				knowledgeSql: fakeSql(() => []).sql,
				observationsSql: noObservations,
				node: "node-1",
				environment: "test-env",
				log: () => undefined,
				prometheus: { query: fakeReader().reader, labels, labelNames },
			});
		expect(make({ node: "other" })).toThrow();
		expect(make({ env: "production" })).toThrow();
		expect(make({ tenant: "other" }, { node: "tenant" })).toThrow();
		expect(make({ app: 'x"}or{a="b' })).toThrow();
		expect(make({ app: "cogni-template" })).not.toThrow();
	});

	it("rejects a scope value outside the selector set before any read", async () => {
		// Defect guarded: a node or env value carrying a quote reaching PromQL text.
		const { reader, calls } = fakeReader();
		const bad = calculator(reader, { node: 'n"} or vector(1) #' });
		await expect(
			bad.compute(params("success_ratio"), context().ctx),
		).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("keeps params strict: no query key, hours 1..168, known output", () => {
		const schema = calculator().paramsSchema;
		expect(schema.safeParse(params("success_ratio")).success).toBe(true);
		expect(
			schema.safeParse(params("success_ratio", { query: "up" })).success,
		).toBe(false);
		expect(schema.safeParse(params("success_ratio", { hours: 0 })).success).toBe(
			false,
		);
		expect(
			schema.safeParse(params("success_ratio", { hours: 169 })).success,
		).toBe(false);
		expect(
			schema.safeParse(params("success_ratio", { hours: 1.5 })).success,
		).toBe(false);
		expect(schema.safeParse(params("p99" as never)).success).toBe(false);
		expect(
			schema.safeParse(params("success_ratio", { minRequests: 0 })).success,
		).toBe(false);
	});

	it("evaluates every query at the window end", async () => {
		// Defect guarded: a query at wall-clock now reads a different window than the observation records.
		const { reader, calls } = fakeReader();
		await calculator(reader).compute(params("success_ratio"), context().ctx);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) expect(call.time.toISOString()).toBe(END);
	});
});

describe("http.requests@1 success_ratio", () => {
	it("reads the ratio computed in the query", async () => {
		const { reader } = fakeReader();
		const { ctx, reads } = context();
		const sample = await calculator(reader).compute(params("success_ratio"), ctx);
		expect(sample).toMatchObject({ value: 98, unit: "%", complete: true });
		expect(sample.evidenceRefs).toContain("counts:requests=1000");
		expect(reads()).toBeLessThanOrEqual(3);
	});

	it("excludes meta.* and *.internal routes from the KPI queries only", () => {
		// Defect guarded: a probe or machine route diluting or failing the KPI, or hiding in the diagnostic.
		const excluded = 'route!~"meta\\\\..*|.*\\\\.internal"';
		expect(Q.success_ratio).toContain(excluded);
		expect(Q.volume).toContain(excluded);
		expect(Q.route_totals).not.toContain("route!~");
		expect(Q.route_failures).not.toContain("route!~");
	});

	it("reads no series as series_absent, never 0", async () => {
		const { reader } = fakeReader({ freshness: [], coverage: [] });
		const sample = await calculator(reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
		expect(sample.evidenceRefs).toContain("series_absent");
	});

	it("reads a feed whose newest sample is over ten minutes old as feed_stale", async () => {
		// Defect guarded: a dead scrape read as the last window's healthy ratio.
		const stale = fakeReader({ freshness: one(endSec - 601) });
		const sample = await calculator(stale.reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample.complete).toBe(false);
		expect(sample.evidenceRefs).toContain("feed_stale");
		// Samples in the window but none in the last 30 minutes is stale, not absent.
		const gone = fakeReader({ freshness: [] });
		const empty = await calculator(gone.reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(empty.evidenceRefs).toContain("feed_stale");
		expect(empty.evidenceRefs).not.toContain("series_absent");
		// Exactly ten minutes is fresh.
		const edge = fakeReader({ freshness: one(endSec - 600) });
		expect(
			(await calculator(edge.reader).compute(params("success_ratio"), context().ctx))
				.complete,
		).toBe(true);
	});

	it("reads a series that starts after 10% of the window as partial_window", async () => {
		// Defect guarded: a 3-hour-old series read as a 24-hour ratio.
		const partial = fakeReader({
			coverage: one(endSec - HOURS * 3600 + HOURS * 360 + 1),
		});
		const sample = await calculator(partial.reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
		expect(sample.evidenceRefs).toContain("partial_window");
		const edge = fakeReader({
			coverage: one(endSec - HOURS * 3600 + HOURS * 360),
		});
		expect(
			(await calculator(edge.reader).compute(params("success_ratio"), context().ctx))
				.complete,
		).toBe(true);
	});

	it("reads fewer than minRequests as zero_denominator", async () => {
		// Defect guarded: 1 failed of 3 requests reported as a 66% KPI.
		const { reader } = fakeReader({ volume: one(99) });
		const sample = await calculator(reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample).toMatchObject({ complete: false, reason: "zero_denominator" });
		const none = fakeReader({ volume: [] });
		expect(
			(await calculator(none.reader).compute(params("success_ratio"), context().ctx))
				.reason,
		).toBe("zero_denominator");
	});

	it("reads NaN, negative, infinite or over-100 values as invalid", async () => {
		for (const bad of ["NaN", "-1", "+Inf", "100.5"]) {
			const { reader } = fakeReader({ success_ratio: one(bad) });
			const sample = await calculator(reader).compute(
				params("success_ratio"),
				context().ctx,
			);
			expect(sample, bad).toMatchObject({
				complete: false,
				reason: "incomplete_or_invalid_source",
			});
		}
		const nanVolume = fakeReader({ volume: one("NaN") });
		expect(
			(await calculator(nanVolume.reader).compute(params("success_ratio"), context().ctx))
				.reason,
		).toBe("incomplete_or_invalid_source");
	});

	it("reads a vector over 2000 series as incomplete, never a truncated answer", async () => {
		const many = Array.from({ length: PROM_MAX_SERIES + 1 }, (_, i) => ({
			metric: { route: `r${i}` },
			value: [endSec, "1000"] as [number, string],
		}));
		const { reader } = fakeReader({ route_totals: many });
		const sample = await calculator(reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
		expect(sample.evidenceRefs).toContain("series_cap");
	});
});

describe("http.requests@1 worst_route_failure", () => {
	it("keeps meta and internal routes and names the top three with counts", async () => {
		const { reader } = fakeReader({
			route_totals: routes({
				"meta.readyz": 200,
				"a.route": 1000,
				"b.internal": 500,
				"c.route": 300,
				"tiny.route": 5,
			}),
			route_failures: routes({
				"meta.readyz": 100,
				"a.route": 100,
				"b.internal": 25,
				"c.route": 3,
				"tiny.route": 5,
			}),
		});
		const sample = await calculator(reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		// meta.readyz fails 50%; tiny.route (100%) is under minRequests.
		expect(sample).toMatchObject({ value: 50, unit: "%", complete: true });
		const worst = sample.evidenceRefs.filter((e) => e.startsWith("worst:"));
		expect(worst).toEqual([
			"worst:meta.readyz:failed=100;total=200",
			"worst:a.route:failed=100;total=1000",
			"worst:b.internal:failed=25;total=500",
		]);
	});

	it("applies minRequests per route", async () => {
		const { reader } = fakeReader({
			route_totals: routes({ "a.route": 50, "b.route": 60 }),
			route_failures: routes({}),
		});
		const sample = await calculator(reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		expect(sample).toMatchObject({ complete: false, reason: "zero_denominator" });
	});

	it("breaks equal shares by route id ascending, whatever the vector order", async () => {
		// Defect guarded: a tie named whichever route the backend listed first.
		const rows = { "z.route": 200, "a.route": 200, "m.route": 200 };
		const fails = { "z.route": 20, "a.route": 20, "m.route": 20 };
		const forward = fakeReader({
			route_totals: routes(rows),
			route_failures: routes(fails),
		});
		const reversed = fakeReader({
			route_totals: routes(Object.fromEntries(Object.entries(rows).reverse())),
			route_failures: routes(Object.fromEntries(Object.entries(fails).reverse())),
		});
		const a = await calculator(forward.reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		const b = await calculator(reversed.reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		expect(a.evidenceRefs.filter((e) => e.startsWith("worst:"))).toEqual([
			"worst:a.route:failed=20;total=200",
			"worst:m.route:failed=20;total=200",
			"worst:z.route:failed=20;total=200",
		]);
		expect(b.evidenceRefs).toEqual(a.evidenceRefs);
		expect(a.value).toBe(10);
	});

	it("reads a route label outside the selector set as invalid", async () => {
		// Defect guarded: result label text reaching evidence unchecked.
		const { reader } = fakeReader({
			route_totals: routes({ "a route/with space": 500 }),
		});
		const sample = await calculator(reader).compute(
			params("worst_route_failure"),
			context().ctx,
		);
		expect(sample.reason).toBe("incomplete_or_invalid_source");
	});
});

describe("http.requests@1 failures", () => {
	it("reads a reader throw as source_failed without copying its text", async () => {
		// Defect guarded: a backend error message, which may carry a URL or credential, stored as evidence.
		class MimirDown extends Error {}
		const reader: PromInstantReader = {
			async queryInstant() {
				throw new MimirDown("https://user:secret@mimir.example/api/v1/query");
			},
		};
		const sample = await calculator(reader).compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		expect(sample.evidenceRefs).toContain("error:MimirDown");
		expect(JSON.stringify(sample)).not.toMatch(/secret|mimir\.example/);
	});

	it("rethrows an abort so the service records error, not unknown", async () => {
		const controller = new AbortController();
		const reader: PromInstantReader = {
			queryInstant: (p) =>
				new Promise((_, reject) =>
					p.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				),
		};
		const pending = calculator(reader).compute(
			params("success_ratio"),
			context(controller.signal).ctx,
		);
		controller.abort(new Error("source_timeout"));
		await expect(pending).rejects.toThrow("source_timeout");
	});

	it("reads without a reader as source_failed with prometheus:not_configured", async () => {
		const sample = await calculator().compute(
			params("success_ratio"),
			context().ctx,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "source_failed",
		});
		expect(sample.evidenceRefs).toContain("prometheus:not_configured");
	});
});

describe("http.requests@1 ticks and catalog", () => {
	it("shares the freshness and coverage reads between both outputs in one tick", async () => {
		// Defect guarded: two metrics of one node each re-reading the same feed health.
		const { reader, calls } = fakeReader();
		const tick = createTickReads();
		const shared = calculator(reader, { share: tick.shareOnce });
		await tick.run(() =>
			Promise.all([
				shared.compute(params("success_ratio"), context().ctx),
				shared.compute(params("worst_route_failure"), context().ctx),
			]),
		);
		const count = (text: string) => calls.filter((c) => c.query === text).length;
		expect(count(Q.freshness)).toBe(1);
		expect(count(Q.coverage)).toBe(1);
		expect(calls).toHaveLength(6);
		// Outside a tick nothing is shared.
		calls.length = 0;
		await Promise.all([
			shared.compute(params("success_ratio"), context().ctx),
			shared.compute(params("worst_route_failure"), context().ctx),
		]);
		expect(calls).toHaveLength(8);
	});

	it("publishes the same catalog entry with or without a reader", () => {
		const entries = [undefined, fakeReader().reader].map((query) => {
			const service = createGoalMetrics({
				knowledgeSql: fakeSql(() => []).sql,
				observationsSql: noObservations,
				node: "node-1",
				environment: "test-env",
				log: () => undefined,
				...(query ? { prometheus: { query } } : {}),
			});
			return service.registry.describe().find((c) => c.id === HTTP_REQUESTS_ID);
		});
		expect(entries[0]).toBeDefined();
		expect(entries[0]).toEqual(entries[1]);
		expect(entries[0]?.unit).toBe("%");
		expect(entries[0]?.limits).toMatchObject({
			timeoutMs: 15000,
			maxSourceCalls: 3,
			maxRows: PROM_MAX_SERIES,
		});
		expect(PACKAGE_CALCULATOR_IDS).toContain(HTTP_REQUESTS_ID);
		expect(RESERVED_CALCULATOR_FAMILIES.has("http.requests")).toBe(true);
		const calc = createGoalMetrics({
			knowledgeSql: fakeSql(() => []).sql,
			observationsSql: noObservations,
			node: "node-1",
			environment: "test-env",
			log: () => undefined,
		}).registry.get(HTTP_REQUESTS_ID);
		expect(calc.display).toBe("slo");
		expect(calc.windowSeconds?.(params("success_ratio"))).toBe(HOURS * 3600);
	});
});
