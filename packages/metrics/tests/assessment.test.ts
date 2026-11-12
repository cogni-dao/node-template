// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DoltgresKnowledgeStoreAdapter } from "../../knowledge-store/src/adapters/doltgres/index";
import {
	judgeMoves,
	type MoveReadingPort,
	pinMoves,
} from "../../work-items/src/moves";
import { PostgresMetricObservations } from "../src/adapters/postgres";
import { readMetricBatch, readMetricBudget } from "../src/adapters/read-budget";
import { createMetricHttpHandlers } from "../src/http";
import {
	assessDirection,
	assessKpi,
	bucketObservations,
	createMetricService,
	createWorkMetricReader,
	hashMetric,
	type KpiAssessmentInput,
	KpiBindingSchema,
	type MetricHistory,
	type MetricObservation,
	type MetricObservationsPort,
	MetricRegistry,
	type MetricView,
	metricDefinitionHash,
	metricHistoryRange,
	selectEvaluation,
	selectMetricView,
} from "../src/index";
import { createGoalProgressReader, createGoalSource } from "../src/knowledge";
import { readGoalsProgress } from "../src/progress";

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

it("rejects malformed persisted observation times across direct readers", async () => {
	let observation = { ...fresh, observedAt: "not-a-date" };
	const sql = vi.fn(async () => [{ observation, snapshot: {} }]);
	const store = new PostgresMetricObservations(sql as never, {
		node: "n",
		environment: "e",
		dataScope: "d",
	});
	const reads = () => [
		store.history("ratio", "h", 1),
		store.lastGood("ratio", "h"),
		store.get(fresh.id),
		store.at("ratio", "h", NOW.toISOString(), 7200, {
			calculatorVersion: "work.convergence@1",
			paramsHash: "p",
			unit: "ratio",
			windowSeconds: 0,
			baselineEnd: null,
		}),
		store.snapshot(fresh.id),
		store.scheduledAttempts("ratio", "h", fresh.window.end),
	];
	for (const result of await Promise.allSettled(reads()))
		expect(result.status).toBe("rejected");
	observation = fresh;
	for (const result of await Promise.allSettled(reads()))
		expect(result.status).toBe("fulfilled");
});

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
		expect(batch).toHaveBeenCalledTimes(2);
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
		expect(batch).toHaveBeenCalledTimes(2);
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
		const calls = sql.mock.calls.filter((call) =>
			String((call[0] as unknown as TemplateStringsArray)[0]).startsWith(
				"WITH requested",
			),
		);
		expect(calls).toHaveLength(1);
		const call = calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
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
			calculatorVersion: definition.spec.calculatorId,
			paramsHash: hashMetric(definition.spec.params),
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
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: z.object({}),
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
				getMany,
				list: async () => ({ items: [], nextCursor: null }),
			},
			observations: {
				workReadBatch: batch,
			} as unknown as MetricObservationsPort,
			registry,
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
	it("keeps stale or future baseline windows unknown at their observation time", () => {
		const observed = "2026-11-02T11:00:00.000Z";
		const baseline = {
			...fresh,
			window: {
				start: "2026-11-02T03:00:00.000Z",
				end: "2026-11-02T03:00:00.000Z",
			},
			observedAt: observed,
			sourceWatermarks: [{ source: "s", asOf: observed }],
		};
		const later = {
			...current,
			window: {
				start: "2026-11-02T11:00:00.000Z",
				end: "2026-11-02T11:00:00.000Z",
			},
			maxAgeSeconds: 3600,
		};
		expect(assessDirection("up", baseline, later)).toBe("unknown");
		const future = {
			...baseline,
			window: {
				start: "2026-11-02T11:30:00.000Z",
				end: "2026-11-02T11:30:00.000Z",
			},
		};
		expect(
			assessDirection("up", future, { ...later, window: future.window }),
		).toBe("unknown");
		const boundary = {
			...baseline,
			window: {
				start: "2026-11-02T10:00:00.000Z",
				end: "2026-11-02T10:00:00.000Z",
			},
		};
		expect(assessDirection("up", boundary, later)).toBe("as_declared");
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
	it("rejects an unreadable view when pinning, while allowing proven absence and ineligible readings", async () => {
		const definition = {
			id: "ratio",
			title: "Ratio",
			revision: "1",
			spec: { calculatorId: "work.test@1", params: {}, maxAgeSeconds: 7200 },
		};
		const failed = {
			...fresh,
			status: "error" as const,
			value: null,
			reason: "source_failed",
		};
		let mode: "outage" | "absent" | "failed" | "fresh" = "outage";
		const observations = {
			history: async () => {
				if (mode === "outage") throw new Error("private store detail");
				return mode === "absent" ? [] : [mode === "failed" ? failed : fresh];
			},
			lastGood: async () => (mode === "fresh" ? fresh : null),
		} as unknown as MetricObservationsPort;
		const service = createMetricService({
			definitions: {
				get: async () => definition,
				list: async () => ({ items: [definition], nextCursor: null }),
			},
			observations,
			registry: new MetricRegistry(),
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => NOW,
			authorize: async () => true,
		});
		const reader = createWorkMetricReader(service, () => NOW);
		const input = [{ metricId: "ratio", direction: "up" as const }];
		const baselines = {
			latestObservationId: (id: string) => reader.baselineId(id),
		};
		const resolver = { resolve: async () => [] };
		await expect(
			pinMoves([], input, { resolver, baselines }),
		).rejects.toMatchObject({
			name: "MetricBaselineUnavailableError",
			code: "metric_baseline_unavailable",
		});
		expect(await reader.latest("ratio")).toBeNull();
		for (mode of ["absent", "failed"] as const)
			expect(await pinMoves([], input, { resolver, baselines })).toMatchObject([
				{ baselineObservationId: null },
			]);
		mode = "fresh";
		expect(await pinMoves([], input, { resolver, baselines })).toMatchObject([
			{ baselineObservationId: fresh.id },
		]);
		mode = "outage";
		expect(
			await pinMoves(
				[{ ...input[0]!, baselineObservationId: fresh.id }],
				input,
				{ resolver, baselines },
			),
		).toMatchObject([{ baselineObservationId: fresh.id }]);
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
	it("uses native timeout without auxiliary cancellation and retains capacity until settlement", async () => {
		const set = vi.fn(async () => []);
		const pool = {
			begin: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ unsafe: set })),
		};
		const controllers = Array.from({ length: 4 }, () => new AbortController());
		const finishes: (() => void)[] = [];
		const cancel = vi.fn(() => new Promise<never>(() => {}));
		const reads = controllers.map((controller) =>
			readMetricBatch(pool as never, controller.signal, () =>
				Object.assign(
					new Promise<number>((resolve) => finishes.push(() => resolve(1))),
					{ cancel },
				),
			).catch((error) => error),
		);
		await vi.waitFor(() => expect(finishes).toHaveLength(4));
		controllers.forEach((controller) => {
			controller.abort();
		});
		const errors = await Promise.all(reads);
		expect(errors.every((error) => error.code === "batch_unavailable")).toBe(
			true,
		);
		expect(cancel).not.toHaveBeenCalled();
		await expect(
			readMetricBatch(pool as never, undefined, () => Promise.resolve(2)),
		).rejects.toMatchObject({ code: "batch_unavailable" });
		expect(pool.begin).toHaveBeenCalledTimes(4);
		expect(set).toHaveBeenCalledWith("SET LOCAL statement_timeout=2000");
		finishes.forEach((finish) => {
			finish();
		});
		await vi.waitFor(async () =>
			expect(
				await readMetricBatch(pool as never, undefined, () =>
					Promise.resolve(2),
				),
			).toBe(2),
		);
	});
});

describe("goal reader deadline ownership", () => {
	it("coalesces callers, abandons a hung owner, and ignores its late completion", async () => {
		vi.useFakeTimers();
		try {
			const finishes: ((rows: never[]) => void)[] = [];
			const port = {
				listActiveGoals: vi.fn(
					() => new Promise<never[]>((resolve) => finishes.push(resolve)),
				),
				getKnowledge: async () => null,
				listCitationsByCitedId: async () => [],
			};
			const read = createGoalProgressReader({
				knowledge: () => port,
				metrics: () => undefined,
				environment: "test",
			});
			const first = read();
			expect(read()).toBe(first);
			const failed = first.catch((error) => error);
			await vi.advanceTimersByTimeAsync(2500);
			expect(await failed).toMatchObject({
				status: 503,
				code: "batch_unavailable",
			});
			const second = read();
			await vi.advanceTimersByTimeAsync(0);
			expect(port.listActiveGoals).toHaveBeenCalledTimes(2);
			finishes[0]!([]);
			await vi.advanceTimersByTimeAsync(0);
			expect(read()).toBe(second);
			finishes[1]!([]);
			expect(await second).toMatchObject({ goals: [] });
		} finally {
			vi.useRealTimers();
		}
	});
	it("caps unsettled reads per port across reader instances until native settlement", async () => {
		vi.useFakeTimers();
		try {
			const finishes: ((rows: never[]) => void)[] = [];
			const port = {
				listActiveGoals: vi.fn(
					() => new Promise<never[]>((resolve) => finishes.push(resolve)),
				),
				getKnowledge: async () => null,
				listCitationsByCitedId: async () => [],
			};
			const makeReader = () =>
				createGoalProgressReader({
					knowledge: () => port,
					metrics: () => undefined,
					environment: "test",
				});
			for (let i = 0; i < 4; i++) {
				const failed = makeReader()().catch((error) => error);
				await vi.advanceTimersByTimeAsync(2500);
				expect(await failed).toMatchObject({ status: 503 });
			}
			await expect(makeReader()()).rejects.toMatchObject({ status: 503 });
			expect(port.listActiveGoals).toHaveBeenCalledTimes(4);
			finishes[0]!([]);
			await vi.advanceTimersByTimeAsync(0);
			const replacement = makeReader()();
			await vi.advanceTimersByTimeAsync(0);
			expect(port.listActiveGoals).toHaveBeenCalledTimes(5);
			finishes[4]!([]);
			expect(await replacement).toMatchObject({ goals: [] });
			finishes.slice(1, 4).forEach((finish) => {
				finish([]);
			});
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("per-metric batch decode isolation", () => {
	const definition = (id: string) => ({
		id,
		title: id,
		revision: "1",
		spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
	});
	const observation = (id: string) => ({
		...fresh,
		id: `00000000-0000-4000-8000-${id === "healthy-a" ? "000000000001" : id === "bad" ? "000000000002" : "000000000003"}`,
		metricId: id,
		definitionHash: metricDefinitionHash(definition(id)),
		calculatorVersion: "work.count@1",
		paramsHash: hashMetric({}),
	});
	const raw = (id: string) => ({
		baseline_definition: definition(id),
		baseline_observation: observation(id),
		latest_observation: observation(id),
		good_observation: observation(id),
		evaluation_observation: observation(id),
	});
	const setup = (rows: Record<string, unknown>[], at = NOW) => {
		const sql = Object.assign(
			vi.fn(async () => rows),
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
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: { parse: (v: unknown) => v } as never,
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
		const ids = ["healthy-a", "bad", "healthy-c", "healthy-a"];
		const service = createMetricService({
			definitions: {
				get: async (id) => definition(id),
				getMany: async (found) => found.map(definition),
				list: async () => ({
					items: ids.slice(0, 3).map(definition),
					nextCursor: null,
				}),
			},
			observations: store,
			registry,
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => at,
			authorize: async () => true,
		});
		return { ids, store, service, sql };
	};
	it.each([
		"latest_observation",
		"good_observation",
		"baseline_observation",
		"baseline_definition",
	])(
		"isolates malformed %s in work reads, preserving duplicates and positions",
		async (field) => {
			const rows = [
				raw("healthy-a"),
				{ ...raw("bad"), [field]: "malformed-json" },
				raw("healthy-c"),
				raw("healthy-a"),
			];
			const { ids, store, service } = setup(rows);
			const result = await store.workReadBatch(
				ids.map((metricId) => ({
					metricId,
					definitionHash: metricDefinitionHash(definition(metricId)),
					baselineObservationId: observation(metricId).id,
				})),
			);
			expect(result).toHaveLength(4);
			const latestBroken = field === "latest_observation";
			const baselineBroken = field.startsWith("baseline_");
			expect(result[1]?.latest?.metricId ?? null).toBe(
				latestBroken ? null : "bad",
			);
			expect(result[1]?.baseline?.observation.metricId ?? null).toBe(
				baselineBroken ? null : "bad",
			);
			const projected = await service.workReadBatch(
				ids.map((metricId) => ({
					metricId,
					baselineObservationId: observation(metricId).id,
				})),
			);
			expect(projected[1]?.baseline?.metricId ?? null).toBe(
				baselineBroken ? null : "bad",
			);
			expect(projected[1]?.current?.metricId ?? null).toBe(
				latestBroken ? null : "bad",
			);
			if (latestBroken)
				expect(projected[1]?.unknownReason).toBe("metrics_unavailable");
			expect(projected[2]?.current?.metricId).toBe("healthy-c");
		},
	);
	it("preserves current six when a pinned baseline timestamp is malformed or absent", async () => {
		const current = { ...observation("bad"), value: 6 };
		const rows = [
			{
				...raw("bad"),
				baseline_observation: {
					...observation("bad"),
					observedAt: "not-a-date",
				},
				latest_observation: current,
			},
			{
				...raw("bad"),
				baseline_observation: null,
				latest_observation: current,
			},
		];
		const { service } = setup(rows);
		const projected = await service.workReadBatch(
			rows.map(() => ({
				metricId: "bad",
				baselineObservationId: observation("bad").id,
			})),
		);
		for (const row of projected) {
			expect(row.baseline).toBeNull();
			expect(row.current).toMatchObject({ value: 6, viewState: "ok" });
		}
	});
	it.each(["not-a-date", "2026-02-30T11:00:00.000Z"])(
		"isolates malformed observedAt %s without dropping a healthy sibling",
		async (malformed) => {
			const { store } = setup([
				raw("healthy-a"),
				{
					...raw("bad"),
					latest_observation: { ...observation("bad"), observedAt: malformed },
				},
				raw("healthy-c"),
			]);
			const rows = await store.predictionReadBatch(
				["healthy-a", "bad", "healthy-c"].map((metricId) => ({
					metricId,
					baselineObservationId: observation(metricId).id,
					evaluationAt: NOW.toISOString(),
				})),
			);
			expect(rows[1]).toMatchObject({ rollingUnreadable: true });
			expect(rows[2]?.latest?.metricId).toBe("healthy-c");
		},
	);
	it("keeps healthy unbound/served rows when an actual adapter cannot decode a sibling", async () => {
		const { service } = setup([
			raw("healthy-a"),
			{
				...raw("bad"),
				latest_observation: { ...observation("bad"), value: "wrong-type" },
			},
			raw("healthy-c"),
		]);
		const goals = await readGoalsProgress({
			goals: {
				listGoals: async () => [],
				hypotheses: async () => ({ items: [], more: false }),
			},
			metrics: service,
			environment: "test",
		});
		expect(goals.servedUnavailable).toBeUndefined();
		expect(
			goals.unbound?.map((row) => [row.metric.id, row.latest?.viewState]),
		).toEqual([
			["healthy-a", "ok"],
			["bad", "error"],
			["healthy-c", "ok"],
		]);
	});
	it.each([
		"latest_observation",
		"good_observation",
		"baseline_observation",
		"baseline_definition",
		"evaluation_observation",
	])(
		"isolates malformed %s in prediction reads and assessments",
		async (field) => {
			const { ids, store, service } = setup(
				[
					raw("healthy-a"),
					{ ...raw("bad"), [field]: "malformed-json" },
					raw("healthy-c"),
					raw("healthy-a"),
				],
				new Date(NOW.getTime() + 3 * 3600000),
			);
			const evaluationAt = fresh.window.end;
			const bindings = ids.map((metricId) => ({
				metricId,
				comparator: "gte" as const,
				target: { value: 1, unit: "ratio" },
				baselineObservationId: observation(metricId).id,
				evaluationAt,
			}));
			const rows = await store.predictionReadBatch(bindings);
			expect(rows).toHaveLength(4);
			const rollingFailure =
				field === "latest_observation" || field === "good_observation";
			expect(rows[1]).toMatchObject(
				rollingFailure
					? { rollingUnreadable: true, evaluation: observation("bad") }
					: { unreadable: true, evaluation: null },
			);
			expect(rows[2]?.latest?.metricId).toBe("healthy-c");
			const results = await service.predictionBatch(bindings);
			expect(results.map((row) => row.metricId)).toEqual(ids);
			expect(results[1]?.viewState).toBe("error");
			expect(results[1]?.assessment).toMatchObject(
				rollingFailure
					? { status: "met", observationId: observation("bad").id }
					: {
							status: "not_measured",
							reason: "source_failed",
							observationId: null,
						},
			);
			expect(results.map((row) => row.assessment.status)).toEqual([
				"met",
				rollingFailure ? "met" : "not_measured",
				"met",
				"met",
			]);
			expect(results[2]?.assessment.observationId).toBe(
				observation("healthy-c").id,
			);
		},
	);
});

describe("one assessment across public readers", () => {
	const definition = {
		id: "ratio",
		title: "Ratio",
		revision: "1",
		spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
		band: { comparator: "gte" as const, target: { value: 1, unit: "ratio" } },
	};
	const good: MetricObservation = {
		...fresh,
		definitionHash: metricDefinitionHash(definition),
		calculatorVersion: "work.count@1",
		paramsHash: hashMetric({}),
	};
	const pending: MetricObservation = {
		...good,
		id: "00000000-0000-4000-8000-000000000099",
		status: "pending",
		value: null,
		reason: null,
		observedAt: null,
		window: { start: NOW.toISOString(), end: NOW.toISOString() },
	};
	const rolling = {
		metricId: "ratio",
		comparator: "gte" as const,
		target: { value: 1, unit: "ratio" },
	};
	const prediction = {
		...rolling,
		baselineObservationId: good.id,
		evaluationAt: new Date(NOW.getTime() + DAY).toISOString(),
	};
	const setup = (evaluation: MetricObservation | null = good) => {
		let clock = NOW;
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: z.object({}),
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
				list: async () => ({ items: [definition], nextCursor: null }),
			},
			observations: {
				history: async () => [pending],
				lastGood: async () => good,
				at: async () => evaluation,
				snapshot: async () => ({ definition, observation: good }),
				buckets: async () => [],
				workReadBatch: async () => [
					{ baseline: null, latest: pending, lastGood: good },
				],
				predictionReadBatch: async () => [
					{
						baseline: { definition, observation: good },
						latest: pending,
						lastGood: good,
						evaluation,
					},
				],
			} as unknown as MetricObservationsPort,
			registry,
			scope: { node: "n", environment: "e", dataScope: "d" },
			now: () => clock,
			authorize: async () => true,
		});
		return {
			service,
			setClock: (value: Date) => {
				clock = value;
			},
		};
	};
	it("qualifies pending rolling readings in kpi, band, flat read, subject and goals", async () => {
		const { service } = setup();
		const kpi = await service.kpi(rolling, { latestOnly: true });
		expect(kpi).toMatchObject({
			viewState: "pending",
			assessment: {
				status: "building",
				value: good.value,
				observationId: good.id,
			},
		});
		expect((await service.read("ratio")).bandAssessment).toEqual(
			kpi.assessment,
		);
		expect((await service.serving()).unbound[0]?.assessment).toEqual(
			kpi.assessment,
		);
		const handlers = createMetricHttpHandlers({
			service: () => service,
			goalProgress: async () => {
				throw new Error("unused");
			},
			subject: async () => ({
				id: "goal",
				title: "Goal",
				entryType: "goal",
				kpiBindings: [rolling],
			}),
		});
		const subject = await handlers.subject("goal");
		expect(subject.status).toBe(200);
		expect((subject.body as { kpis: unknown[] }).kpis[0]).toMatchObject({
			met: null,
			viewState: "pending",
			assessment: kpi.assessment,
		});
		const goals = await readGoalsProgress({
			goals: {
				listGoals: async () => [
					{
						id: "goal",
						title: "Goal",
						evaluateAt: null,
						kpiBindings: [rolling],
					},
				],
				hypotheses: async () => ({ items: [], more: false }),
			},
			metrics: service,
			environment: "test",
		});
		expect(goals.goals[0]?.kpis[0]).toMatchObject({
			viewState: "pending",
			assessment: kpi.assessment,
		});
	});
	it("retains pending and not-due uncertainty through batch, subject and hypothesis projections", async () => {
		const { service } = setup();
		const [batch] = await service.predictionBatch([prediction]);
		expect(batch).toMatchObject({
			viewState: "pending",
			assessment: {
				status: "unresolved",
				reason: "evaluation_not_due",
				value: good.value,
			},
		});
		const kpi = await service.kpi(prediction, {
			hypothesis: true,
			latestOnly: true,
		});
		expect(kpi.assessment).toEqual(batch?.assessment);
		const [legacy] = await service.bindings([prediction], { hypothesis: true });
		expect(legacy).toMatchObject({
			met: null,
			viewState: "pending",
			reason: "evaluation_not_due",
			assessment: batch?.assessment,
		});
		const goals = await readGoalsProgress({
			goals: {
				listGoals: async () => [
					{ id: "goal", title: "Goal", evaluateAt: null, kpiBindings: [] },
				],
				hypotheses: async () => ({
					items: [
						{
							id: "bet",
							title: "Bet",
							evaluateAt: prediction.evaluationAt,
							kpiBindings: [prediction],
							outcome: null,
						},
					],
					more: false,
				}),
			},
			metrics: service,
			environment: "test",
		});
		expect(goals.goals[0]?.hypotheses[0]?.predictions[0]).toMatchObject({
			viewState: "pending",
			assessment: batch?.assessment,
		});
	});
	it.each(["met", "missed", "unresolved", "evaluating"] as const)(
		"does not replace the immutable %s deadline assessment with a pending refresh",
		async (status) => {
			const { service, setClock } = setup(
				status === "unresolved" ? null : good,
			);
			const binding = {
				...rolling,
				baselineObservationId: good.id,
				evaluationAt: good.window.end,
				target: { value: status === "missed" ? 2 : 1, unit: "ratio" },
			};
			if (status === "evaluating")
				setClock(new Date(Date.parse(good.window.end) + 3600000));
			else setClock(new Date(Date.parse(good.window.end) + 3 * 3600000));
			const evaluation = status === "unresolved" ? null : good;
			const result = assessKpi(
				input({
					binding,
					latestAttempt: pending,
					lastGood: good,
					viewState: "pending",
					deadline: binding.evaluationAt,
					evaluation,
					now: service.now(),
				}),
			);
			expect(result.status).toBe(status);
			{
				const kpi = await service.kpi(binding, {
					hypothesis: true,
					latestOnly: true,
				});
				const [batch] = await service.predictionBatch([binding]);
				expect(kpi.assessment.status).toBe(status);
				expect(batch?.assessment).toEqual(kpi.assessment);
			}
		},
	);
});

describe("bound KPI decoder containment", () => {
	it.each(["history", "lastGood", "evaluation", "baseline"])(
		"keeps healthy goal/subject siblings when %s decoding fails",
		async (failedRead) => {
			const defs = ["bad", "healthy"].map((id) => ({
				id,
				title: id,
				revision: "1",
				spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
			}));
			const readingFor = (id: string) => ({
				...fresh,
				metricId: id,
				id: `00000000-0000-4000-8000-${id === "bad" ? "000000000001" : "000000000002"}`,
				definitionHash: metricDefinitionHash(defs.find((d) => d.id === id)!),
				calculatorVersion: "work.count@1",
				paramsHash: hashMetric({}),
			});
			const sql = Object.assign(
				(strings: TemplateStringsArray, ...values: unknown[]) => {
					const text = strings.join("?");
					if (text.startsWith("WITH requested"))
						return Promise.resolve(
							JSON.parse(String(values[0])).map(
								(request: { metricId: string }) => ({
									latest_observation:
										request.metricId === "bad"
											? { ...readingFor("bad"), value: "broken" }
											: readingFor("healthy"),
									good_observation: readingFor(request.metricId),
								}),
							),
						);
					if (text.startsWith("SELECT snapshot,observation")) {
						const id = values[0] === readingFor("bad").id ? "bad" : "healthy";
						return Promise.resolve([
							{
								snapshot: defs.find((d) => d.id === id),
								observation:
									id === "bad" && failedRead === "baseline"
										? "malformed-json"
										: readingFor(id),
							},
						]);
					}
					if (text.startsWith("SELECT observation")) {
						const id = String(values[1]);
						const kind = text.includes("evaluation_at <=")
							? "evaluation"
							: text.includes("status='ok'")
								? "lastGood"
								: "history";
						return Promise.resolve([
							{
								observation:
									id === "bad" && kind === failedRead
										? { ...readingFor(id), value: "broken" }
										: readingFor(id),
							},
						]);
					}
					return Promise.resolve([]);
				},
				{
					unsafe: async () => [],
					begin: async (fn: (tx: unknown) => unknown): Promise<unknown> =>
						fn(sql),
				},
			);
			const observations = new PostgresMetricObservations(sql as never, {
				node: "n",
				environment: "e",
				dataScope: "d",
			});
			const registry = new MetricRegistry();
			registry.register({
				id: "work.count@1",
				unit: "ratio",
				paramsSchema: z.object({}),
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
					get: async (id) => defs.find((d) => d.id === id) ?? null,
					list: async () => ({ items: defs, nextCursor: null }),
				},
				observations,
				registry,
				scope: { node: "n", environment: "e", dataScope: "d" },
				now: () => new Date(NOW.getTime() + 3 * 3600000),
				authorize: async () => true,
			});
			const bindings = defs.map((d) => ({
				metricId: d.id,
				comparator: "gte" as const,
				target: { value: 1, unit: "ratio" },
				...(failedRead === "baseline"
					? { baselineObservationId: readingFor(d.id).id }
					: {}),
				...(failedRead === "evaluation"
					? { evaluationAt: fresh.window.end }
					: {}),
			}));
			if (failedRead === "history" || failedRead === "lastGood") {
				const due = await service.kpi({
					...bindings[0]!,
					evaluationAt: fresh.window.end,
				});
				expect(due.viewState).toBe("error");
				expect(due.assessment).toMatchObject({
					status: "met",
					observationId: readingFor("bad").id,
				});
			}
			const goalSource = {
				listGoals: async () => [
					{
						id: "first",
						title: "First",
						evaluateAt: null,
						kpiBindings: bindings,
					},
					{
						id: "unrelated",
						title: "Unrelated",
						evaluateAt: null,
						kpiBindings: [bindings[1]!],
					},
				],
				hypotheses: async () => ({ items: [], more: false }),
			};
			const goalProgress = () =>
				readGoalsProgress({
					goals: goalSource,
					metrics: service,
					environment: "test",
				});
			const handlers = createMetricHttpHandlers({
				service: () => service,
				goalProgress,
				subject: async () => ({
					id: "first",
					title: "First",
					entryType: "goal",
					kpiBindings: bindings,
				}),
			});
			const response = await handlers.goals();
			expect(response.status).toBe(200);
			const result = await goalProgress();
			expect(result.goals).toHaveLength(2);
			expect(result.goals[0]?.kpis[0]).toMatchObject({
				viewState: "error",
				assessment: { status: "not_measured", reason: "source_failed" },
			});
			expect(result.goals[0]?.kpis[1]?.assessment.reason).not.toBe(
				"source_failed",
			);
			expect(result.goals[1]?.kpis[0]?.metric?.id).toBe("healthy");
			const subject = await handlers.subject("first");
			expect(subject.status).toBe(200);
			expect((subject.body as { kpis: unknown[] }).kpis).toHaveLength(2);
			const flat = await service.list();
			expect(flat.items).toHaveLength(2);
			expect(flat.items[1]?.viewState).toBe("stale");
			if (failedRead === "history" || failedRead === "lastGood")
				expect(flat.items[0]?.viewState).toBe("error");
		},
	);
});

it("keeps expired or invalid current windows stale across readers without changing pending/failure or final evidence", async () => {
	const definition = {
		id: "ratio",
		title: "Ratio",
		revision: "1",
		spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 3600 },
	};
	const end = new Date(NOW.getTime() - 4 * 3600000).toISOString();
	const current: MetricObservation = {
		...reading(1.2, end),
		definitionHash: metricDefinitionHash(definition),
		calculatorVersion: "work.count@1",
		paramsHash: hashMetric({}),
		observedAt: NOW.toISOString(),
		sourceWatermarks: [{ source: "s", asOf: NOW.toISOString() }],
	};
	const evaluation = {
		...current,
		observedAt: end,
		sourceWatermarks: [{ source: "s", asOf: end }],
	};
	const registry = new MetricRegistry();
	registry.register({
		id: "work.count@1",
		unit: "ratio",
		paramsSchema: z.object({}),
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
			list: async () => ({ items: [definition], nextCursor: null }),
		},
		observations: {
			history: async () => [current],
			lastGood: async () => current,
			at: async () => evaluation,
			buckets: async () => [],
			workReadBatch: async () => [
				{ baseline: null, latest: current, lastGood: current },
			],
		} as unknown as MetricObservationsPort,
		registry,
		scope: { node: "n", environment: "e", dataScope: "d" },
		now: () => NOW,
		authorize: async () => true,
	});
	const binding = {
		metricId: "ratio",
		comparator: "gte" as const,
		target: { value: 1, unit: "ratio" },
	};
	expect(
		(await service.kpi(binding, { latestOnly: true })).assessment.status,
	).toBe("delayed");
	expect(
		(await createWorkMetricReader(service, () => NOW).latest("ratio"))
			?.viewState,
	).toBe("stale");
	expect((await service.read("ratio")).viewState).toBe("stale");
	expect((await service.serving()).unbound[0]?.latest.viewState).toBe("stale");
	expect(
		(
			await service.workReadBatch([
				{ metricId: "ratio", baselineObservationId: null },
			])
		)[0]?.current?.viewState,
	).toBe("stale");
	for (const windowEnd of [
		end,
		"not-a-date",
		new Date(NOW.getTime() + 1).toISOString(),
	])
		expect(
			selectMetricView(
				definition,
				[{ ...current, window: { start: windowEnd, end: windowEnd } }],
				NOW,
			).viewState,
		).toBe("stale");
	const boundary = new Date(NOW.getTime() - 3600000).toISOString();
	expect(
		selectMetricView(
			definition,
			[{ ...current, window: { start: boundary, end: boundary } }],
			NOW,
		).viewState,
	).toBe("ok");
	for (const status of ["pending", "error", "unavailable"] as const)
		expect(
			selectMetricView(definition, [{ ...current, status, value: null }], NOW)
				.viewState,
		).toBe(status);
	const final = await service.kpi(
		{ ...binding, evaluationAt: end },
		{ latestOnly: true },
	);
	expect(final).toMatchObject({
		viewState: "stale",
		assessment: { status: "met", observationId: evaluation.id },
	});
});

it("projects bindings with the canonical active-goal list and preserves older reader fallback", async () => {
	const binding = {
		metricId: "ratio",
		comparator: "gte",
		target: { value: 1, unit: "ratio" },
	};
	const query = vi.fn(async (text: string) =>
		text.includes("FROM citations")
			? [{ cited_id: "goal-retired" }]
			: [
					{
						id: "goal-live",
						entry_type: "goal",
						title: "Live",
						content: "",
						evaluate_at: null,
						kpi_bindings: [binding],
					},
					{
						id: "goal-empty",
						entry_type: "goal",
						title: "Empty",
						content: "",
						evaluate_at: null,
						kpi_bindings: null,
					},
					{
						id: "goal-bad",
						entry_type: "goal",
						title: "Invalid",
						content: "",
						evaluate_at: null,
						kpi_bindings: { malformed: true },
					},
					{
						id: "goal-retired",
						entry_type: "goal",
						title: "Retired",
						content: "",
						evaluate_at: null,
						kpi_bindings: [binding],
					},
				],
	);
	const adapter = new DoltgresKnowledgeStoreAdapter({
		sql: { unsafe: query } as never,
	});
	const body = vi.spyOn(adapter, "getKnowledge");
	const subjects = await createGoalSource(adapter).listGoals();
	expect(subjects.map((s) => [s.id, s.kpiBindings])).toEqual([
		["goal-bad", { malformed: true }],
		["goal-empty", []],
		["goal-live", [binding]],
	]);
	expect(query).toHaveBeenCalledTimes(2);
	expect(query.mock.calls[0]?.[0]).toContain("kpi_bindings");
	expect(body).not.toHaveBeenCalled();
	const fallback = vi.fn(async () => ({
		id: "goal-old",
		title: "Older port",
		kpiBindings: [binding],
	}));
	expect(
		(
			await createGoalSource({
				listActiveGoals: async () => [{ id: "goal-old", title: "Older port" }],
				getKnowledge: fallback,
				listCitationsByCitedId: async () => [],
			}).listGoals()
		)[0]?.kpiBindings,
	).toEqual([binding]);
	expect(fallback).toHaveBeenCalledWith("goal-old");
});

it("retains goal admission until the parallel serving branch settles after goal failure", async () => {
	vi.useFakeTimers();
	try {
		const finishes: ((value: never) => void)[] = [];
		const port = {
			listActiveGoals: async () => {
				throw new Error("source failed");
			},
			getKnowledge: async () => null,
			listCitationsByCitedId: async () => [],
		};
		const serving = vi.fn(
			() => new Promise<never>((resolve) => finishes.push(resolve)),
		);
		const make = () =>
			createGoalProgressReader({
				knowledge: () => port,
				metrics: () => ({ serving }) as never,
				environment: "test",
			});
		for (let i = 0; i < 4; i++) {
			const failed = make()().catch((error) => error);
			await vi.advanceTimersByTimeAsync(2500);
			expect(await failed).toMatchObject({ code: "batch_unavailable" });
		}
		await expect(make()()).rejects.toMatchObject({ code: "batch_unavailable" });
		expect(serving).toHaveBeenCalledTimes(4);
		finishes.forEach((finish) => {
			finish(null as never);
		});
		await vi.advanceTimersByTimeAsync(0);
		const replacement = make()().catch((error) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(serving).toHaveBeenCalledTimes(5);
		finishes[4]?.(null as never);
		expect((await replacement).message).toBe("source failed");
	} finally {
		vi.useRealTimers();
	}
});

it("stops native active-goal fan-out after the metric deadline", async () => {
	vi.useFakeTimers();
	try {
		let finish!: (rows: Record<string, unknown>[]) => void;
		const query = vi.fn(
			() =>
				new Promise<Record<string, unknown>[]>((resolve) => {
					finish = resolve;
				}),
		);
		const adapter = new DoltgresKnowledgeStoreAdapter({
			sql: { unsafe: query } as never,
		});
		const pending = readMetricBudget(adapter, undefined, (signal) =>
			createGoalSource(adapter, signal).listGoals(),
		);
		const result = pending.catch((error) => error);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await result).toMatchObject({ code: "batch_unavailable" });
		expect(query).toHaveBeenCalledTimes(1);
		finish([
			{
				id: "goal-live",
				entry_type: "goal",
				title: "Live",
				content: "",
				kpi_bindings: [],
			},
		]);
		await vi.advanceTimersByTimeAsync(0);
		expect(query).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("bounds pooled goal reads at two, preserves complete order, and settles siblings on failure", async () => {
	let active = 0,
		maximum = 0,
		released = 0;
	const goals = Array.from({ length: 5 }, (_, i) => ({
		id: `goal-${i}`,
		title: `Goal ${i}`,
		evaluateAt: null,
		kpiBindings: [],
	}));
	const read = await readGoalsProgress({
		environment: "test",
		metrics: undefined,
		pooledGoalReads: true,
		goals: {
			listGoals: async () => goals,
			hypotheses: async () => {
				active++;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				released++;
				return { items: [], more: false };
			},
		},
	});
	expect(read.goals.map((g) => g.id)).toEqual(goals.map((g) => g.id));
	expect(maximum).toBe(2);
	expect(active).toBe(0);
	expect(released).toBe(5);
	// Cancellation while two native hypothesis reads are running must await both.
	const controller = new AbortController();
	active = 0;
	released = 0;
	const pending = readGoalsProgress({
		environment: "test",
		metrics: undefined,
		pooledGoalReads: true,
		signal: controller.signal,
		goals: {
			listGoals: async () => goals,
			hypotheses: async () => {
				active++;
				if (active === 2) controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				released++;
				return { items: [], more: false };
			},
		},
	});
	await expect(pending).rejects.toThrow();
	expect(active).toBe(0);
	expect(released).toBe(2);
});

describe("authorized provenance at public projection boundaries", () => {
	const definition = {
		id: "ratio",
		title: "Ratio",
		revision: "1",
		spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 7200 },
	};
	const scope = { node: "n", environment: "e", dataScope: "d" };
	const good = {
		...fresh,
		value: 0,
		definitionHash: metricDefinitionHash(definition),
		calculatorVersion: definition.spec.calculatorId,
		paramsHash: hashMetric(definition.spec.params),
	};
	const mutations: [string, Partial<MetricObservation>][] = [
		["calculator", { calculatorVersion: "work.count@2" }],
		["params", { paramsHash: hashMetric({ other: true }) }],
		["unit", { unit: "other" }],
		[
			"window",
			{ window: { start: "2026-11-02T10:00:00.000Z", end: fresh.window.end } },
		],
	];
	function setup(observation: MetricObservation, historical = definition) {
		const registry = new MetricRegistry();
		registry.register({
			id: "work.count@1",
			unit: "ratio",
			paramsSchema: z.object({}),
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
		const sql = Object.assign(
			(strings: TemplateStringsArray, ...values: unknown[]) => {
				if (strings.join("?").startsWith("WITH requested"))
					return Promise.resolve(
						JSON.parse(String(values[0])).map((_: unknown, i: number) => ({
							baseline_definition: historical,
							baseline_observation: i === 0 ? observation : good,
							latest_observation: i === 0 ? observation : good,
							good_observation: i === 0 ? observation : good,
						})),
					);
				return Promise.resolve([{ observation }]);
			},
			{
				unsafe: async () => [],
				begin: async (fn: (tx: unknown) => unknown): Promise<unknown> =>
					fn(sql),
			},
		);
		const observations = new PostgresMetricObservations(sql as never, scope);
		return createMetricService({
			definitions: {
				get: async () => definition,
				getMany: async () => [definition],
				list: async () => ({ items: [definition], nextCursor: null }),
			},
			observations,
			registry,
			scope,
			now: () => NOW,
			authorize: async () => true,
		});
	}
	it.each(mutations)(
		"rejects schema-valid contradictory %s in work reads, retaining a zero sibling",
		async (_, patch) => {
			const service = setup({ ...good, ...patch });
			const rows = await service.workReadBatch(
				[0, 1].map(() => ({
					metricId: "ratio",
					baselineObservationId: good.id,
				})),
			);
			expect(rows[0]?.baseline).toBeNull();
			expect(rows[0]?.current).toBeNull();
			expect(
				assessDirection(
					"up",
					rows[0]?.baseline ?? null,
					rows[0]?.current ?? null,
				),
			).toBe("unknown");
			expect(rows[1]?.current).toMatchObject({ value: 0, viewState: "ok" });
			expect(
				assessDirection(
					"up",
					rows[1]?.baseline ?? null,
					rows[1]?.current ?? null,
				),
			).toBe("flat");
		},
	);
	it.each(mutations)(
		"rejects contradictory %s in rolling and preloaded KPI evidence",
		async (_, patch) => {
			const bad = { ...good, ...patch };
			const service = setup(bad);
			const binding = {
				metricId: "ratio",
				comparator: "gte" as const,
				target: { value: 0, unit: "ratio" },
			};
			for (const options of [
				{ latestOnly: true },
				{
					latestOnly: true,
					preloaded: { definition, latest: bad, lastGood: good },
				},
				{
					latestOnly: true,
					preloaded: { definition, latest: good, lastGood: bad },
				},
			]) {
				const result = await service.kpi(binding, options);
				expect(result.assessment.status).not.toBe("on_track");
				expect(result.assessment.value).toBeNull();
			}
			const healthy = await setup(good).kpi(binding, { latestOnly: true });
			expect(healthy.assessment).toMatchObject({
				status: "on_track",
				value: 0,
			});
		},
	);
	it("keeps a pinned historical snapshot instead of validating it against an edited current definition", async () => {
		const historical = {
			...definition,
			revision: "old",
			spec: { ...definition.spec, params: { old: true } },
		};
		const observation = {
			...good,
			definitionHash: metricDefinitionHash(historical),
			paramsHash: hashMetric(historical.spec.params),
		};
		const [row] = await setup(observation, historical).workReadBatch([
			{ metricId: "ratio", baselineObservationId: good.id },
		]);
		expect(row?.baseline).toEqual(observation);
		expect(row?.current).toBeNull();
	});
});
