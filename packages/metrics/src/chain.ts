// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * The metric → KPI → goal chain of a metric, for one work item read (task.0118).
 * Invariants: CHEAP_READS_ONLY (one active-goals read, one definitions read, a second only to
 * title a KPI the moved metric serves, and one latest-only assessment per distinct KPI: never the
 * goal progress read, no trend and no history range); CHAIN_NEVER_GUESSED (an id with no readable
 * definition is absent from the result; a KPI no active goal binds yields no `kpi` or `goal`);
 * STATUS_ONLY_WHEN_READ (a KPI assessment that errored leaves `status` absent, never a guess).
 */
import { type KpiBinding, KpiBindingsSchema } from "./contracts.js";
import type { MetricService, MetricSummary } from "./index.js";
import type { GoalSourcePort } from "./progress.js";

/** One metric with the goal KPI it moves or serves. */
export interface MetricChain {
	metric: Pick<MetricSummary, "id" | "title" | "unit" | "display">;
	kpi?: {
		metricId: string;
		title: string;
		comparator: KpiBinding["comparator"];
		target: KpiBinding["target"];
		status?: string;
	};
	goal?: { id: string; title: string };
}

export async function readMetricChains(deps: {
	metrics: Pick<MetricService, "describe" | "kpi">;
	goals: Pick<GoalSourcePort, "listGoals">;
	metricIds: readonly string[];
	signal?: AbortSignal;
}): Promise<Map<string, MetricChain>> {
	const result = new Map<string, MetricChain>();
	const ids = [...new Set(deps.metricIds)];
	if (!ids.length) return result;
	const { signal } = deps;
	const [goals, found] = await Promise.all([
		deps.goals.listGoals(),
		deps.metrics.describe(ids, signal),
	]);
	signal?.throwIfAborted();
	// The first active goal that binds a KPI owns it; invalid bindings are ignored here.
	const owners = new Map<
		string,
		{
			goal: { id: string; title: string; evaluateAt: string | null };
			binding: KpiBinding;
		}
	>();
	for (const goal of goals) {
		const parsed = KpiBindingsSchema.safeParse(goal.kpiBindings ?? []);
		if (!parsed.success) continue;
		for (const binding of parsed.data)
			if (!owners.has(binding.metricId))
				owners.set(binding.metricId, {
					goal: { id: goal.id, title: goal.title, evaluateAt: goal.evaluateAt },
					binding,
				});
	}
	const summaries = new Map(found.map((summary) => [summary.id, summary]));
	const kpiOf = (summary: MetricSummary): string | undefined =>
		owners.has(summary.id)
			? summary.id
			: summary.serves && owners.has(summary.serves.kpi)
				? summary.serves.kpi
				: undefined;
	// Title a served KPI with its own definition: one more read, only for KPIs not yet read.
	const missing = [
		...new Set(
			found
				.map(kpiOf)
				.filter((id): id is string => id !== undefined && !summaries.has(id)),
		),
	];
	if (missing.length)
		for (const summary of await deps.metrics.describe(missing, signal))
			summaries.set(summary.id, summary);
	signal?.throwIfAborted();
	const kpiIds = [
		...new Set(found.map(kpiOf).filter((id): id is string => !!id)),
	].filter((id) => summaries.has(id));
	const statuses = new Map<string, string>();
	await Promise.all(
		kpiIds.map(async (id) => {
			const owner = owners.get(id);
			if (!owner) return;
			try {
				const read = await deps.metrics.kpi(owner.binding, {
					deadline: owner.goal.evaluateAt,
					latestOnly: true,
					...(signal ? { signal } : {}),
				});
				if (read.viewState !== "error") statuses.set(id, read.assessment.status);
			} catch {
				// A failed assessment leaves the KPI without a status.
			}
		}),
	);
	for (const summary of found) {
		const metric = {
			id: summary.id,
			title: summary.title,
			unit: summary.unit,
			...(summary.display ? { display: summary.display } : {}),
		};
		const kpiId = kpiOf(summary);
		const kpiSummary = kpiId ? summaries.get(kpiId) : undefined;
		const owner = kpiId ? owners.get(kpiId) : undefined;
		if (!kpiId || !kpiSummary || !owner) {
			result.set(summary.id, { metric });
			continue;
		}
		const status = statuses.get(kpiId);
		result.set(summary.id, {
			metric,
			kpi: {
				metricId: kpiId,
				title: kpiSummary.title,
				comparator: owner.binding.comparator,
				target: owner.binding.target,
				...(status ? { status } : {}),
			},
			goal: { id: owner.goal.id, title: owner.goal.title },
		});
	}
	return result;
}
