// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Node composition. Mission calculators and source permissions stay here, outside the published engine. */
import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import {
	createMetricService,
	type GoalSourcePort,
	type GoalsProgress,
	type MetricDefinition,
	MetricError,
	MetricRegistry,
	type MetricService,
	MetricSpecSchema,
	readGoalsProgress,
} from "@cogni-dao/metrics";
import { PostgresMetricObservations } from "@cogni-dao/metrics/adapters/postgres";
import type { Sql } from "postgres";
import { z } from "zod";
import {
	FIRST_PARENT_WALK_CAP,
	readGithubStars,
	readWorkConvergence,
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
	const convergenceParams = z.strictObject({
		output: z.enum(["ratio", "validated", "created"]),
		days: z.number().int().min(1).max(28),
	});
	registry.register({
		id: "work.convergence@1",
		// Window edges are event times inside [end - days, end); scheduled runs measure the slot.
		historicalWindows: true,
		unit: "ratio",
		unitFor: (params) =>
			convergenceParams.parse(params).output === "ratio" ? "ratio" : "items",
		windowSeconds: (params) => convergenceParams.parse(params).days * 86400,
		paramsSchema: convergenceParams,
		// Counts (1) + reflog edges (2) + fallback first-parent walk (1, <= cap + 1 rows) + dolt_diff (1).
		budget: {
			timeoutMs: 8000,
			maxSourceCalls: 5,
			maxRows: FIRST_PARENT_WALK_CAP + 3,
			maxResponseBytes: 1048576,
		},
		compute: async (params, ctx) =>
			readWorkConvergence(
				deps.knowledgeSql,
				convergenceParams.parse(params).output,
				ctx.window,
				(source) => ctx.read((signal) => source(signal)),
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
	/** One malformed reviewed row must not stop every other metric: skip it and log. */
	const parse = (row: Record<string, unknown>): MetricDefinition | null => {
		try {
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
		} catch {
			deps.log({
				event: "metric.definition_invalid",
				metricId: String(row.id),
			});
			return null;
		}
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
			const items: MetricDefinition[] = [];
			let cursor = after;
			let more = true;
			// Invalid rows are skipped, so keep reading until the page is full; the
			// cursor advances past every examined row so refresh never stalls on one.
			for (let pass = 0; pass < 20 && more && items.length < cap; pass++) {
				const need = cap - items.length;
				const rows = await deps.knowledgeSql.unsafe(
					`SELECT id,title,metric_spec,updated_at FROM knowledge WHERE metric_spec IS NOT NULL AND status <> 'deprecated' ${cursor ? `AND id > ${literal(cursor)}` : ""} ORDER BY id LIMIT ${need + 1}`,
				);
				more = rows.length > need;
				for (const row of rows.slice(0, need)) {
					cursor = String(row.id);
					const definition = parse(row);
					if (definition) items.push(definition);
				}
			}
			return { items, nextCursor: more ? (cursor ?? null) : null };
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
		// These sources contain node-member metadata or public provider data only.
		// Private connection calculators must supply a current grant check here before registering.
		authorize: async (_action, definition) =>
			["work.count@1", "work.convergence@1", "github.stars@1"].includes(
				definition.spec.calculatorId,
			),
		log: deps.log,
	});
}

/** Goals and hypotheses stay knowledge entries; the shared read model only sees this port. */
export function createGoalSource(port: KnowledgeStorePort): GoalSourcePort {
	type Dated = { createdAt?: Date | undefined };
	const newest = (a: Dated, b: Dated) =>
		(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
	return {
		async listGoals() {
			const goals = await port.listActiveGoals();
			const items = [];
			for (const goal of goals) {
				const row = await port.getKnowledge(goal.id);
				items.push({
					id: goal.id,
					title: goal.title,
					evaluateAt: goal.evaluateAt?.toISOString() ?? null,
					kpiBindings: row?.kpiBindings ?? [],
				});
			}
			return items;
		},
		async hypotheses(goalId) {
			const ids = [
				...new Set(
					(await port.listCitationsByCitedId(goalId))
						.filter((e) => e.citationType === "extends")
						.sort(newest)
						.map((e) => e.citingId),
				),
			];
			const items = [];
			// At most ten source bodies per goal; `more` admits the truncation.
			for (const id of ids.slice(0, 10)) {
				const bet = await port.getKnowledge(id);
				if (bet?.entryType !== "hypothesis") continue;
				const outcomeEdge = (await port.listCitationsByCitedId(id))
					.filter(
						(e) =>
							e.citationType === "validates" ||
							e.citationType === "invalidates",
					)
					.sort(newest)[0];
				const outcome = outcomeEdge
					? await port.getKnowledge(outcomeEdge.citingId)
					: null;
				items.push({
					id: bet.id,
					title: bet.title,
					evaluateAt: bet.evaluateAt?.toISOString() ?? null,
					kpiBindings: bet.kpiBindings ?? [],
					outcome:
						outcome && outcomeEdge
							? {
									id: outcome.id,
									title: outcome.title,
									supports: outcomeEdge.citationType === "validates",
								}
							: null,
				});
			}
			return { items, more: ids.length > 10 };
		},
	};
}

/** The node's ONE goal-progress function; HTTP, SSR and agent tools all call it. */
export function createGoalProgressReader(deps: {
	metrics: () => MetricService | undefined;
	knowledge: () => KnowledgeStorePort | undefined;
	environment: string;
}): () => Promise<GoalsProgress> {
	return async () => {
		const port = deps.knowledge();
		if (!port) throw new MetricError("goals_unavailable", 503);
		return readGoalsProgress({
			goals: createGoalSource(port),
			metrics: deps.metrics(),
			environment: deps.environment,
		});
	};
}
