// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * One goal-progress read model for the Goals tab, HTTP and agent tools. Nodes
 * inject where goals and hypotheses live; thresholds never write verdicts.
 * Invariants: SERVED_BY_TYPED_LINK (a KPI lists the registered metrics whose
 * `serves.kpi` names it, joined at read time from the stored spec, never from a
 * citation table); LATEST_ONLY (a served metric adds one band assessment from
 * its latest reading: no trend, no history query, at most SERVES_SCAN_MAX
 * definitions scanned, a cut reported as `servedTruncated`); ORPHAN_NOT_HIDDEN
 * (a metric whose `serves.kpi` no goal binds is listed in `orphans` with its
 * assessment).
 */
import { assessKpi } from "./assess.js";
import {
	type GoalProgress,
	type GoalsProgress,
	GoalsProgressSchema,
	type KpiBinding,
	KpiBindingsSchema,
	type KpiReason,
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
	const serving = deps.metrics ? await deps.metrics.serving() : null;
	const boundKpis = new Set<string>();
	for (const goal of goals)
		for (const b of parseBindings(goal.kpiBindings).bindings)
			boundKpis.add(b.metricId);
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
			for (const bet of page.items) {
				const predictions = [];
				for (const binding of parseBindings(bet.kpiBindings).bindings) {
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
	const orphans: MetricOrphan[] = (serving?.items ?? [])
		.filter((x) => x.definition.serves && !boundKpis.has(x.definition.serves.kpi))
		.map((x) => ({
			metricId: x.definition.id,
			kpi: (x.definition.serves as NonNullable<typeof x.definition.serves>).kpi,
			reason: "serves_unknown_kpi" as const,
			assessment: x.assessment,
		}));
	return GoalsProgressSchema.parse({
		goals: items,
		asOf: at.toISOString(),
		environment: deps.environment,
		...(serving ? { orphans, servedTruncated: serving.truncated } : {}),
	});
}
