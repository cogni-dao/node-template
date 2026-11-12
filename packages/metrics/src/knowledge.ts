// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Goal-metric composition over a node's knowledge store. Nodes inject SQL
 * clients, node id, environment, log sink and a knowledge reader; this module
 * owns the calculator set, their budgets and the source permission allow-list.
 */
import type { Sql } from "postgres";
import { z } from "zod";
import { PostgresMetricObservations } from "./adapters/postgres.js";
import { readMetricBudget } from "./adapters/read-budget.js";
import {
	type GoalsProgress,
	type MetricCalculator,
	type MetricDefinition,
	MetricError,
	MetricSpecSchema,
	parseStoredMetricSpec,
} from "./contracts.js";
import {
	createMetricService,
	MetricRegistry,
	type MetricService,
} from "./index.js";
import { type GoalSourcePort, readGoalsProgress } from "./progress.js";
import {
	BRIEF_MAX_BYTES,
	BRIEF_MAX_ROWS,
	FIRST_PARENT_WALK_CAP,
	NO_INLINE_HISTORY_MAX_BYTES,
	NO_INLINE_HISTORY_MAX_ROWS,
	readBriefConformance,
	readGithubStars,
	readNoInlineHistoryEdits,
	readNoInlineHistoryScope,
	readNoInlineHistoryState,
	readWorkConvergence,
	readWorkCount,
	readWorkKpiLinked,
} from "./sources.js";

/**
 * The three knowledge reads goal progress needs. `KnowledgeStorePort` from
 * `@cogni-dao/knowledge-store` satisfies it structurally, so this package
 * carries no knowledge-store dependency.
 */
export interface GoalKnowledgeReader {
	listActiveGoals(signal?: AbortSignal): Promise<
		ReadonlyArray<{
			id: string;
			title: string;
			evaluateAt?: Date | null | undefined;
			kpiBindings?: unknown;
		}>
	>;
	getKnowledge(id: string): Promise<{
		id: string;
		title: string;
		entryType?: string | undefined;
		evaluateAt?: Date | null | undefined;
		kpiBindings?: unknown;
	} | null>;
	listCitationsByCitedId(citedId: string): Promise<
		ReadonlyArray<{
			citingId: string;
			citationType: string;
			createdAt?: Date | undefined;
		}>
	>;
}

/** Calculator ids this package publishes; a node calculator can never reuse one. */
export const PACKAGE_CALCULATOR_IDS = [
	"work.count@1",
	"work.convergence@1",
	"github.stars@1",
	"brief.conformance@1",
	"no-inline-history@1",
] as const;
/** `work.count@1` → `work.count`: the family every version of a calculator shares. */
export function calculatorFamily(id: string): string {
	return id.slice(0, id.lastIndexOf("@"));
}
/** Families the package owns at every version; node calculators use their own names. */
export const RESERVED_CALCULATOR_FAMILIES: ReadonlySet<string> = new Set(
	PACKAGE_CALCULATOR_IDS.map(calculatorFamily),
);

export function createGoalMetrics(deps: {
	knowledgeSql: Sql;
	observationsSql: Sql;
	/** The node id observations are scoped to. */
	node: string;
	environment: string;
	log(event: object): void;
	/**
	 * Node-local calculators over sources only this node owns (its own tables).
	 * They register after the package calculators. A node id may not use a
	 * package family at any version (`reserved_calculator_family`). By injecting
	 * one, the node asserts its sources hold node-member metadata or public data,
	 * the same `node-members` data scope as the package calculators. The node
	 * owns their ids, budgets, evidenceRefs and versions. The service enforces
	 * `timeoutMs` and `maxSourceCalls`; `maxRows` and `maxResponseBytes` are
	 * passed to sources, which must honour them.
	 */
	nodeCalculators?: readonly MetricCalculator[];
}) {
	const registry = new MetricRegistry();
	const scope = {
		node: deps.node,
		environment: deps.environment,
		dataScope: "node-members",
	};
	// One store: convergence edges read heads recorded by earlier readings in it.
	const observations = new PostgresMetricObservations(
		deps.observationsSql,
		scope,
	);
	const budget = {
		timeoutMs: 8000,
		maxSourceCalls: 1,
		maxRows: 1,
		maxResponseBytes: 65536,
	};
	const countParams = z.strictObject({
		mode: z.enum(["open", "validated", "kpi-linked"]),
	});
	registry.register({
		id: "work.count@1",
		unit: "items",
		// `kpi-linked` is the percent of open work items naming a metric in `moves`.
		unitFor: (params) =>
			countParams.parse(params).mode === "kpi-linked" ? "%" : "items",
		display: "volume",
		displayFor: (params) =>
			countParams.parse(params).mode === "kpi-linked" ? "progress" : "volume",
		paramsSchema: countParams,
		budget,
		compute: async (params, ctx) => {
			const { mode } = countParams.parse(params);
			return ctx.read((signal) =>
				mode === "kpi-linked"
					? readWorkKpiLinked(deps.knowledgeSql, signal)
					: readWorkCount(deps.knowledgeSql, mode, signal),
			);
		},
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
		displayFor: (params) =>
			convergenceParams.parse(params).output === "ratio"
				? "progress"
				: "volume",
		windowSeconds: (params) => convergenceParams.parse(params).days * 86400,
		paramsSchema: convergenceParams,
		// Worst case: counts (1) + main head (1) + per edge reflog then recorded
		// head (2 x 2, 1 row each) + first-parent walk (1, <= cap + 1 rows) +
		// dolt_diff (1) = 8 calls; the most rows any one path reads is cap + 5.
		budget: {
			timeoutMs: 8000,
			maxSourceCalls: 8,
			maxRows: FIRST_PARENT_WALK_CAP + 5,
			maxResponseBytes: 1048576,
		},
		compute: async (params, ctx) =>
			readWorkConvergence(
				deps.knowledgeSql,
				convergenceParams.parse(params).output,
				ctx.window,
				(source) => ctx.read((signal) => source(signal)),
				(at, maxGapSeconds, signal) =>
					observations.recordedMainHead(
						"work.convergence@1",
						at,
						maxGapSeconds,
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
		display: "volume",
		paramsSchema: githubParams,
		budget,
		compute: async (params, ctx) => {
			const p = githubParams.parse(params);
			return ctx.read((signal, limits) =>
				readGithubStars(p.owner, p.repo, signal, limits),
			);
		},
	});
	const briefParams = z.strictObject({
		subject: z.enum(["items", "entries"]),
		maxLongShare: z.number().min(0).max(0.5),
	});
	registry.register({
		id: "brief.conformance@1",
		unit: "%",
		display: "progress",
		paramsSchema: briefParams,
		// One statement; it sends at most 5000 rows and 16 MiB or the totals alone.
		budget: {
			timeoutMs: 15000,
			maxSourceCalls: 1,
			maxRows: BRIEF_MAX_ROWS,
			maxResponseBytes: BRIEF_MAX_BYTES,
		},
		compute: async (params, ctx) => {
			const p = briefParams.parse(params);
			return ctx.read((signal) =>
				readBriefConformance(
					deps.knowledgeSql,
					p.subject,
					p.maxLongShare,
					signal,
				),
			);
		},
	});
	const noInlineHistoryParams = z.discriminatedUnion("measure", [
		z.strictObject({
			measure: z.literal("state"),
			subject: z.enum(["work-items", "atoms"]),
		}),
		z.strictObject({
			measure: z.literal("scope"),
			subject: z.literal("work-items"),
		}),
		z.strictObject({
			measure: z.literal("edits"),
			output: z.enum(["share", "count"]),
			days: z.number().int().min(1).max(28),
		}),
	]);
	registry.register({
		id: "no-inline-history@1",
		// State and scope read main now; only the edits interval has a width.
		unit: "%",
		unitFor: (params) => {
			const p = noInlineHistoryParams.parse(params);
			if (p.measure === "state") return "%";
			if (p.measure === "scope") return "items";
			return p.output === "share" ? "%" : "edits";
		},
		displayFor: (params) => {
			const p = noInlineHistoryParams.parse(params);
			if (p.measure === "scope") return "volume";
			return p.measure === "edits" && p.output === "count"
				? "volume"
				: "progress";
		},
		windowSeconds: (params) => {
			const p = noInlineHistoryParams.parse(params);
			return p.measure === "edits" ? p.days * 86400 : 0;
		},
		paramsSchema: noInlineHistoryParams,
		// State and scope make one call; edits make three (the window's commits,
		// work items, atoms). Rows and bytes cap each statement; the service
		// enforces the call count.
		budget: {
			timeoutMs: 15000,
			maxSourceCalls: 3,
			maxRows: NO_INLINE_HISTORY_MAX_ROWS,
			maxResponseBytes: NO_INLINE_HISTORY_MAX_BYTES,
		},
		compute: async (params, ctx) => {
			const p = noInlineHistoryParams.parse(params);
			if (p.measure === "state")
				return ctx.read((signal) =>
					readNoInlineHistoryState(deps.knowledgeSql, p.subject, signal),
				);
			if (p.measure === "scope")
				return ctx.read((signal) =>
					readNoInlineHistoryScope(deps.knowledgeSql, signal),
				);
			return readNoInlineHistoryEdits(
				deps.knowledgeSql,
				p.output,
				ctx.window,
				(source) => ctx.read((signal) => source(signal)),
				ctx.editsTiming,
			);
		},
	});
	const nodeCalculatorIds: string[] = [];
	for (const calculator of deps.nodeCalculators ?? []) {
		// A definition can only name an id the spec schema accepts.
		if (!MetricSpecSchema.shape.calculatorId.safeParse(calculator.id).success)
			throw new MetricError("invalid_calculator_id", 422);
		// Every version of a published family belongs to the package.
		if (RESERVED_CALCULATOR_FAMILIES.has(calculatorFamily(calculator.id)))
			throw new MetricError("reserved_calculator_family", 422);
		registry.register(calculator);
		nodeCalculatorIds.push(calculator.id);
	}
	const allowed = new Set<string>([
		...PACKAGE_CALCULATOR_IDS,
		...nodeCalculatorIds,
	]);
	/**
	 * One malformed reviewed row must not stop every other metric: skip it and log.
	 * Only an invalid core spec skips; a bad `serves`/`band` is carried as `annexInvalid`.
	 */
	const parse = (row: Record<string, unknown>): MetricDefinition | null => {
		try {
			const { spec, display, serves, band, invalid } = parseStoredMetricSpec(
				typeof row.metric_spec === "string"
					? JSON.parse(row.metric_spec)
					: row.metric_spec,
			);
			return {
				id: String(row.id),
				title: String(row.title),
				revision: new Date(row.updated_at as string).toISOString(),
				spec,
				...(display ? { display } : {}),
				...(serves ? { serves } : {}),
				...(band ? { band } : {}),
				...(invalid.length ? { annexInvalid: invalid } : {}),
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
		async getMany(ids: readonly string[], signal?: AbortSignal) {
			if (!ids.length) return [];
			if (ids.length > 300) throw new MetricError("too_many_metrics", 400);
			// Doltgres rejects SET LOCAL. Use pooled read admission, retaining the
			// permit until native settlement even after the caller abandons it.
			// PostgreSQL observations keep their native statement timeout.
			const rows = await readMetricBudget(
				deps.knowledgeSql,
				signal,
				(bounded) => {
					bounded.throwIfAborted();
					return deps.knowledgeSql.unsafe(
						`SELECT id,title,metric_spec,updated_at FROM knowledge WHERE id IN (${ids.map(literal).join(",")}) AND metric_spec IS NOT NULL AND status <> 'deprecated'`,
					);
				},
			).catch((error: unknown) => {
				const code = (error as { code?: unknown } | null)?.code;
				deps.log({
					event: "metric.definition_batch_failed",
					phase: "definitions_read",
					errorCode:
						typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)
							? code
							: "unknown",
				});
				throw error;
			});
			return rows
				.map(parse)
				.filter((item): item is MetricDefinition => item !== null);
		},
		async get(id: string) {
			const rows = await deps.knowledgeSql.unsafe(
				`SELECT id,title,metric_spec,updated_at FROM knowledge WHERE id=${literal(id)} AND metric_spec IS NOT NULL AND status <> 'deprecated' LIMIT 1`,
			);
			return rows[0] ? parse(rows[0]) : null;
		},
		async list(limit: number, after?: string, signal?: AbortSignal) {
			const cap = Math.min(50, Math.max(1, Math.floor(limit)));
			const items: MetricDefinition[] = [];
			let cursor = after;
			let more = true;
			// Invalid rows are skipped, so keep reading until the page is full; the
			// cursor advances past every examined row so refresh never stalls on one.
			for (let pass = 0; pass < 20 && more && items.length < cap; pass++) {
				signal?.throwIfAborted();
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
		observations,
		scope,
		now: () => new Date(),
		// These sources contain node-member metadata or public provider data only.
		// Private connection calculators must supply a current grant check here before registering.
		authorize: async (_action, definition) =>
			allowed.has(definition.spec.calculatorId),
		log: deps.log,
	});
}

/** Goals and hypotheses stay knowledge entries; the shared read model only sees this port. */
export function createGoalSource(
	port: GoalKnowledgeReader,
	signal?: AbortSignal,
): GoalSourcePort {
	const read = async <T>(query: () => Promise<T>): Promise<T> => {
		signal?.throwIfAborted();
		const result = await query();
		signal?.throwIfAborted();
		return result;
	};
	type Dated = { createdAt?: Date | undefined };
	const newest = (a: Dated, b: Dated) =>
		(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
	return {
		async listGoals() {
			const goals = await read(() => port.listActiveGoals(signal));
			const items = [];
			for (const goal of goals) {
				// Current stores project bindings with the canonical active-goal list.
				// Older injected readers keep the existing direct-body fallback.
				const bindings =
					goal.kpiBindings !== undefined
						? goal.kpiBindings
						: (await read(() => port.getKnowledge(goal.id)))?.kpiBindings;
				items.push({
					id: goal.id,
					title: goal.title,
					evaluateAt: goal.evaluateAt?.toISOString() ?? null,
					kpiBindings: bindings ?? [],
				});
			}
			return items;
		},
		async hypotheses(goalId) {
			const ids = [
				...new Set(
					(await read(() => port.listCitationsByCitedId(goalId)))
						.filter((e) => e.citationType === "extends")
						.sort(newest)
						.map((e) => e.citingId),
				),
			];
			const items = [];
			// At most ten source bodies per goal; `more` admits the truncation.
			for (const id of ids.slice(0, 10)) {
				const bet = await read(() => port.getKnowledge(id));
				if (bet?.entryType !== "hypothesis") continue;
				const outcomeEdge = (await read(() => port.listCitationsByCitedId(id)))
					.filter(
						(e) =>
							e.citationType === "validates" ||
							e.citationType === "invalidates",
					)
					.sort(newest)[0];
				const outcome = outcomeEdge
					? await read(() => port.getKnowledge(outcomeEdge.citingId))
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

/** How long one shared goal-progress read may run before it is abandoned. */
const GOAL_READ_DEADLINE_MS = 8000;
/** With a last good result in hand, how long a caller waits for the fresh read. */
const GOAL_READ_CALLER_WAIT_MS = 2500;
/** The oldest last good result a caller may be served instead of a fresh read. */
const GOAL_READ_MAX_STALE_MS = 10 * 60_000;

/**
 * A node's ONE goal-progress function; HTTP, SSR and agent tools all call it.
 *
 * Callers share one in-flight read, and that read is not aborted when a caller
 * stops waiting: a read that needs more than the old 2.5 s (bug.0035: production
 * reads sat at 1-2.5 s and, once the store was busy, every caller aborted and
 * restarted the read, so none ever finished) runs to its own deadline and its
 * result serves the callers that joined it. A complete result is kept as the
 * last good one. While one exists and is under ten minutes old, a caller waits
 * 2.5 s for the fresh read, then gets the last good result rather than a
 * failure; so does a caller whose fresh read failed or completed degraded.
 * That body carries `stale: {reason, ageSeconds}`; a fresh read never does. A
 * caller with nothing to serve waits for the read, up to its deadline, then
 * gets a retryable 503. A result with an unavailable annex or hypothesis is
 * never kept.
 */
export function createGoalProgressReader(deps: {
	metrics: () => MetricService | undefined;
	knowledge: () => GoalKnowledgeReader | undefined;
	environment: string;
	/** Explicitly pooled read-only knowledge port; reserved scopes stay serial. */
	pooledGoalReads?: boolean;
}): () => Promise<GoalsProgress> {
	let inFlight: Promise<GoalsProgress> | undefined;
	let lastGood:
		| {
				value: GoalsProgress;
				at: number;
				/** The definitions the read that produced it was authorized to list. */
				definitions: readonly MetricDefinition[];
		  }
		| undefined;
	const degraded = (value: GoalsProgress) =>
		!!value.servedUnavailable ||
		value.goals.some((g) => g.hypothesesUnavailable);
	const start = (): Promise<GoalsProgress> => {
		let definitions: readonly MetricDefinition[] = [];
		const run = async () => {
			const port = deps.knowledge();
			if (!port) throw new MetricError("goals_unavailable", 503);
			return readMetricBudget(
				port,
				undefined,
				(signal) =>
					readGoalsProgress({
						goals: createGoalSource(port, signal),
						pooledGoalReads: deps.pooledGoalReads,
						metrics: deps.metrics(),
						environment: deps.environment,
						signal,
						authorized: (list) => {
							definitions = list;
						},
					}),
				GOAL_READ_DEADLINE_MS,
			);
		};
		const pending = run()
			.then((value) => {
				if (!degraded(value))
					lastGood = { value, at: Date.now(), definitions };
				return value;
			})
			.finally(() => {
				if (inFlight === pending) inFlight = undefined;
			});
		inFlight = pending;
		return pending;
	};
	/** Whether every metric a last good result lists is still readable. */
	const readable = async (kept: NonNullable<typeof lastGood>) => {
		const metrics = deps.metrics();
		try {
			const each = await Promise.all(
				kept.definitions.map((d) => metrics?.canRead(d) ?? false),
			);
			return each.every(Boolean);
		} catch {
			return false;
		}
	};
	return () => {
		const pending = inFlight ?? start();
		const kept = lastGood;
		if (!kept || Date.now() - kept.at > GOAL_READ_MAX_STALE_MS) return pending;
		return serve(pending, kept);
	};
	async function serve(
		pending: Promise<GoalsProgress>,
		kept: NonNullable<typeof lastGood>,
	): Promise<GoalsProgress> {
		// A metric no longer readable voids the last good result: wait for the fresh read.
		if (!(await readable(kept))) return pending;
		// The last good result, marked with why it was served and how old it is.
		const stale = (
			reason: NonNullable<GoalsProgress["stale"]>["reason"],
		): GoalsProgress => ({
			...kept.value,
			stale: {
				reason,
				ageSeconds: Math.max(
					0,
					Math.floor((Date.now() - Date.parse(kept.value.asOf)) / 1000),
				),
			},
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = new Promise<GoalsProgress>((resolve) => {
			timer = setTimeout(
				() => resolve(stale("fresh_read_slow")),
				GOAL_READ_CALLER_WAIT_MS,
			);
		});
		return Promise.race([
			pending.then(
				(fresh) => (degraded(fresh) ? stale("fresh_read_degraded") : fresh),
				() => stale("fresh_read_failed"),
			),
			waited,
		]).finally(() => clearTimeout(timer));
	}
}
