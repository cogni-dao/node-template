// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Native regression: Dolt definitions and PostgreSQL observations have different
 * timeout capabilities. Work enrichment must not send PostgreSQL SET LOCAL to Dolt. */
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readMetricBatch } from "../../../../packages/metrics/src/adapters/read-budget";
import { metricDefinitionHash } from "../../../../packages/metrics/src/index";
import { createGoalMetrics } from "../../../../packages/metrics/src/knowledge";

const containers: StartedTestContainer[] = [];
let knowledge: Sql;
let knowledgeUrl: string;
let observations: Sql;
const events: object[] = [];
const now = new Date().toISOString();
const id = "9cdc33b4-6dbf-412a-b6d3-7827cd379274";
const definition = {
	id: "demoa-kpi1",
	title: "Real work count",
	revision: now,
	spec: {
		calculatorId: "work.count@1",
		params: { mode: "open" },
		maxAgeSeconds: 7200,
	},
};
const observation = {
	id,
	metricId: definition.id,
	definitionRevision: now,
	definitionHash: metricDefinitionHash(definition),
	calculatorVersion: "work.count@1",
	paramsHash: "p",
	node: "n",
	environment: "test",
	dataScope: "node-members",
	window: { start: now, end: now },
	sourceWatermarks: [{ source: "s", asOf: now }],
	observedAt: now,
	status: "ok",
	value: 8,
	unit: "items",
	reason: null,
	evidenceRefs: [],
};
const service = () =>
	createGoalMetrics({
		knowledgeSql: knowledge,
		observationsSql: observations,
		node: "n",
		environment: "test",
		log: (e) => events.push(e),
	});

beforeAll(async () => {
	for (const image of ["dolthub/doltgresql:0.57.3", "postgres:15-alpine"]) {
		const container = await new GenericContainer(image)
			.withEnvironment({
				DOLTGRES_PASSWORD: "native-test",
				POSTGRES_PASSWORD: "native-test",
			})
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(
					image.startsWith("dolthub")
						? /server (started|listening)/i
						: /database system is ready to accept connections/,
					image.startsWith("dolthub") ? 1 : 2,
				),
			)
			.start();
		containers.push(container);
		const sql = postgres(
			`postgresql://postgres:native-test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
			{ max: 1, fetch_types: false },
		);
		if (image.startsWith("dolthub")) {
			knowledge = sql;
			knowledgeUrl = `postgresql://postgres:native-test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
		} else observations = sql;
	}
	await knowledge.unsafe(
		"CREATE TABLE knowledge (id text PRIMARY KEY,title text,metric_spec jsonb,updated_at timestamptz,status text)",
	);
	await knowledge.unsafe(
		`INSERT INTO knowledge VALUES ('demoa-kpi1','Real work count','${JSON.stringify(definition.spec)}'::jsonb,'${now}','published')`,
	);
	await observations.unsafe(
		"CREATE TABLE metric_observations (id uuid PRIMARY KEY,scope text,metric_id text,definition_hash text,evaluation_at timestamptz,snapshot jsonb,observation jsonb,status text)",
	);
	await observations`INSERT INTO metric_observations VALUES (${id},'n/test/node-members',${definition.id},${observation.definitionHash},${now},${JSON.stringify(definition)}::jsonb,${JSON.stringify(observation)}::jsonb,'ok')`;
}, 120000);
afterAll(async () => {
	for (const sql of [knowledge, observations])
		if (sql) await sql.end({ timeout: 3 });
	for (const container of containers.reverse()) await container.stop();
});

it("reads actual pinned work measurement across native Dolt and Postgres", async () => {
	const legacy = postgres(knowledgeUrl, { max: 1, fetch_types: false });
	try {
		await expect(
			legacy.begin(async (tx) => {
				await tx.unsafe("SET LOCAL statement_timeout=2000");
			}),
		).rejects.toMatchObject({ code: "XX000" });
	} finally {
		await legacy.end({ timeout: 1 });
	}
	const rows = await service().workReadBatch([
		{ metricId: definition.id, baselineObservationId: id },
	]);
	expect(rows[0]?.baseline).toMatchObject({ id, value: 8 });
	expect(rows[0]?.current).toMatchObject({
		id,
		value: 8,
		unit: "items",
		viewState: "ok",
	});
	expect(events).toEqual([]);
});
it("retains native PostgreSQL statement timeout protection", async () => {
	await expect(
		readMetricBatch(observations, undefined, (sql) =>
			sql.unsafe("SELECT pg_sleep(3)"),
		),
	).rejects.toMatchObject({ code: "57014" });
	const rows = await observations.unsafe("SHOW statement_timeout");
	expect(rows[0]?.statement_timeout).toBe("0");
});
it("preserves a failed current attempt instead of substituting last good", async () => {
	const failedId = "9cdc33b4-6dbf-412a-b6d3-7827cd379275";
	const failed = {
		...observation,
		id: failedId,
		status: "error",
		value: null,
		reason: "source_failed",
	};
	await observations`INSERT INTO metric_observations VALUES (${failedId},'n/test/node-members',${definition.id},${observation.definitionHash},${now},${JSON.stringify(definition)}::jsonb,${JSON.stringify(failed)}::jsonb,'error')`;
	const rows = await service().workReadBatch([
		{ metricId: definition.id, baselineObservationId: id },
	]);
	expect(rows[0]?.baseline).toMatchObject({ id, value: 8 });
	expect(rows[0]?.current).toMatchObject({
		id: failedId,
		value: null,
		viewState: "error",
	});
});
it("keeps missing definitions distinct from a safe logged read failure", async () => {
	const rows = await service().workReadBatch([
		{ metricId: "absent", baselineObservationId: null },
	]);
	expect(rows[0]).toMatchObject({
		baseline: null,
		current: null,
		unknownReason: "metric_deprecated",
	});
	expect(events).toEqual([]);
	await knowledge.unsafe("DROP TABLE knowledge");
	await expect(
		service().workReadBatch([
			{ metricId: definition.id, baselineObservationId: id },
		]),
	).rejects.toBeDefined();
	expect(events).toEqual([
		expect.objectContaining({
			event: "metric.definition_batch_failed",
			phase: "definitions_read",
			errorCode: expect.any(String),
		}),
	]);
	expect(Object.keys(events[0] ?? {}).sort()).toEqual([
		"errorCode",
		"event",
		"phase",
	]);
});
