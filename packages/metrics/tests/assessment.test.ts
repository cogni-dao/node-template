// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it, vi } from "vitest";
import { judgeMoves, type MoveReadingPort } from "../../work-items/src/moves";
import { readMetricBatch } from "../src/adapters/read-budget";
import { PostgresMetricObservations } from "../src/adapters/postgres";
import {
	assessKpi,
	assessDirection,
	createWorkMetricReader,
	createMetricService,
	metricDefinitionHash,
	hashMetric,
	MetricRegistry,
	type MetricObservationsPort,
	type MetricView,
	KpiBindingSchema,
	bucketObservations,
	type KpiAssessmentInput,
	type MetricHistory,
	type MetricObservation,
	metricHistoryRange,
	selectEvaluation,
} from "../src/index";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;
function reading(
	value: number | null,
	end: string,
	status: MetricObservation["status"] = "ok",
	observedAt: string = end,
): MetricObservation {
	return {
		id: `00000000-0000-4000-8000-${String(Date.parse(end) % 1e12).padStart(12, "0")}`,
		metricId: "ratio",
		definitionRevision: "1",
		definitionHash: "h",
		calculatorVersion: "work.convergence@1",
		paramsHash: "p",
		node: "n",
		environment: "e",
		dataScope: "d",
		window: { start: end, end },
		sourceWatermarks: [{ source: "s", asOf: end }],
		observedAt,
		status,
		value,
		unit: "ratio",
		reason: status === "ok" ? null : "zero_denominator",
		evidenceRefs: [],
	};
}
const fresh = reading(1.2, "2026-11-02T11:00:00.000Z");

describe("work page database batch", () => {
	it.each([
		["fresh historical evidence", "fresh", "met", null],
		[
			"stale baseline source",
			"baseline-source",
			"not_measured",
			"baseline_unavailable_or_incompatible",
		],
		[
			"stale baseline window",
			"baseline-window-age",
			"not_measured",
			"baseline_unavailable_or_incompatible",
		],
		[
			"stale due source",
			"due-source",
			"unresolved",
			"no_reading_at_evaluation",
		],
		[
			"source stale at evaluation",
			"due-source-at-evaluation",
			"unresolved",
			"no_reading_at_evaluation",
		],
		[
			"incompatible due window",
			"due-window",
			"unresolved",
			"no_reading_at_evaluation",
		],
		[
			"incompatible baseline window",
			"baseline-window",
			"not_measured",
			"baseline_unavailable_or_incompatible",
		],
		[
			"incompatible due parameters",
			"due-params",
			"unresolved",
			"no_reading_at_evaluation",
		],
	] as const)(
		"validates %s at evidence time",
		async (_name, change, status, reason) => {
			const definition = {
				id: "ratio",
				title: "Ratio",
				revision: "1",
				spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
			};
			const observation = (value: number, end: string): MetricObservation => ({
				...reading(value, end),
				definitionHash: metricDefinitionHash(definition),
				calculatorVersion: "work.count@1",
				paramsHash: hashMetric({}),
				window: {
					start: new Date(Date.parse(end) - 3600000).toISOString(),
					end,
				},
			});
			const baseline = observation(1, "2026-10-01T12:00:00.000Z");
			const due = observation(2, "2026-10-02T12:00:00.000Z");
			if (change === "baseline-source" || change === "due-source") {
				const row = change === "baseline-source" ? baseline : due;
				row.sourceWatermarks = [
					{
						source: "s",
						asOf: new Date(
							Date.parse(row.window.end) - 12 * 3600000,
						).toISOString(),
					},
				];
			}
			if (change === "baseline-window-age") {
				baseline.observedAt = "2026-10-01T20:00:00.000Z";
				baseline.sourceWatermarks = [
					{ source: "s", asOf: baseline.observedAt },
				];
			}
			if (change === "due-source-at-evaluation") {
				due.window = {
					start: "2026-10-02T10:00:00.000Z",
					end: "2026-10-02T11:00:00.000Z",
				};
				due.observedAt = due.window.end;
				due.sourceWatermarks = [
					{ source: "s", asOf: "2026-10-02T09:30:00.000Z" },
				];
			}
			if (change === "due-window")
				due.window.start = "2026-10-02T10:00:00.000Z";
			if (change === "baseline-window")
				baseline.window.start = "2026-10-01T10:00:00.000Z";
			if (change === "due-params") due.paramsHash = "other";
			const registry = new MetricRegistry();
			registry.register({
				id: "work.count@1",
				unit: "ratio",
				windowSeconds: () => 3600,
				paramsSchema: { parse: (x: unknown) => x } as never,
				budget: {
					timeoutMs: 1,
					maxSourceCalls: 1,
					maxRows: 1,
					maxResponseBytes: 1,
				},
				compute: async () => {
					throw new Error("unused");
				},
			});
			const service = createMetricService({
				definitions: {
					get: async () => definition,
					getMany: async () => [definition],
					list: async () => ({ items: [], nextCursor: null }),
				},
				observations: {
					snapshot: async () => ({ definition, observation: baseline }),
					history: async () => [due],
					lastGood: async () => due,
					at: async () => due,
					predictionReadBatch: async () => [
						{
							baseline: { definition, observation: baseline },
							latest: due,
							lastGood: due,
							evaluation: due,
						},
					],
				} as unknown as MetricObservationsPort,
				registry,
				scope: { node: "n", environment: "e", dataScope: "d" },
				now: () => NOW,
				authorize: async () => true,
			});
			const [result] = await service.predictionBatch([
				{
					metricId: "ratio",
					comparator: "gte",
					target: { value: 2, unit: "ratio" },
					baselineObservationId: baseline.id,
					evaluationAt: "2026-10-02T12:00:00.000Z",
				},
			]);
			const binding = {
				metricId: "ratio",
				comparator: "gte" as const,
				target: { value: 2, unit: "ratio" },
				baselineObservationId: baseline.id,
				evaluationAt: "2026-10-02T12:00:00.000Z",
			};
			const kpi = await service.kpi(binding, {
				hypothesis: true,
				latestOnly: true,
			});
			const [legacy] = await service.bindings([binding], { hypothesis: true });
			expect(kpi.assessment).toEqual(result?.assessment);
			expect(legacy?.assessment).toEqual(result?.assessment);

			expect(result?.assessment).toMatchObject({
				status,
				reason,
				observationId: change === "fresh" ? due.id : null,
			});
		},
	);
	it("retains the pinned definition when the current definition changes", async () => {
		const old = {
			id: "ratio",
			title: "Ratio",
			revision: "old",
			spec: {
				calculatorId: "work.count@1",
				params: { version: 1 },
				maxAgeSeconds: 7200,
			},
		};
		const current = {
			...old,
			revision: "new",
			spec: { ...old.spec, params: { version: 2 } },
		};
		const baseline = {
			...fresh,
			definitionHash: metricDefinitionHash(old),
			calculatorVersion: old.spec.calculatorId,
			paramsHash: hashMetric(old.spec.params),
			value: 1,
		};
		const due = {
			...baseline,
			id: "00000000-0000-4000-8000-000000000002",
			value: 2,
		};
		const batch = vi.fn(async () => [
			{
				baseline: { definition: old, observation: baseline },
				latest: due,
				lastGood: due,
				evaluation: due,
			},
		]);
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: { parse: (x: unknown) => x } as never,
			budget: {
				timeoutMs: 1,
				maxSourceCalls: 1,
				maxRows: 1,
				maxResponseBytes: 1,
			},
			compute: async () => {
				throw new Error("unused");
			},
		});
		const service = createMetricService({
			definitions: {
				get: async () => current,
				getMany: async () => [current],
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				predictionReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry,
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => new Date(NOW.getTime() + 3 * 3600000),
			authorize: async () => true,
		});
		const [result] = await service.predictionBatch([
			{
				metricId: "ratio",
				comparator: "gte",
				target: { value: 2, unit: "ratio" },
				baselineObservationId: baseline.id,
				evaluationAt: NOW.toISOString(),
			},
		]);
		expect(result?.assessment).toMatchObject({
			status: "met",
			observationId: due.id,
		});
	});
	it("assesses due commitments through one observation batch and preserves due evidence", async () => {
		const definition = {
			id: "ratio",
			title: "Ratio",
			revision: "1",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		};
		const baseline = {
			...fresh,
			definitionHash: metricDefinitionHash(definition),
			calculatorVersion: definition.spec.calculatorId,
			paramsHash: hashMetric(definition.spec.params),
			value: 1,
		};
		const due = {
			...baseline,
			id: "00000000-0000-4000-8000-000000000002",
			value: 2,
		};
		const batch = vi.fn(async () => [
			{
				baseline: { definition, observation: baseline },
				latest: due,
				lastGood: due,
				evaluation: due,
			},
		]);
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: { parse: (x: unknown) => x } as never,
			budget: {
				timeoutMs: 1,
				maxSourceCalls: 1,
				maxRows: 1,
				maxResponseBytes: 1,
			},
			compute: async () => {
				throw new Error("unused");
			},
		});
		const service = createMetricService({
			definitions: {
				get: async () => definition,
				getMany: async () => [definition],
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				predictionReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry,
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => new Date(NOW.getTime() + 3 * 3600000),
			authorize: async () => true,
		});
		const result = await service.predictionBatch([
			{
				metricId: "ratio",
				comparator: "gte",
				target: { value: 2, unit: "ratio" },
				baselineObservationId: baseline.id,
				evaluationAt: NOW.toISOString(),
			},
		]);
		expect(batch).toHaveBeenCalledOnce();
		expect(result[0]?.assessment).toMatchObject({
			status: "met",
			observationId: due.id,
			value: 2,
		});
	});
	it("does not expose a due observation when its historical definition is denied", async () => {
		const definition = {
			id: "ratio",
			title: "Ratio",
			revision: "new",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		};
		const old = { ...definition, revision: "old" };
		const baseline = { ...fresh, definitionHash: metricDefinitionHash(old) };
		const batch = vi.fn(async () => [
			{
				baseline: { definition: old, observation: baseline },
				latest: baseline,
				lastGood: baseline,
				evaluation: baseline,
			},
		]);
		const service = createMetricService({
			definitions: {
				get: async () => definition,
				getMany: async () => [definition],
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				predictionReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry: new MetricRegistry(),
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => NOW,
			authorize: async (_action, d) => d.revision !== "old",
		});
		const [result] = await service.predictionBatch([
			{
				metricId: "ratio",
				comparator: "gte",
				target: { value: 1, unit: "ratio" },
				baselineObservationId: baseline.id,
				evaluationAt: NOW.toISOString(),
			},
		]);
		expect(result?.assessment).toMatchObject({
			status: "not_measured",
			reason: "metric_unavailable",
			observationId: null,
			value: null,
		});
		expect(batch).toHaveBeenCalledOnce();
	});
	it("never requests observations for a denied metric", async () => {
		const definition = {
			id: "ratio",
			title: "Ratio",
			revision: "1",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		};
		const getMany = vi.fn(async () => [definition]);
		const batch = vi.fn(async () => []);
		const service = createMetricService({
			definitions: {
				get: async () => definition,
				getMany,
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				workReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry: new MetricRegistry(),
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => NOW,
			authorize: async () => false,
		});
		const result = await service.workReadBatch([
			{ metricId: "ratio", baselineObservationId: fresh.id },
		]);
		expect(batch).toHaveBeenCalledWith([], undefined);
		expect(result[0]).toMatchObject({
			baseline: null,
			current: null,
			unknownReason: "metrics_unavailable",
		});
	});
	it("distinguishes absent definitions from denied observations without reading either", async () => {
		const definition = {
			id: "denied",
			title: "Protected",
			revision: "1",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		};
		const batch = vi.fn(async () => []);
		const service = createMetricService({
			definitions: {
				get: async () => null,
				getMany: async () => [definition],
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				workReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry: new MetricRegistry(),
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => NOW,
			authorize: async () => false,
		});
		const results = await service.workReadBatch([
			{ metricId: "missing", baselineObservationId: fresh.id },
			{ metricId: "denied", baselineObservationId: fresh.id },
		]);
		expect(results).toEqual([
			{ baseline: null, current: null, unknownReason: "metric_deprecated" },
			{ baseline: null, current: null, unknownReason: "metrics_unavailable" },
		]);
		expect(batch).toHaveBeenCalledExactlyOnceWith([], undefined);
	});
	it("issues one scoped ordered SQL statement for multiple snapshots", async () => {
		const sql = Object.assign(
			vi.fn(async () => [{}, {}]),
			{
				unsafe: vi.fn(async () => []),
				begin: async (fn: (tx: unknown) => unknown): Promise<unknown> =>
					fn(sql),
			},
		);
		const store = new PostgresMetricObservations(sql as never, {
			node: "n",
			environment: "e",
			dataScope: "d",
		});
		const rows = await store.workReadBatch([
			{ metricId: "a", definitionHash: "one", baselineObservationId: null },
			{ metricId: "b", definitionHash: "two", baselineObservationId: null },
		]);
		expect(rows).toHaveLength(2);
		expect(sql).toHaveBeenCalledOnce();
		const call = sql.mock.calls[0] as unknown as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(call[0].join("?")).toContain("ORDER BY r.ord");
		expect(call.slice(1)).toContain("n/e/d");
	});
	it("reads multiple pinned due observations in one scoped statement", async () => {
		const sql = Object.assign(
			vi.fn(async () => [{}, {}]),
			{
				unsafe: vi.fn(async () => []),
				begin: async (fn: (tx: unknown) => unknown): Promise<unknown> =>
					fn(sql),
			},
		);
		const store = new PostgresMetricObservations(sql as never, {
			node: "n",
			environment: "e",
			dataScope: "d",
		});
		const rows = await store.predictionReadBatch([
			{
				metricId: "a",
				baselineObservationId: fresh.id,
				evaluationAt: NOW.toISOString(),
			},
			{
				metricId: "b",
				baselineObservationId: fresh.id,
				evaluationAt: NOW.toISOString(),
			},
		]);
		expect(rows).toHaveLength(2);
		expect(sql).toHaveBeenCalledOnce();
		const call = sql.mock.calls[0] as unknown as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(call[0].join("?")).toContain("evaluation_at <= r.due::timestamptz");
		expect(call.slice(1)).toContain("n/e/d");
	});
	it("reads one batch and reauthorizes historical snapshots", async () => {
		const definition = {
			id: "ratio",
			title: "Ratio",
			revision: "1",
			spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		};
		const baseline = {
			...fresh,
			definitionHash: metricDefinitionHash(definition),
		};
		const failed = {
			...baseline,
			id: "00000000-0000-4000-8000-000000000002",
			status: "error" as const,
			value: null,
		};
		const historical = { ...definition, revision: "old" };
		const getMany = vi.fn(async () => [definition]);
		const batch = vi.fn(async () => [
			{
				baseline: { definition: historical, observation: baseline },
				latest: failed,
			},
		]);
		const authorize = vi.fn(
			async (_: unknown, d: typeof definition) => d.revision !== "old",
		);
		const service = createMetricService({
			definitions: {
				get: async () => definition,
				getMany,
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				workReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry: new MetricRegistry(),
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => NOW,
			authorize,
		});
		const result = await service.workReadBatch([
			{ metricId: "ratio", baselineObservationId: baseline.id },
		]);
		expect(getMany).toHaveBeenCalledOnce();
		expect(batch).toHaveBeenCalledOnce();
		expect(result[0]).toMatchObject({
			baseline: null,
			current: { id: failed.id, status: "error" },
		});
		expect(authorize).toHaveBeenCalledTimes(2);
	});
});

describe("directional assessment", () => {
	const current = {
		...fresh,
		id: "00000000-0000-4000-8000-000000000002",
		value: 2,
	};
	it("compares compatible evidence without inventing a claim", () => {
		expect(assessDirection("up", fresh, current)).toBe("as_declared");
		expect(assessDirection("down", fresh, current)).toBe("against");
		expect(assessDirection("up", fresh, fresh)).toBe("flat");
		expect(assessDirection(null, fresh, current)).toBeNull();
	});
	it("rejects incompatible or failed observations", () => {
		for (const change of [
			{ unit: "count" },
			{ definitionHash: "different" },
			{ paramsHash: "different" },
			{ dataScope: "other" },
			{ status: "error" as const },
			{ status: "pending" as const },
			{ viewState: "stale" as const },
			{ sourceWatermarks: [] },
			{ window: { start: "2026-11-01T00:00:00Z", end: current.window.end } },
			{ value: null },
		])
			expect(assessDirection("up", fresh, { ...current, ...change })).toBe(
				"unknown",
			);
	});
});

describe("work observation projection", () => {
	const view = (
		attempt: MetricObservation,
		viewState: MetricView["viewState"] = "ok",
	): MetricView => ({
		definition: {
			id: "ratio",
			title: "Ratio",
			revision: "1",
			spec: { calculatorId: "work.test@1", params: {}, maxAgeSeconds: 7200 },
		},
		latestAttempt: attempt,
		lastGood: fresh,
		viewState,
	});
	it("pins only a fresh latest attempt and preserves its immutable identity", async () => {
		const service = {
			read: async () => view(fresh),
			observation: async (_id: string, id: string) => ({
				observation: { ...fresh, id },
			}),
		};
		const reader = createWorkMetricReader(service, () => NOW);
		expect(await reader.baselineId("ratio")).toBe(fresh.id);
		expect(await reader.observation("ratio", fresh.id)).toEqual(fresh);
		expect(await reader.latest("ratio")).toMatchObject({
			id: fresh.id,
			unit: "ratio",
			definitionHash: "h",
			viewState: "ok",
		});
	});
	it("preserves a newer failure and refuses stale evidence as a baseline", async () => {
		const failed = {
			...fresh,
			id: "00000000-0000-4000-8000-000000000002",
			status: "error" as const,
			value: null,
			reason: "source_failed",
		};
		const service = {
			read: async () => view(failed, "error"),
			observation: async () => ({ observation: fresh }),
		};
		const reader = createWorkMetricReader(service, () => NOW);
		expect(await reader.baselineId("ratio")).toBeNull();
		expect(await reader.latest("ratio")).toMatchObject({
			id: failed.id,
			status: "error",
			reason: "source_failed",
		});
		const stale = createWorkMetricReader(
			{ ...service, read: async () => view(fresh) },
			() => new Date(NOW.getTime() + DAY),
		);
		expect(await stale.baselineId("ratio")).toBeNull();
		expect(await stale.latest("ratio")).toMatchObject({ viewState: "stale" });
	});
	it("does not bypass denied reads for current or pinned observations", async () => {
		const denied = new Error("denied");
		const reader = createWorkMetricReader({
			read: async () => {
				throw denied;
			},
			observation: async () => {
				throw denied;
			},
		});
		await expect(reader.latest("ratio")).rejects.toBe(denied);
		await expect(reader.baselineId("ratio")).rejects.toBe(denied);
		await expect(reader.observation("ratio", fresh.id)).rejects.toBe(denied);
	});
	it("projects the same pinned and latest IDs through the work-items seam", async () => {
		const current = {
			...fresh,
			id: "00000000-0000-4000-8000-000000000002",
			value: 2,
		};
		const reader = createWorkMetricReader(
			{
				read: async () => view(current),
				observation: async () => ({ observation: fresh }),
			},
			() => NOW,
		);
		const port: MoveReadingPort = {
			observation: async (id, observationId) =>
				reader.observation(id, observationId),
			latest: async (id) => reader.latest(id),
			assess: (direction, baseline, latest) =>
				assessDirection(
					direction,
					baseline as MetricObservation,
					latest as MetricObservation,
				),
		};
		const [result] = await judgeMoves(
			[{ metricId: "ratio", direction: "up", baselineObservationId: fresh.id }],
			port,
		);
		expect(result).toMatchObject({
			baselineObservationId: fresh.id,
			baseline: { id: fresh.id, unit: "ratio", definitionHash: "h" },
			current: { id: current.id, value: 2 },
			moved: "as_declared",
		});
	});
});
function input(over: Partial<KpiAssessmentInput> = {}): KpiAssessmentInput {
	return {
		binding: {
			metricId: "ratio",
			comparator: "gte",
			target: { value: 1, unit: "ratio" },
		},
		metric: { unit: "ratio", maxAgeSeconds: 7200 },
		latestAttempt: fresh,
		lastGood: fresh,
		viewState: "ok",
		deadline: "2027-01-31T00:00:00Z",
		evaluation: null,
		daily: [],
		now: NOW,
		...over,
	};
}

describe("assessKpi first-match rules", () => {
	it("covers all ten statuses with enum reasons", () => {
		const cases: Array<[Partial<KpiAssessmentInput>, string, string | null]> = [
			[
				{ metric: null, unavailable: "calculator_unavailable" },
				"not_measured",
				"calculator_unavailable",
			],
			[
				{ deadline: "2026-11-02T11:00:00Z", evaluation: fresh },
				"evaluating",
				"evaluation_not_due",
			],
			[{ deadline: "2026-11-02T09:00:00Z", evaluation: fresh }, "met", null],
			[
				{
					deadline: "2026-11-02T09:00:00Z",
					evaluation: reading(0.5, "2026-11-02T08:00:00.000Z"),
				},
				"missed",
				null,
			],
			[
				{ deadline: "2026-11-02T09:00:00Z", evaluation: null },
				"unresolved",
				"no_reading_at_evaluation",
			],
			[
				{
					latestAttempt: {
						...reading(null, "2026-11-02T11:30:00.000Z", "unavailable"),
						reason: "insufficient_history",
					},
				},
				"building",
				"insufficient_history",
			],
			[
				{
					latestAttempt: reading(
						null,
						"2026-11-02T11:30:00.000Z",
						"unavailable",
					),
				},
				"failing",
				"zero_denominator",
			],
			[
				{
					latestAttempt: reading(2, "2026-11-02T08:00:00.000Z"),
					lastGood: reading(2, "2026-11-02T08:00:00.000Z"),
				},
				"delayed",
				null,
			],
			[{}, "on_track", null],
			[
				{
					latestAttempt: reading(0.4, "2026-11-02T11:00:00.000Z"),
					lastGood: reading(0.4, "2026-11-02T11:00:00.000Z"),
				},
				"behind",
				null,
			],
		];
		const seen = new Set<string>();
		for (const [over, status, reason] of cases) {
			const a = assessKpi(input(over));
			expect([a.status, a.reason]).toEqual([status, reason]);
			seen.add(a.status);
		}
		expect(seen.size).toBe(10);
	});
	it("breach: failing turns a pre-deadline miss into failing/target_breached", () => {
		const missed = reading(0.4, "2026-11-02T11:00:00.000Z");
		const breaching = {
			latestAttempt: missed,
			lastGood: missed,
			binding: {
				metricId: "ratio",
				comparator: "gte" as const,
				target: { value: 1, unit: "ratio" },
				breach: "failing" as const,
			},
		};
		const a = assessKpi(input(breaching));
		expect([a.status, a.reason, a.value]).toEqual([
			"failing",
			"target_breached",
			0.4,
		]);
		// A met reading stays on_track; a stale one stays delayed; an error keeps its own reason.
		expect(assessKpi(input({ binding: breaching.binding })).status).toBe(
			"on_track",
		);
		const old = reading(0.4, "2026-11-02T08:00:00.000Z");
		expect(
			assessKpi(input({ ...breaching, latestAttempt: old, lastGood: old }))
				.status,
		).toBe("delayed");
		const err = reading(null, "2026-11-02T11:30:00.000Z", "unavailable");
		expect(assessKpi(input({ ...breaching, latestAttempt: err })).reason).toBe(
			"zero_denominator",
		);
		// After the deadline the evaluation verdict is unchanged: missed, not failing.
		const final = assessKpi(
			input({
				...breaching,
				deadline: "2026-11-02T09:00:00Z",
				evaluation: reading(0.4, "2026-11-02T08:00:00.000Z"),
			}),
		);
		expect([final.status, final.reason]).toEqual(["missed", null]);
	});
	it("without breach a pre-deadline miss is behind, byte-identical to before", () => {
		const missed = reading(0.4, "2026-11-02T11:00:00.000Z");
		const a = assessKpi(input({ latestAttempt: missed, lastGood: missed }));
		expect([a.status, a.reason]).toEqual(["behind", null]);
		expect(
			KpiBindingSchema.safeParse({
				metricId: "ratio",
				comparator: "gte",
				target: { value: 1, unit: "ratio" },
				breach: "failing",
			}).success,
		).toBe(true);
		expect(
			KpiBindingSchema.safeParse({
				metricId: "ratio",
				comparator: "gte",
				target: { value: 1, unit: "ratio" },
				breach: "behind",
			}).success,
		).toBe(false);
	});
	it("does not treat a young series as building: a historical window is complete at its first reading", () => {
		expect(assessKpi(input()).status).toBe("on_track");
	});
	it("builds, not fails, while source history is younger than the window", () => {
		const young = {
			...reading(null, "2026-11-02T11:30:00.000Z", "unavailable"),
			reason: "insufficient_history",
		};
		expect(
			assessKpi(input({ latestAttempt: young, lastGood: null })),
		).toMatchObject({
			status: "building",
			reason: "insufficient_history",
			value: null,
			observationId: null,
		});
		const broken = { ...young, reason: "history_unavailable" };
		expect(
			assessKpi(input({ latestAttempt: broken, lastGood: null })),
		).toMatchObject({
			status: "failing",
			reason: "history_unavailable",
			value: null,
		});
	});
	it("keeps the last good value visible while failing and never reports zero for unknown", () => {
		const a = assessKpi(
			input({
				latestAttempt: reading(null, "2026-11-02T11:30:00.000Z", "error"),
			}),
		);
		expect(a).toMatchObject({
			status: "failing",
			value: 1.2,
			observationId: fresh.id,
		});
		const none = assessKpi(input({ latestAttempt: null, lastGood: null }));
		expect(none).toMatchObject({
			status: "delayed",
			value: null,
			reason: "metric_unavailable",
		});
		expect(assessKpi(input({ metric: null })).reason).toBe("no_binding");
	});
	it("refuses a unit mismatch instead of comparing", () => {
		expect(
			assessKpi(
				input({
					metric: { unit: "items", maxAgeSeconds: 60 },
				}),
			),
		).toMatchObject({ status: "not_measured", reason: "unit_mismatch" });
	});
	it("derives pace for display only; status never depends on the chart range", () => {
		const daily: MetricHistory["buckets"] = Array.from(
			{ length: 28 },
			(_, i) => {
				const start = Date.parse("2026-10-06T00:00:00Z") + i * DAY;
				return {
					start: new Date(start).toISOString(),
					end: new Date(start + DAY).toISOString(),
					status: i % 3 === 0 ? ("missing" as const) : ("ok" as const),
					value: i % 3 === 0 ? null : 0.5 + i * 0.01,
					observationId: null,
				};
			},
		);
		const withPace = assessKpi(input({ daily }));
		const without = assessKpi(input({ daily: [] }));
		const short = assessKpi(input({ daily: daily.slice(-5) }));
		expect(withPace.status).toBe(without.status);
		expect(short.status).toBe(without.status);
		expect(withPace.pace.observed).toBeCloseTo(0.07, 6);
		expect(without.pace.observed).toBeNull();
		expect(short.pace.observed).toBeNull();
		expect(withPace.pace.needed).toBeLessThan(0);
		expect(
			assessKpi(input({ deadline: "2026-11-02T09:00:00Z", evaluation: fresh }))
				.pace.needed,
		).toBeNull();
	});
});

describe("fixed evaluation selection", () => {
	it("looks only backward and becomes final", () => {
		const at = "2026-11-02T00:00:00.000Z";
		const before = reading(1, "2026-11-01T23:30:00.000Z");
		const later = reading(9, "2026-11-02T00:30:00.000Z");
		const tooOld = reading(3, "2026-11-01T22:00:00.000Z");
		const lateWrite = reading(
			4,
			"2026-11-01T23:50:00.000Z",
			"ok",
			"2026-11-02T02:00:00.000Z",
		);
		const failed = reading(null, "2026-11-01T23:55:00.000Z", "error");
		expect(
			selectEvaluation([later, before, tooOld, lateWrite, failed], at, 3600)
				?.id,
		).toBe(before.id);
		expect(selectEvaluation([later, tooOld], at, 3600)).toBeNull();
	});
});

describe("ranged history bucketing", () => {
	it("validates alignment, size and future ranges", () => {
		const now = new Date("2026-11-02T12:00:00Z");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-11-01T00:30:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1h",
				},
				now,
			),
		).toThrow("misaligned_range");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-10-28T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1w",
				},
				now,
			),
		).toThrow("misaligned_range");
		expect(
			metricHistoryRange(
				{
					from: "2026-10-19T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1w",
				},
				now,
			).starts,
		).toHaveLength(2);
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-01-01T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1h",
				},
				now,
			),
		).toThrow("too_many_buckets");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-11-02T00:00:00Z",
					to: "2026-11-03T00:00:00Z",
					step: "1d",
				},
				now,
			),
		).toThrow("invalid_range");
		expect(
			metricHistoryRange(
				{
					from: "2026-11-02T00:00:00Z",
					to: "2026-11-03T00:00:00Z",
					step: "1d",
				},
				now,
				{ allowOpenBucket: true },
			).starts,
		).toHaveLength(1);
	});
	it("keeps the last ok reading, half-open edges and real gaps", () => {
		const range = metricHistoryRange(
			{ from: "2026-11-01T00:00:00Z", to: "2026-11-01T04:00:00Z", step: "1h" },
			NOW,
		);
		const rows = [
			reading(1, "2026-11-01T00:10:00.000Z"),
			reading(2, "2026-11-01T00:50:00.000Z"),
			reading(null, "2026-11-01T00:55:00.000Z", "error"),
			reading(null, "2026-11-01T02:00:00.000Z", "unavailable"),
			reading(7, "2026-11-01T04:00:00.000Z"),
		];
		const buckets = bucketObservations(rows, range);
		expect(buckets.map((b) => [b.status, b.value])).toEqual([
			["ok", 2],
			["missing", null],
			["unavailable", null],
			["missing", null],
		]);
		expect(buckets[0]).toMatchObject({
			start: "2026-11-01T00:00:00.000Z",
			end: "2026-11-01T01:00:00.000Z",
		});
	});
});

describe("metric batch cancellation admission", () => {
	it("cancels native reads and retains bounded capacity until settlement", async () => {
		const set = vi.fn(async () => []);
		const pool = {
			begin: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ unsafe: set })),
		};
		const controllers = Array.from({ length: 4 }, () => new AbortController());
		const finishes: (() => void)[] = [];
		const cancel = vi.fn();
		const reads = controllers.map((controller) =>
			readMetricBatch(pool as never, controller.signal, () =>
				Object.assign(
					new Promise<number>((resolve) => finishes.push(() => resolve(1))),
					{ cancel },
				),
			).catch((error) => error),
		);
		await vi.waitFor(() => expect(finishes).toHaveLength(4));
		controllers.forEach((controller) => controller.abort());
		const errors = await Promise.all(reads);
		expect(errors.every((error) => error.code === "batch_unavailable")).toBe(
			true,
		);
		expect(cancel).toHaveBeenCalledTimes(4);
		await expect(
			readMetricBatch(pool as never, undefined, () => Promise.resolve(2)),
		).rejects.toMatchObject({ code: "batch_unavailable" });
		expect(pool.begin).toHaveBeenCalledTimes(4);
		expect(set).toHaveBeenCalledWith("SET LOCAL statement_timeout=2000");
		finishes.forEach((finish) => finish());
		await vi.waitFor(async () =>
			expect(
				await readMetricBatch(pool as never, undefined, () =>
					Promise.resolve(2),
				),
			).toBe(2),
		);
	});
});
