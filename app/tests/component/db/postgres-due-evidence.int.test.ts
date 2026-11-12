// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

import {
	createMetricService,
	hashMetric,
	type MetricObservation,
	MetricRegistry,
	metricDefinitionHash,
} from "@cogni-dao/metrics";
import { PostgresMetricObservations } from "@cogni-dao/metrics/adapters/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run against a disposable PostgreSQL database; never use a node database.
const url = process.env.DATABASE_SERVICE_URL;
if (!url) throw new Error("component PostgreSQL required");
describe("due evidence selection against PostgreSQL", () => {
	const sql = postgres(url, { max: 1 });
	const scope = { node: "n", environment: "e", dataScope: "d" };
	const definition = {
		id: "ratio",
		title: "Ratio",
		revision: "1",
		spec: { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 3600 },
	};
	const hash = metricDefinitionHash(definition);
	const deadline = "2026-11-02T12:00:00.000Z";
	const make = (
		id: number,
		end: string,
		watermark = end,
	): MetricObservation => ({
		id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
		metricId: "ratio",
		definitionRevision: "1",
		definitionHash: hash,
		calculatorVersion: "work.count@1",
		paramsHash: hashMetric({}),
		...scope,
		window: { start: new Date(Date.parse(end) - 3600000).toISOString(), end },
		sourceWatermarks: [{ source: "s", asOf: watermark }],
		observedAt: end,
		status: "ok",
		value: 2,
		unit: "ratio",
		reason: null,
		evidenceRefs: [],
	});
	const baseline = make(1, "2026-11-01T12:00:00.000Z");
	const good = make(2, "2026-11-02T11:30:00.000Z");
	const failed = {
		...make(4, "2026-11-02T11:55:00.000Z"),
		status: "error" as const,
		value: null,
	};
	const future = make(5, "2026-11-02T12:05:00.000Z");
	const store = new PostgresMetricObservations(sql, scope);
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
		observations: store,
		registry,
		scope,
		now: () => new Date("2026-11-02T13:00:00.000Z"),
		authorize: async () => true,
	});
	const eligibility = {
		calculatorVersion: definition.spec.calculatorId,
		paramsHash: hashMetric({}),
		unit: "ratio",
		windowSeconds: 3600,
		baselineEnd: baseline.window.end,
	};
	const binding = {
		metricId: "ratio",
		comparator: "gte" as const,
		target: { value: 2, unit: "ratio" },
		baselineObservationId: baseline.id,
		evaluationAt: deadline,
	};
	async function insert(o: MetricObservation) {
		await sql`INSERT INTO metric_observations (id,scope,metric_id,definition_hash,evaluation_at,snapshot,observation,status) VALUES (${o.id},'n/e/d','ratio',${hash},${o.id === make(3, "2026-11-02T11:45:00.000Z").id ? "2026-11-02T11:45:00.000Z" : o.window.end},${sql.json(definition)},${sql.json(o)},${o.status})`;
	}
	beforeAll(async () => {
		await sql`CREATE TEMP TABLE metric_observations (id uuid PRIMARY KEY, scope text, metric_id text, definition_hash text, evaluation_at timestamptz, snapshot jsonb, observation jsonb, status text)`;
		// One connection keeps the temporary table visible to the batch transaction.
	});
	afterAll(async () => {
		await sql.end();
	});
	it.each([
		[
			"stale watermark",
			{ sourceWatermarks: [{ source: "s", asOf: "2026-11-02T09:00:00.000Z" }] },
		],
		["paramsHash", { paramsHash: "incompatible" }],
		["definitionHash", { definitionHash: "incompatible" }],
		["calculator", { calculatorVersion: "work.count@2" }],
		["unit", { unit: "items" }],
		["scope", { node: "foreign" }],
		[
			"window width",
			{
				window: {
					start: "2026-11-02T11:00:00.000Z",
					end: "2026-11-02T11:45:00.000Z",
				},
			},
		],
		[
			"window before baseline",
			{
				window: {
					start: "2026-10-31T11:45:00.000Z",
					end: "2026-10-31T12:45:00.000Z",
				},
			},
		],
		["failed", { status: "error", value: null }],
		["null value", { value: null }],
		["future observedAt", { observedAt: "2026-11-02T14:00:00.000Z" }],
		["malformed observedAt", { observedAt: "not-a-date" }],
		[
			"malformed window",
			{ window: { start: "bad", end: "2026-11-02T11:45:00.000Z" } },
		],
		["malformed watermarks", { sourceWatermarks: {} }],
		["unknown watermark", { sourceWatermarks: [{ source: "s", asOf: null }] }],
		[
			"future watermark",
			{ sourceWatermarks: [{ source: "s", asOf: "2026-11-02T11:46:00.000Z" }] },
		],
		["empty watermarks", { sourceWatermarks: [] }],
		["malformed evidence refs", { evidenceRefs: [42] }],
		["malformed unit", { unit: 42 }],
		["malformed revision", { definitionRevision: null }],
		["missing reason", { reason: undefined }],
		["pending", { status: "pending", value: null }],
		[
			"malformed watermark source",
			{ sourceWatermarks: [{ source: 42, asOf: "2026-11-02T11:45:00.000Z" }] },
		],
	])(
		"selects older eligible evidence before newer %s in both paths",
		async (_name, patch) => {
			await sql`DELETE FROM metric_observations`;
			for (const o of [
				baseline,
				good,
				{ ...make(3, "2026-11-02T11:45:00.000Z"), ...patch },
				failed,
				future,
			])
				await insert(o as MetricObservation);
			expect(
				(await store.at("ratio", hash, deadline, 3600, eligibility))?.id,
			).toBe(good.id);
			expect(
				(await service.predictionBatch([binding]))[0]?.assessment,
			).toMatchObject({ status: "met", observationId: good.id });
			expect(
				(await service.kpi(binding, { hypothesis: true, latestOnly: true }))
					.assessment,
			).toMatchObject({ status: "met", observationId: good.id });
			await sql`DELETE FROM metric_observations WHERE id=${good.id}`;
			expect(
				(await service.predictionBatch([binding]))[0]?.assessment,
			).toMatchObject({
				status: "unresolved",
				reason: "no_reading_at_evaluation",
			});
			expect(
				(await service.kpi(binding, { hypothesis: true, latestOnly: true }))
					.assessment,
			).toMatchObject({
				status: "unresolved",
				reason: "no_reading_at_evaluation",
			});
		},
	);
});
