// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * One goal-progress read model for the Goals and Metrics views, HTTP and agent tools. Nodes
 * inject where goals and hypotheses live; thresholds never write verdicts.
 * Invariants: SERVED_BY_TYPED_LINK (a KPI lists the registered metrics whose
 * `serves.kpi` names it, joined at read time from the stored spec, never from a
 * citation table); LATEST_ONLY (a served metric adds one band assessment from
 * its latest reading: no trend, no history query, at most SERVES_SCAN_MAX
 * definitions scanned, a cut reported as `servedTruncated`); ORPHAN_NOT_HIDDEN
 * (a metric whose `serves.kpi` no goal KPI binds (a bet-only KPI is `serves_bet_kpi`), or whose `serves`/`band` is
 * invalid, is listed in `orphans` with its assessment and the zod issue paths);
 * SERVED_NEVER_FAILS_READ (a serving() failure, for example an authority
 * outage, leaves `served`/`orphans`/`unbound` absent and sets `servedUnavailable`);
 * UNBOUND_LISTED (a metric with no `serves` that no goal binds as a KPI is listed in `unbound`, so the Metrics page
 * and agents see every metric once; story.0039).
 */
import { assessKpi } from "./assess.js";
import {
	type GoalProgress,
	type GoalsProgress,
	GoalsProgressSchema,
	type KpiBinding,
	KpiBindingsSchema,
	type KpiReason,
	MetricError,
	type MetricOrphan,
	type ServedMetric,
} from "./contracts.js";
import type { MetricService } from "./index.js";

export interface GoalSubject {
	id: string;
	title: string;
	evaluateAt: string | null;
	/** Raw stored bindings; invalid configuration is reported, never guessed. */
	kpiBindings: unknown;
}
export interface GoalSourcePort {
	/** The canonical complete active-goal list. */
	listGoals(): Promise<GoalSubject[]>;
	/** A bounded preview of hypotheses extending one goal; `more` admits truncation. */
	hypotheses(goalId: string): Promise<{
		items: Array<
			GoalSubject & {
				outcome: { id: string; title: string; supports: boolean } | null;
			}
		>;
		more: boolean;
	}>;
}

function parseBindings(raw: unknown): {
	bindings: KpiBinding[];
	invalid: boolean;
} {
	const parsed = KpiBindingsSchema.safeParse(raw ?? []);
	return parsed.success
		? { bindings: parsed.data, invalid: false }
		: { bindings: [], invalid: true };
}

export async function readGoalsProgress(deps: {
	goals: GoalSourcePort;
	metrics: MetricService | undefined;
	environment: string;
	now?: () => Date;
	signal?: AbortSignal;
	/** Opt in only for pooled read ports, never a reserved write connection. */
	pooledGoalReads?: boolean;
}): Promise<GoalsProgress> {
	const now = deps.now ?? deps.metrics?.now ?? (() => new Date());
	const at = now();
	const unmeasured = (
		binding: KpiBinding,
		deadline: string | null,
		reason: KpiReason,
	) =>
		assessKpi({
			binding,
			metric: null,
			unavailable: reason,
			latestAttempt: null,
			lastGood: null,
			viewState: "unavailable",
			deadline: binding.evaluationAt ?? deadline,
			evaluation: null,
			daily: [],
			now: at,
		});
	const items: GoalProgress[] = [];
	// Metrics that declare `serves`, read once for every goal; absent without metrics.
	// The served annex never fails the goal read: an outage degrades it to unavailable.
	let serving: Awaited<ReturnType<MetricService["serving"]>> | null = null;
	let servedUnavailable: string | null = null;
	deps.signal?.throwIfAborted();
	// Only pooled ports may overlap independent reads; retain both until settled.
	const readServing = () =>
		deps.metrics?.serving(deps.signal) ?? Promise.resolve(null);
	let goalRead: PromiseSettledResult<GoalSubject[]>;
	let servedRead: PromiseSettledResult<Awaited<ReturnType<typeof readServing>>>;
	if (deps.pooledGoalReads) {
		[goalRead, servedRead] = await Promise.allSettled([
			deps.goals.listGoals(),
			readServing(),
		]);
	} else {
		[goalRead] = await Promise.allSettled([deps.goals.listGoals()]);
		if (goalRead.status === "rejected") throw goalRead.reason;
		deps.signal?.throwIfAborted();
		[servedRead] = await Promise.allSettled([readServing()]);
	}
	if (goalRead.status === "rejected") throw goalRead.reason;
	const goals = goalRead.value;
	if (servedRead.status === "fulfilled") serving = servedRead.value;
	else {
		const e = servedRead.reason;
		servedUnavailable = e instanceof MetricError ? e.code : "source_failed";
	}
	deps.signal?.throwIfAborted();
	const boundKpis = new Set<string>();
	for (const goal of goals)
		for (const b of parseBindings(goal.kpiBindings).bindings)
			boundKpis.add(b.metricId);
	// KPIs a goal binds; `boundKpis` adds the ones only a bet binds, below.
	const goalKpis = new Set(boundKpis);
	const readGoal = async (goal: GoalSubject): Promise<GoalProgress> => {
		deps.signal?.throwIfAborted();
		const configured = parseBindings(goal.kpiBindings);
		const kpis: GoalProgress["kpis"] = [];
		for (const binding of configured.bindings) {
			deps.signal?.throwIfAborted();
			if (!deps.metrics) {
				kpis.push({
					binding,
					metric: null,
					assessment: unmeasured(
						binding,
						goal.evaluateAt,
						"metric_unavailable",
					),
					trend: null,
				});
				continue;
			}
			const r = serving?.readKpi
				? await serving.readKpi(binding, {
						deadline: goal.evaluateAt,
						signal: deps.signal,
					})
				: await deps.metrics.kpi(binding, {
						deadline: goal.evaluateAt,
						signal: deps.signal,
					});
			const served: ServedMetric[] = (serving?.items ?? [])
				.filter((x) => x.definition.serves?.kpi === binding.metricId)
				.map((x) => ({
					metric: {
						id: x.definition.id,
						title: x.definition.title,
						calculatorId: x.definition.spec.calculatorId,
						// The filter above guarantees `serves`.
						role: (
							x.definition.serves as NonNullable<typeof x.definition.serves>
						).role,
					},
					assessment: x.assessment,
					latest: x.latest,
				}));
			kpis.push({
				binding,
				metric: r.metric,
				assessment: r.assessment,
				viewState: r.viewState,
				trend: r.trend,
				...(r.recent ? { recent: r.recent } : {}),
				...(served.length ? { served } : {}),
			});
		}
		const hypotheses: GoalProgress["hypotheses"] = [];
		let moreHypotheses = false;
		let hypothesesUnavailable = false;
		try {
			deps.signal?.throwIfAborted();
			const page = await deps.goals.hypotheses(goal.id);
			moreHypotheses = page.more;
			for (const bet of page.items) {
				const predictions = [];
				for (const binding of parseBindings(bet.kpiBindings).bindings) {
					deps.signal?.throwIfAborted();
					// A hypothesis prediction is a valid KPI target for `serves`.
					boundKpis.add(binding.metricId);
					if (!deps.metrics) {
						predictions.push({
							binding,
							baselineValue: null,
							baselineAt: null,
							viewState: "unavailable" as const,
							assessment: unmeasured(
								binding,
								bet.evaluateAt,
								"metric_unavailable",
							),
						});
						continue;
					}
					const r = await deps.metrics.kpi(binding, {
						deadline: bet.evaluateAt,
						signal: deps.signal,
						hypothesis: true,
					});
					predictions.push({
						binding,
						baselineValue:
							r.baseline?.status === "ok" ? r.baseline.value : null,
						baselineAt:
							r.baseline?.status === "ok" ? r.baseline.window.end : null,
						assessment: r.assessment,
						viewState: r.viewState,
					});
				}
				hypotheses.push({
					id: bet.id,
					title: bet.title,
					evaluateAt: bet.evaluateAt,
					predictions,
					outcome: bet.outcome,
				});
			}
		} catch {
			deps.signal?.throwIfAborted();
			hypothesesUnavailable = true;
		}
		return {
			id: goal.id,
			title: goal.title,
			evaluateAt: goal.evaluateAt,
			configurationError: configured.invalid,
			kpis,
			hypotheses,
			moreHypotheses,
			hypothesesUnavailable,
		};
	};
	// At most two goals own reads concurrently, regardless of list size. Each
	// retains its KPI order and full hypothesis output. Wait for failed siblings
	// before releasing the outer native-read admission permit.
	const width = deps.pooledGoalReads ? 2 : 1;
	for (let offset = 0; offset < goals.length; offset += width) {
		deps.signal?.throwIfAborted();
		const settled = await Promise.allSettled(
			goals.slice(offset, offset + width).map(readGoal),
		);
		for (const result of settled) {
			if (result.status === "rejected") throw result.reason;
			items.push(result.value);
		}
	}
	// A metric serving a KPI no goal binds stays visible and assessed: absent is red.
	const orphans: MetricOrphan[] = [];
	for (const x of serving?.items ?? []) {
		const { serves, annexInvalid } = x.definition;
		if (serves && !goalKpis.has(serves.kpi))
			orphans.push({
				metricId: x.definition.id,
				title: x.definition.title,
				kpi: serves.kpi,
				// A bet's KPI is a valid target, but no goal card lists the metric.
				reason: boundKpis.has(serves.kpi)
					? "serves_bet_kpi"
					: "serves_unknown_kpi",
				assessment: x.assessment,
				latest: x.latest,
			});
		for (const bad of annexInvalid ?? [])
			orphans.push({
				metricId: x.definition.id,
				title: x.definition.title,
				kpi: serves?.kpi ?? null,
				reason: bad.field === "serves" ? "serves_invalid" : "band_invalid",
				issues: bad.issues,
				assessment: x.assessment,
				latest: x.latest,
			});
	}
	deps.signal?.throwIfAborted();
	return GoalsProgressSchema.parse({
		goals: items,
		asOf: at.toISOString(),
		environment: deps.environment,
		...(serving
			? {
					orphans,
					// A goal's KPI metric is the KPI, not bloat. A bet-only KPI metric serves no goal KPI, so it is listed.
					unbound: serving.unbound
						.filter((x) => !goalKpis.has(x.definition.id))
						.map((x) => ({
							metric: {
								id: x.definition.id,
								title: x.definition.title,
								calculatorId: x.definition.spec.calculatorId,
							},
							assessment: x.assessment,
							latest: x.latest,
						})),
					servedTruncated: serving.truncated,
				}
			: {}),
		...(servedUnavailable ? { servedUnavailable } : {}),
	});
}
