// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMetricObservations } from "../src/adapters/postgres";
import {
	createMetricService,
	hashMetric,
	type MetricObservation,
	MetricRegistry,
	metricDefinitionHash,
} from "../src/index";

// Run against a disposable PostgreSQL database; never use a node database.
const url = process.env.R20_METRICS_TEST_DATABASE_URL;
describe.skipIf(!url)("due evidence selection against PostgreSQL", () => {
	const sql = postgres(url ?? "", { max: 1 });
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
	const stale = make(3, "2026-11-02T11:45:00.000Z", "2026-11-02T09:00:00.000Z");
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
	const binding = {
		metricId: "ratio",
		comparator: "gte" as const,
		target: { value: 2, unit: "ratio" },
		baselineObservationId: baseline.id,
		evaluationAt: deadline,
	};
	async function insert(o: MetricObservation) {
		await sql`INSERT INTO metric_observations (id,scope,metric_id,definition_hash,evaluation_at,snapshot,observation,status) VALUES (${o.id},'n/e/d','ratio',${hash},${o.window.end},${sql.json(definition)},${sql.json(o)},${o.status})`;
	}
	beforeAll(async () => {
		await sql`CREATE TEMP TABLE metric_observations (id uuid PRIMARY KEY, scope text, metric_id text, definition_hash text, evaluation_at timestamptz, snapshot jsonb, observation jsonb, status text)`;
		// One connection keeps the temporary table visible to the batch transaction.
	});
	afterAll(async () => {
		await sql.end();
	});
	it("picks the older eligible reading for batch and direct KPI; excludes ineligible readings", async () => {
		for (const row of [baseline, good, stale, failed, future])
			await insert(row);
		expect((await store.at("ratio", hash, deadline, 3600))?.id).toBe(good.id);
		expect(
			(
				await store.predictionReadBatch([
					{
						metricId: "ratio",
						baselineObservationId: baseline.id,
						evaluationAt: deadline,
					},
				])
			)[0]?.evaluation?.id,
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
		await insert({ ...good, paramsHash: "incompatible" });
		expect(
			(await service.predictionBatch([binding]))[0]?.assessment,
		).toMatchObject({ status: "unresolved" });
		expect(
			(await service.kpi(binding, { hypothesis: true, latestOnly: true }))
				.assessment,
		).toMatchObject({ status: "unresolved" });
	});
});
