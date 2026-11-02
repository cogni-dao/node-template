// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

import type { KnowledgeStorePort } from "@cogni/knowledge-store";
import { KpiBindingsSchema, type MetricService } from "@cogni-dao/metrics";
import { GoalReadingSchema, GoalsProgressSchema } from "../types";
/** Read model only: observation thresholds never create EDO verdicts or knowledge writes. */
export async function readGoalsProgress(
	port: KnowledgeStorePort,
	metrics: MetricService | undefined,
	environment = "unknown",
) {
	const goals = await port.listActiveGoals();
	const cache = new Map<
		string,
		Promise<{
			view: Awaited<ReturnType<MetricService["read"]>> | null;
			history: Awaited<ReturnType<MetricService["history"]>>;
		}>
	>();
	const evidence = (id: string) => {
		let value = cache.get(id);
		if (!value) {
			value = (async () => {
				try {
					return metrics
						? {
								view: await metrics.read(id),
								history: await metrics.history(id),
							}
						: { view: null, history: [] };
				} catch {
					return { view: null, history: [] };
				}
			})();
			cache.set(id, value);
		}
		return value;
	};
	const readings = async (raw: unknown, hypothesis = false) => {
		const parsed = KpiBindingsSchema.safeParse(raw ?? []);
		const bindings = parsed.success ? parsed.data : [];
		const resolved = metrics
			? await metrics.bindings(bindings, { hypothesis })
			: bindings.map((b) => ({
					...b,
					baseline: null,
					observation: null,
					viewState: "unavailable",
					met: null,
					reason: "metrics_unavailable",
				}));
		return {
			bindings,
			readings: resolved.map((r) => GoalReadingSchema.parse(r)),
			invalid: !parsed.success,
		};
	};
	const items = [];
	// Keep the canonical complete goal list. Per-goal EDO reads are a small preview.
	for (const goal of goals) {
		const row = await port.getKnowledge(goal.id);
		const configured = await readings(row?.kpiBindings);
		const metricRows = [];
		for (const [i, binding] of configured.bindings.entries()) {
			const reading = configured.readings[i];
			if (reading)
				metricRows.push({
					binding,
					reading,
					...(await evidence(binding.metricId)),
				});
		}
		const hypotheses = [];
		let moreHypotheses = false,
			hypothesesUnavailable = false;
		try {
			const edges = (await port.listCitationsByCitedId(goal.id)).filter(
				(e) => e.citationType === "extends",
			);
			const ids = [
				...new Set(
					edges
						.sort(
							(a, b) =>
								(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
						)
						.map((e) => e.citingId),
				),
			];
			// At most ten source bodies per goal. Never silently claim this is the entire EDO graph.
			moreHypotheses = ids.length > 10;
			for (const id of ids.slice(0, 10)) {
				const bet = await port.getKnowledge(id);
				if (bet?.entryType !== "hypothesis") continue;
				const outcomes = (await port.listCitationsByCitedId(id)).filter(
					(e) =>
						e.citationType === "validates" || e.citationType === "invalidates",
				);
				const outcomeEdge = outcomes.sort(
					(a, b) =>
						(b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
				)[0];
				const outcome = outcomeEdge
					? await port.getKnowledge(outcomeEdge.citingId)
					: null;
				hypotheses.push({
					id: bet.id,
					title: bet.title,
					evaluateAt: bet.evaluateAt?.toISOString() ?? null,
					predictions: (await readings(bet.kpiBindings, true)).readings,
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
		} catch {
			hypothesesUnavailable = true;
		}
		items.push({
			id: goal.id,
			title: goal.title,
			evaluateAt: goal.evaluateAt?.toISOString() ?? null,
			configurationError: configured.invalid,
			metrics: metricRows,
			hypotheses,
			moreHypotheses,
			hypothesesUnavailable,
		});
	}
	return GoalsProgressSchema.parse({
		goals: items,
		asOf: new Date().toISOString(),
		environment,
	});
}
