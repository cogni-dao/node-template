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
	const goals = await deps.goals.listGoals();
	// Metrics that declare `serves`, read once for every goal; absent without metrics.
	// The served annex never fails the goal read: an outage degrades it to unavailable.
	let serving: Awaited<ReturnType<MetricService["serving"]>> | null = null;
	let servedUnavailable: string | null = null;
	if (deps.metrics) {
		try {
			serving = await deps.metrics.serving();
		} catch (e) {
			servedUnavailable = e instanceof MetricError ? e.code : "source_failed";
		}
	}
	const boundKpis = new Set<string>();
	for (const goal of goals)
		for (const b of parseBindings(goal.kpiBindings).bindings)
			boundKpis.add(b.metricId);
	// KPIs a goal binds; `boundKpis` adds the ones only a bet binds, below.
	const goalKpis = new Set(boundKpis);
	// Bets not all read: a metric bound only by an unseen bet could read as unbound.
	let betsIncomplete = false;
	for (const goal of goals) {
		const configured = parseBindings(goal.kpiBindings);
		const kpis: GoalProgress["kpis"] = [];
		for (const binding of configured.bindings) {
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
			const r = await deps.metrics.kpi(binding, { deadline: goal.evaluateAt });
			const served: ServedMetric[] = (serving?.items ?? [])
				.filter((x) => x.definition.serves?.kpi === binding.metricId)
				.map((x) => ({
					metric: {
						id: x.definition.id,
						title: x.definition.title,
						calculatorId: x.definition.spec.calculatorId,
						// The filter above guarantees `serves`.
						role: (x.definition.serves as NonNullable<typeof x.definition.serves>)
							.role,
					},
					assessment: x.assessment,
					latest: x.latest,
				}));
			kpis.push({
				binding,
				metric: r.metric,
				assessment: r.assessment,
				trend: r.trend,
				...(r.recent ? { recent: r.recent } : {}),
				...(served.length ? { served } : {}),
			});
		}
		const hypotheses: GoalProgress["hypotheses"] = [];
		let moreHypotheses = false;
		let hypothesesUnavailable = false;
		try {
			const page = await deps.goals.hypotheses(goal.id);
			moreHypotheses = page.more;
			if (page.more) betsIncomplete = true;
			for (const bet of page.items) {
				const predictions = [];
				for (const binding of parseBindings(bet.kpiBindings).bindings) {
					// A hypothesis prediction is a valid KPI target for `serves`.
					boundKpis.add(binding.metricId);
					if (!deps.metrics) {
						predictions.push({
							binding,
							baselineValue: null,
							baselineAt: null,
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
						hypothesis: true,
					});
					predictions.push({
						binding,
						baselineValue:
							r.baseline?.status === "ok" ? r.baseline.value : null,
						baselineAt:
							r.baseline?.status === "ok" ? r.baseline.window.end : null,
						assessment: r.assessment,
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
			hypothesesUnavailable = true;
			betsIncomplete = true;
		}
		items.push({
			id: goal.id,
			title: goal.title,
			evaluateAt: goal.evaluateAt,
			configurationError: configured.invalid,
			kpis,
			hypotheses,
			moreHypotheses,
			hypothesesUnavailable,
		});
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
					servedTruncated: serving.truncated || betsIncomplete,
				}
			: {}),
		...(servedUnavailable ? { servedUnavailable } : {}),
	});
}
