// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	bucketObservations,
	createMetricService,
	type MetricDefinition,
	MetricListInputSchema,
	MetricListResponseSchema,
	type MetricObservationsPort,
	MetricRegistry,
	type MetricSample,
	type MetricSnapshot,
	metricHistoryRange,
	selectEvaluation,
} from "../src/index";

function setup(options?: {
	historical?: boolean;
	display?: "volume";
	override?: "progress" | "slo";
}) {
	let time = new Date("2026-10-30T12:00:00Z");
	const windows: Array<{ start: string; end: string }> = [];
	let allowed = true;
	let authorityFailure = false;
	let deniedRevision: string | null = null;
	let reads = 0;
	let sourceFailure = false;
	const d: MetricDefinition = {
		id: "open-work",
		title: "Open work",
		revision: "1",
		spec: {
			calculatorId: "work.count@1",
			params: {},
			cadenceSeconds: 60,
			maxAgeSeconds: 90,
		},
		...(options?.override ? { display: options.override } : {}),
	};
	let sample: MetricSample = {
		value: 0,
		unit: "items",
		complete: true,
		sourceWatermarks: [{ source: "work", asOf: time.toISOString() }],
		evidenceRefs: ["node:work"],
	};
	const snapshots = new Map<string, MetricSnapshot>();
	const receipts = new Map<string, { hash: string; id: string }>();
	let cursor: string | null = null;
	const port: MetricObservationsPort = {
		async request(_metricId, key, hash) {
			const r = receipts.get(key);
			if (!r) return null;
			if (r.hash !== hash) throw new Error("idempotency_conflict");
			return snapshots.get(r.id) ?? null;
		},
		async reserve(input) {
			const old = receipts.get(input.requestKey);
			if (old && old.hash !== input.requestHash)
				throw new Error("idempotency_conflict");
			if (old) {
				const snapshot = snapshots.get(old.id);
				if (!snapshot) throw new Error("missing_fixture");
				return { snapshot, leaseToken: null };
			}
			snapshots.set(
				input.snapshot.observation.id,
				structuredClone(input.snapshot),
			);
			receipts.set(input.requestKey, {
				hash: input.requestHash,
				id: input.snapshot.observation.id,
			});
			return { snapshot: structuredClone(input.snapshot), leaseToken: "lease" };
		},
		async complete(id, _token, r) {
			const snapshot = snapshots.get(id);
			if (!snapshot) throw new Error("missing_fixture");
			snapshot.observation = structuredClone(r);
			return r;
		},
		async history(id, hash) {
			return [...snapshots.values()]
				.map((s) => s.observation)
				.filter((r) => r.metricId === id && r.definitionHash === hash)
				.sort((a, b) => b.window.end.localeCompare(a.window.end));
		},
		async get(id) {
			return snapshots.get(id)?.observation ?? null;
		},
		async lastGood(id, hash) {
			return (
				(await this.history(id, hash, 100)).find((r) => r.status === "ok") ??
				null
			);
		},
		async at(id, hash, at, maxAge) {
			return selectEvaluation(await this.history(id, hash, 100), at, maxAge);
		},
		async buckets(id, hash, range) {
			return bucketObservations(
				await this.history(id, hash, 100),
				metricHistoryRange(range, new Date(Date.parse(range.to))),
			);
		},
		async snapshot(id) {
			return snapshots.get(id) ?? null;
		},
		async scheduledAttempts(id, hash, slot) {
			return (await this.history(id, hash, 100))
				.filter((r) => r.scheduledFor === slot)
				.slice(0, 4);
		},
		async expireLeases() {},
		async cursor() {
			return cursor;
		},
		async advanceCursor(id) {
			cursor = id;
		},
	};
	const registry = new MetricRegistry();
	registry.register({
		id: "work.count@1",
		unit: "items",
		...(options?.display ? { display: options.display } : {}),
		...(options?.historical
			? { historicalWindows: true, windowSeconds: () => 7 * 86400 }
			: {}),
		paramsSchema: z.object({}),
		budget: {
			timeoutMs: 50,
			maxSourceCalls: 1,
			maxRows: 1,
			maxResponseBytes: 1000,
		},
		compute: async (_p, ctx) =>
			ctx.read(async () => {
				reads++;
				windows.push(ctx.window);
				if (sourceFailure) throw new Error("provider_failed");
				return sample;
			}),
	});
	const service = createMetricService({
		definitions: {
			get: async (id) => (id === d.id ? d : null),
			list: async (_limit, after) => ({
				items: !after || d.id > after ? [d] : [],
				nextCursor: null,
			}),
		},
		observations: port,
		registry,
		scope: { node: "one", environment: "local", dataScope: "members" },
		now: () => time,
		authorize: async (_action, definition) => {
			if (authorityFailure) throw new Error("offline");
			return allowed && definition.revision !== deniedRevision;
		},
	});
	return {
		service,
		d,
		snapshots,
		windows,
		denyRevision: (revision: string) => {
			deniedRevision = revision;
		},
		reads: () => reads,
		failSource: (value: boolean) => {
			sourceFailure = value;
		},
		allow: (value: boolean) => {
			allowed = value;
		},
		failAuthority: () => {
			authorityFailure = true;
		},
		sample: (value: Partial<MetricSample>) => {
			sample = { ...sample, ...value };
		},
		advance: (ms: number) => {
			time = new Date(time.getTime() + ms);
		},
	};
}
describe("measurement evidence contract", () => {
	it("keeps genuine zero and values above 100, with stable replay identity", async () => {
		const s = setup();
		const zero = await s.service.compute("open-work", { requestKey: "zero" });
		expect(zero.value).toBe(0);
		expect(zero.status).toBe("ok");
		s.d.revision = "2";
		s.sample({ value: 150 });
		const replay = await s.service.compute("open-work", { requestKey: "zero" });
		expect(replay.id).toBe(zero.id);
		expect(replay.definitionRevision).toBe("1");
		expect(s.reads()).toBe(1);
		s.advance(1);
		expect(
			(await s.service.compute("open-work", { requestKey: "large" })).value,
		).toBe(150);
	});
	it("does not turn partial data or unknown freshness into zero", async () => {
		const s = setup();
		s.sample({ complete: false });
		const r = await s.service.compute("open-work", { requestKey: "partial" });
		expect(r.status).toBe("unavailable");
		expect(r.value).toBeNull();
		s.advance(1);
		s.sample({
			complete: true,
			sourceWatermarks: [{ source: "work", asOf: null }],
		});
		expect(
			(await s.service.compute("open-work", { requestKey: "unknown" })).value,
		).toBeNull();
	});
	it("keeps stale source evidence visible without certifying a target", async () => {
		const s = setup();
		await s.service.compute("open-work", { requestKey: "one" });
		s.advance(91000);
		expect((await s.service.read("open-work")).viewState).toBe("stale");
		expect(
			(
				await s.service.bindings([
					{
						metricId: "open-work",
						comparator: "gte",
						target: { value: 0, unit: "items" },
					},
				])
			)[0]?.met,
		).toBeNull();
	});
	it("checks current authority before every cached/history/binding read", async () => {
		const s = setup();
		await s.service.compute("open-work", { requestKey: "one" });
		s.allow(false);
		await expect(s.service.read("open-work")).rejects.toMatchObject({
			status: 404,
		});
		await expect(s.service.history("open-work")).rejects.toMatchObject({
			status: 404,
		});
		s.failAuthority();
		await expect(s.service.read("open-work")).rejects.toMatchObject({
			status: 503,
		});
	});
	it("preserves latest failure separately from last good", async () => {
		const s = setup();
		const good = await s.service.compute("open-work", { requestKey: "one" });
		s.advance(1);
		s.sample({ complete: false });
		const bad = await s.service.compute("open-work", { requestKey: "two" });
		const view = await s.service.read("open-work");
		expect(view.viewState).toBe("unavailable");
		expect(view.latestAttempt?.id).toBe(bad.id);
		expect(view.lastGood?.id).toBe(good.id);
	});
	it("pins hypothesis evidence while rolling measurements change", async () => {
		const s = setup();
		const baseline = await s.service.compute("open-work", {
			requestKey: "one",
		});
		s.advance(1);
		s.sample({ value: 5 });
		await s.service.compute("open-work", { requestKey: "two" });
		const binding = {
			metricId: "open-work",
			comparator: "eq" as const,
			target: { value: 0, unit: "items" },
			evaluationAt: baseline.window.end,
		};
		// Before evaluationAt + maxAge the fixed evaluation is not final.
		expect((await s.service.bindings([binding]))[0]).toMatchObject({
			met: null,
			reason: "evaluation_not_due",
			assessment: { status: "evaluating" },
		});
		s.advance(91000);
		const [result] = await s.service.bindings([binding]);
		expect(result?.observation?.id).toBe(baseline.id);
		expect(result?.met).toBe(true);
		expect(result?.assessment).toMatchObject({
			status: "met",
			observationId: baseline.id,
		});
	});
	it("recovers the refresh cursor on the next real tick", async () => {
		const s = setup();
		const first = await s.service.refreshDue();
		expect(first.scanned).toBe(1);
		s.advance(60000);
		const second = await s.service.refreshDue();
		expect(second.scanned).toBe(1);
		expect(s.reads()).toBe(2);
	});
});

describe("review regression cases", () => {
	it("keeps calculator discovery on list pages and accepts bounded continuation", async () => {
		const s = setup();
		const input = MetricListInputSchema.parse({ limit: 1, after: "open-work" });
		const page = MetricListResponseSchema.parse(
			await s.service.list(input.limit, input.after),
		);
		expect(page.items).toEqual([]);
		expect(page.catalog[0]).toMatchObject({
			id: "work.count@1",
			unit: "items",
			limits: { maxSourceCalls: 1 },
			paramsSchema: { type: "object" },
		});
		expect(MetricListInputSchema.safeParse({ limit: 51 }).success).toBe(false);
	});

	it("compares baseline and evaluation timestamps as instants across offsets", async () => {
		const s = setup();
		const baseline = await s.service.compute("open-work", {
			requestKey: "timezone-baseline",
		});
		s.advance(120000);
		const binding = {
			metricId: "open-work",
			comparator: "eq" as const,
			target: { value: 0, unit: "items" },
			baselineObservationId: baseline.id,
		};
		const [utc] = await s.service.bindings(
			[{ ...binding, evaluationAt: "2026-10-30T12:00:00Z" }],
			{ hypothesis: true },
		);
		const [offset] = await s.service.bindings(
			[{ ...binding, evaluationAt: "2026-10-30T04:00:00-08:00" }],
			{ hypothesis: true },
		);
		expect(offset).toMatchObject({
			met: true,
			reason: null,
			baseline: { id: baseline.id },
		});
		expect(offset?.observation?.id).toBe(utc?.observation?.id);
	});

	it("rejects backdating a current snapshot", async () => {
		const s = setup();
		await expect(
			s.service.compute("open-work", {
				requestKey: "backdated",
				evaluationAt: "2026-10-29T12:00:00Z",
			}),
		).rejects.toMatchObject({ code: "historical_window_not_supported" });
		expect(s.reads()).toBe(0);
	});
	it("keeps fixed hypothesis evidence after definition edits", async () => {
		const s = setup();
		const first = await s.service.compute("open-work", {
			requestKey: "original",
		});
		const binding = {
			metricId: "open-work",
			comparator: "eq" as const,
			target: { value: 0, unit: "items" },
			evaluationAt: first.window.end,
			baselineObservationId: first.id,
		};
		s.advance(91000);
		s.d.revision = "2";
		s.d.spec = { ...s.d.spec, params: { edited: true } };
		s.sample({ value: 5 });
		await s.service.compute("open-work", { requestKey: "new-definition" });
		const [result] = await s.service.bindings([binding], { hypothesis: true });
		expect(result?.observation?.id).toBe(first.id);
		expect(result?.met).toBe(true);
	});
	it("preserves unknown for missing metrics and unpinned hypotheses", async () => {
		const s = setup();
		const binding = {
			metricId: "missing",
			comparator: "gte" as const,
			target: { value: 0, unit: "items" },
		};
		expect((await s.service.bindings([binding]))[0]).toMatchObject({
			viewState: "unavailable",
			met: null,
		});
		expect(
			(
				await s.service.bindings([{ ...binding, metricId: "open-work" }], {
					hypothesis: true,
				})
			)[0],
		).toMatchObject({
			reason: "fixed_prediction_and_baseline_required",
			met: null,
		});
	});
	it("does not certify source data stale at a fixed evaluation", async () => {
		const s = setup();
		s.sample({
			sourceWatermarks: [{ source: "work", asOf: "2026-10-29T12:00:00Z" }],
		});
		const r = await s.service.compute("open-work", {
			requestKey: "stale-fixed",
		});
		expect(
			(
				await s.service.bindings([
					{
						metricId: "open-work",
						comparator: "gte",
						target: { value: 0, unit: "items" },
						evaluationAt: r.window.end,
					},
				])
			)[0],
		).toMatchObject({ viewState: "stale", met: null });
	});
	it("recovers an hourly metric within the same cadence with a new immutable attempt", async () => {
		const s = setup();
		s.d.spec.cadenceSeconds = 3600;
		s.failSource(true);
		const first = await s.service.refreshDue();
		expect(first.observations[0]?.status).toBe("error");
		s.advance(60000);
		s.failSource(false);
		const second = await s.service.refreshDue();
		expect(second.observations[0]?.status).toBe("ok");
		expect(second.observations[0]?.id).not.toBe(first.observations[0]?.id);
		s.advance(60000);
		await s.service.refreshDue();
		expect(s.reads()).toBe(2);
	});
});
it("replays a completed explicit-time request after the snapshot time passes", async () => {
	const s = setup();
	const input = {
		requestKey: "explicit-replay",
		evaluationAt: "2026-10-30T12:00:00Z",
	};
	const first = await s.service.compute("open-work", input);
	s.advance(86400000);
	const replay = await s.service.compute("open-work", input);
	expect(replay.id).toBe(first.id);
	expect(s.reads()).toBe(1);
});

describe("immutable evidence destinations", () => {
	it("retrieves pinned evidence outside current history after definition edits", async () => {
		const s = setup();
		const original = await s.service.compute("open-work", {
			requestKey: "original",
		});
		s.d.revision = "2";
		// A revision-only edit (title/body) keeps the series.
		expect(await s.service.history("open-work")).toHaveLength(1);
		s.d.spec = { ...s.d.spec, params: { edited: true } };
		expect(await s.service.history("open-work")).toEqual([]);
		const saved = await s.service.observation("open-work", original.id);
		expect(saved.observation.id).toBe(original.id);
		expect(saved.definition.revision).toBe("1");
		s.denyRevision("1");
		await expect(
			s.service.observation("open-work", original.id),
		).rejects.toMatchObject({ status: 404 });
	});
	it("checks current authority and exact metric/scope before serving old evidence", async () => {
		const s = setup();
		const original = await s.service.compute("open-work", {
			requestKey: "original",
		});
		s.allow(false);
		await expect(
			s.service.observation("open-work", original.id),
		).rejects.toMatchObject({ status: 404 });
		s.allow(true);
		const snapshot = s.snapshots.get(original.id);
		if (!snapshot) throw new Error("missing fixture snapshot");
		snapshot.observation.dataScope = "another-audience";
		await expect(
			s.service.observation("open-work", original.id),
		).rejects.toMatchObject({ code: "observation_not_found" });
		snapshot.observation.dataScope = "members";
		snapshot.observation.metricId = "another-metric";
		await expect(
			s.service.observation("open-work", original.id),
		).rejects.toMatchObject({ code: "observation_not_found" });
	});
});

it("returns pending explicit-time replay without treating it as a new historical request", async () => {
	const s = setup();
	const input = {
		requestKey: "pending-explicit",
		evaluationAt: "2026-10-30T12:00:00Z",
	};
	const original = await s.service.compute("open-work", input);
	const saved = s.snapshots.get(original.id);
	if (!saved) throw new Error("missing fixture snapshot");
	saved.observation = {
		...original,
		status: "pending",
		value: null,
		observedAt: null,
	};
	s.advance(5000);
	const replay = await s.service.compute("open-work", input);
	expect(replay.id).toBe(original.id);
	expect(replay.status).toBe("pending");
	expect(s.reads()).toBe(1);
});

describe("scheduled windows, ranged history and assessment", () => {
	it("measures the slot only for historical-window calculators", async () => {
		const snapshot = setup();
		snapshot.d.spec.cadenceSeconds = 3600;
		snapshot.advance(125000);
		await snapshot.service.refreshDue();
		expect(snapshot.windows[0]).toEqual({
			start: "2026-10-30T12:02:05.000Z",
			end: "2026-10-30T12:02:05.000Z",
		});
		const historical = setup({ historical: true });
		historical.d.spec.cadenceSeconds = 3600;
		historical.advance(125000);
		const run = await historical.service.refreshDue();
		expect(run.observations[0]?.status).toBe("ok");
		expect(historical.windows[0]).toEqual({
			start: "2026-10-23T12:00:00.000Z",
			end: "2026-10-30T12:00:00.000Z",
		});
	});
	it("serves aligned ranged history with real gaps and the same authorization as read", async () => {
		const s = setup();
		await s.service.compute("open-work", { requestKey: "a" });
		s.advance(3 * 3600000);
		s.failSource(true);
		await s.service.compute("open-work", { requestKey: "b" });
		s.advance(3600000);
		const h = await s.service.historyRange("open-work", {
			from: "2026-10-30T11:00:00Z",
			to: "2026-10-30T16:00:00Z",
			step: "1h",
		});
		expect(h.buckets.map((b) => b.status)).toEqual([
			"missing",
			"ok",
			"missing",
			"missing",
			"error",
		]);
		expect(h.buckets[1]).toMatchObject({ value: 0 });
		expect(h.buckets[4]?.value).toBeNull();
		await expect(
			s.service.historyRange("open-work", {
				from: "2026-10-30T11:30:00Z",
				to: "2026-10-30T16:00:00Z",
				step: "1h",
			}),
		).rejects.toMatchObject({ code: "misaligned_range", status: 400 });
		await expect(
			s.service.historyRange("open-work", {
				from: "2026-10-30T00:00:00Z",
				to: "2026-10-31T00:00:00Z",
				step: "1d",
			}),
		).rejects.toMatchObject({ code: "invalid_range", status: 400 });
		s.allow(false);
		await expect(
			s.service.historyRange("open-work", {
				from: "2026-10-30T11:00:00Z",
				to: "2026-10-30T12:00:00Z",
				step: "1h",
			}),
		).rejects.toMatchObject({ status: 404 });
	});
	it("returns one assessment whose status ignores the chart range", async () => {
		const s = setup();
		await s.service.compute("open-work", { requestKey: "a" });
		const binding = {
			metricId: "open-work",
			comparator: "lte" as const,
			target: { value: 0, unit: "items" },
		};
		const first = await s.service.kpi(binding, {
			deadline: "2027-01-31T00:00:00Z",
		});
		await s.service.historyRange("open-work", {
			from: "2026-10-30T00:00:00Z",
			to: "2026-10-30T12:00:00Z",
			step: "1h",
		});
		const second = await s.service.kpi(binding, {
			deadline: "2027-01-31T00:00:00Z",
		});
		expect(first.assessment).toEqual(second.assessment);
		expect(first.assessment).toMatchObject({ status: "on_track", value: 0 });
		expect(first.trend?.step).toBe("1d");
		expect(first.trend?.buckets).toHaveLength(30);
		expect(first.trend?.buckets.at(-1)).toMatchObject({
			start: "2026-10-30T00:00:00.000Z",
			status: "ok",
		});
		// A metric refreshed hourly or faster also carries its last day hourly.
		expect(first.recent?.step).toBe("1h");
		expect(first.recent?.buckets).toHaveLength(24);
		expect(first.recent?.buckets.at(-1)).toMatchObject({
			start: "2026-10-30T12:00:00.000Z",
			status: "ok",
		});
		const missing = await s.service.kpi({ ...binding, metricId: "absent" });
		expect(missing.assessment).toMatchObject({
			status: "not_measured",
			reason: "metric_unavailable",
		});
	});
});

describe("goal KPI read model", () => {
	const binding = {
		metricId: "open-work",
		comparator: "gte" as const,
		target: { value: 1, unit: "items" },
	};
	it("carries the calculator's display unless a fitting definition overrides it", async () => {
		const display = async (o: Parameters<typeof setup>[0]) =>
			(await setup(o).service.kpi(binding, {})).metric?.display;
		expect(await display({})).toBeUndefined();
		expect(await display({ display: "volume" })).toBe("volume");
		expect(await display({ display: "volume", override: "progress" })).toBe("progress");
		// slo needs a "%" unit; an override the unit cannot honour yields to the default.
		expect(await display({ display: "volume", override: "slo" })).toBe("volume");
	});
});
