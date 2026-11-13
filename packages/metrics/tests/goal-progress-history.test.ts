// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import type { GoalsProgress } from "../src/contracts";
import { createMetricHttpHandlers } from "../src/http";
import { projectGoalsProgressHistory } from "../src/progress";

const at = "2026-11-12T00:00:00.000Z";
const source: GoalsProgress = {
	asOf: at,
	environment: "local",
	servedTruncated: true,
	servedUnavailable: "metric_authority_unavailable",
	goals: [
		{
			id: "goal-local",
			title: "[TEST] Goal",
			evaluateAt: null,
			configurationError: false,
			hypotheses: [],
			moreHypotheses: false,
			hypothesesUnavailable: true,
			kpis: [
				{
					binding: {
						metricId: "local-metric",
						comparator: "gte",
						target: { value: 1, unit: "ratio" },
					},
					metric: null,
					assessment: {
						status: "building",
						reason: "insufficient_history",
						value: null,
						unit: "ratio",
						observationId: null,
						observedAt: null,
						comparator: "gte",
						target: { value: 1, unit: "ratio" },
						deadline: null,
						pace: { observed: null, needed: null },
					},
					trend: {
						metricId: "local-metric",
						unit: "ratio",
						from: at,
						to: at,
						step: "1d",
						buckets: [
							{
								start: at,
								end: at,
								status: "missing",
								value: null,
								observationId: null,
							},
						],
					},
					recent: null,
					served: [],
				},
			],
		},
	],
};

describe("explicit goal-progress history bounds", () => {
	it("keeps full charts by default and never mutates the source", () => {
		const before = structuredClone(source);
		expect(projectGoalsProgressHistory(source).goals).toEqual(source.goals);
		expect(projectGoalsProgressHistory(source).historyMode).toBe("full");
		projectGoalsProgressHistory(source, { history: "none" });
		expect(source).toEqual(before);
	});
	it("bounds only named chart values; every other envelope field and future field survives", () => {
		const extended = { ...source, futureDiagnostic: { reason: "unknown" } };
		const out = projectGoalsProgressHistory(extended, { history: "none" });
		for (const [key, value] of Object.entries(extended))
			if (key !== "goals") expect(Reflect.get(out, key)).toEqual(value);
		for (const [index, goal] of source.goals.entries()) {
			const actual = out.goals[index];
			if (!actual) throw new Error("goal missing");
			for (const [key, value] of Object.entries(goal))
				if (key !== "kpis") expect(Reflect.get(actual, key)).toEqual(value);
			for (const [i, kpi] of goal.kpis.entries()) {
				const result = actual.kpis[i];
				if (!result) throw new Error("KPI missing");
				expect(Object.keys(result).sort()).toEqual(Object.keys(kpi).sort());
				for (const [key, value] of Object.entries(kpi))
					if (!["trend", "recent"].includes(key))
						expect(Reflect.get(result, key)).toEqual(value);
				expect(result.trend).toBeNull();
				expect(result.recent).toBeNull();
			}
		}
		expect(out.historyMode).toBe("none");
		expect(out.goals[0]?.kpis[0]?.assessment.value).toBeNull();
	});
	it("makes the same bound available over HTTP and rejects invalid input before reading", async () => {
		const goalProgress = vi.fn(async () => source);
		const handlers = createMetricHttpHandlers({
			goalProgress,
			service: () => undefined,
			subject: async () => null,
		});
		const invalid = await handlers.goals(
			new URLSearchParams("history=unexpected"),
		);
		expect(invalid).toMatchObject({
			ok: false,
			status: 400,
			body: { error: "invalid_input" },
		});
		expect(goalProgress).not.toHaveBeenCalled();
		const full = await handlers.goals();
		const compact = await handlers.goals(new URLSearchParams("history=none"));
		expect(full.ok && full.body.goals[0]?.kpis[0]?.trend?.buckets).toHaveLength(
			1,
		);
		expect(compact.ok && compact.body.historyMode).toBe("none");
		expect(compact.ok && compact.body.goals[0]?.kpis[0]?.assessment).toEqual(
			source.goals[0]?.kpis[0]?.assessment,
		);
		expect(compact.ok && compact.body.goals[0]?.kpis[0]?.trend).toBeNull();
	});
});
