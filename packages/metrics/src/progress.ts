// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * One goal-progress read model for the Goals tab, HTTP and agent tools. Nodes
 * inject where goals and hypotheses live; thresholds never write verdicts.
 */
import { assessKpi } from "./assess.js";
import {
	type GoalProgress,
	type GoalsProgress,
	GoalsProgressSchema,
	type KpiBinding,
	KpiBindingsSchema,
	type KpiReason,
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
			firstGood: null,
			daily: [],
			now: at,
		});
	const items: GoalProgress[] = [];
	for (const goal of await deps.goals.listGoals()) {
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
			kpis.push({
				binding,
				metric: r.metric,
				assessment: r.assessment,
				trend: r.trend,
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
	return GoalsProgressSchema.parse({
		goals: items,
		asOf: at.toISOString(),
		environment: deps.environment,
	});
}
