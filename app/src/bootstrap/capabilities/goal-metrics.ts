// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Node composition. Mission calculators and source permissions stay here, outside the published engine. */
import {
	createMetricService,
	type MetricDefinition,
	MetricRegistry,
	MetricSpecSchema,
} from "@cogni-dao/metrics";
import { PostgresMetricObservations } from "@cogni-dao/metrics/adapters/postgres";
import type { Sql } from "postgres";
import { z } from "zod";
import {
	readGithubStars,
	readWorkCount,
} from "@/adapters/server/metrics/sources";
import { getNodeId } from "@/shared/config";

export function createGoalMetrics(deps: {
	knowledgeSql: Sql;
	observationsSql: Sql;
	environment: string;
	log(event: object): void;
}) {
	const registry = new MetricRegistry();
	const budget = {
		timeoutMs: 8000,
		maxSourceCalls: 1,
		maxRows: 1,
		maxResponseBytes: 65536,
	};
	const countParams = z.strictObject({ mode: z.enum(["open", "validated"]) });
	registry.register({
		id: "work.count@1",
		unit: "items",
		paramsSchema: countParams,
		budget,
		compute: async (params, ctx) =>
			ctx.read((signal) =>
				readWorkCount(
					deps.knowledgeSql,
					countParams.parse(params).mode,
					signal,
				),
			),
	});
	const githubParams = z.strictObject({
		owner: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/),
		repo: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
	});
	registry.register({
		id: "github.stars@1",
		unit: "stars",
		paramsSchema: githubParams,
		budget,
		compute: async (params, ctx) => {
			const p = githubParams.parse(params);
			return ctx.read((signal, limits) =>
				readGithubStars(p.owner, p.repo, signal, limits),
			);
		},
	});
	const parse = (row: Record<string, unknown>): MetricDefinition => {
		const spec =
			typeof row.metric_spec === "string"
				? JSON.parse(row.metric_spec)
				: row.metric_spec;
		return {
			id: String(row.id),
			title: String(row.title),
			revision: new Date(row.updated_at as string).toISOString(),
			spec: MetricSpecSchema.parse(spec),
		};
	};
	function literal(id: string) {
		return `'${id.replace(/'/g, "''")}'`;
	}
	const definitions = {
		async get(id: string) {
			const rows = await deps.knowledgeSql.unsafe(
				`SELECT id,title,metric_spec,updated_at FROM knowledge WHERE id=${literal(id)} AND metric_spec IS NOT NULL AND status <> 'deprecated' LIMIT 1`,
			);
			return rows[0] ? parse(rows[0]) : null;
		},
		async list(limit: number, after?: string) {
			const cap = Math.min(50, Math.max(1, Math.floor(limit)));
			const rows = await deps.knowledgeSql.unsafe(
				`SELECT id,title,metric_spec,updated_at FROM knowledge WHERE metric_spec IS NOT NULL AND status <> 'deprecated' ${after ? `AND id > ${literal(after)}` : ""} ORDER BY id LIMIT ${cap + 1}`,
			);
			const items = rows.slice(0, cap).map(parse);
			return {
				items,
				nextCursor: rows.length > cap ? (items.at(-1)?.id ?? null) : null,
			};
		},
	};
	return createMetricService({
		definitions,
		registry,
		observations: new PostgresMetricObservations(deps.observationsSql, {
			node: getNodeId(),
			environment: deps.environment,
			dataScope: "node-members",
		}),
		scope: {
			node: getNodeId(),
			environment: deps.environment,
			dataScope: "node-members",
		},
		now: () => new Date(),
		// These two sources contain node-member metadata or public provider data only.
		// Private connection calculators must supply a current grant check here before registering.
		authorize: async (_action, definition) =>
			["work.count@1", "github.stars@1"].includes(definition.spec.calculatorId),
		log: deps.log,
	});
}
