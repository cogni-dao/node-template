// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** task.0125: a metric's five-second `brief` lives beside the hashed spec and reaches every read that names the metric. */
import { describe, expect, it } from "vitest";
import {
	GoalsProgressSchema,
	type MetricBrief,
	MetricBriefSchema,
	metricDefinitionHash,
	parseStoredMetricSpec,
	readGoalsProgress,
} from "../src/index";
import { hub } from "./fakes";

const brief: MetricBrief = {
	summary: "Counts open work items each hour from the node's work-item table.",
	justification: "Shows whether open scope grows faster than the node closes it.",
};
const spec = {
	calculatorId: "work.count@1",
	params: { mode: "open" },
	maxAgeSeconds: 7200,
};
const row = (id: string, extra: object = {}) => ({
	id,
	title: id,
	metric_spec: { ...spec, ...extra },
	updated_at: "2026-11-01T00:00:00Z",
	status: "active",
});
const goal = (kpiId: string) => ({
	listGoals: async () => [
		{
			id: "g",
			title: "G",
			evaluateAt: null,
			kpiBindings: [
				{
					metricId: kpiId,
					comparator: "gte" as const,
					target: { value: 1, unit: "items" },
				},
			],
		},
	],
	hypotheses: async () => ({ items: [], more: false }),
});

describe("metric brief schema", () => {
	it("accepts two short plain sentences and trims them", () => {
		expect(
			MetricBriefSchema.parse({
				summary: `  ${brief.summary} `,
				justification: brief.justification,
			}),
		).toEqual(brief);
	});

	it.each([
		["an empty summary", { ...brief, summary: " " }],
		["more than 25 words", { ...brief, summary: Array(26).fill("w").join(" ") }],
		["more than 160 characters", { ...brief, justification: "x".repeat(161) }],
		["a second line", { ...brief, justification: "One.\nTwo." }],
		["an unknown key", { ...brief, why: "x" }],
		["a missing justification", { summary: brief.summary }],
	])("rejects %s", (_name, value) => {
		expect(MetricBriefSchema.safeParse(value).success).toBe(false);
	});
});

describe("metric brief is an annex", () => {
	it("returns the brief and keeps it out of the series hash", () => {
		const stored = parseStoredMetricSpec({ ...spec, brief });
		expect(stored.brief).toEqual(brief);
		expect(stored.invalid).toEqual([]);
		const plain = { id: "m", title: "m", revision: "1", spec: stored.spec };
		expect(metricDefinitionHash({ ...plain, brief })).toBe(
			metricDefinitionHash(plain),
		);
	});

	it("keeps a metric whose brief is invalid and reports it on the view only", async () => {
		const h = hub([
			row("bad-brief", { brief: { summary: "", justification: "x" } }),
			row("kpi"),
		]);
		const view = await h.reader.read("bad-brief");
		expect(view.definition.brief).toBeUndefined();
		expect(view.definition.annexInvalid).toEqual([
			{ field: "brief", issues: ["brief.summary:too_small"] },
		]);
		expect(h.events).toEqual([]);
		const read = await readGoalsProgress({
			goals: goal("kpi"),
			metrics: h.reader,
			environment: "test",
		});
		// A bad brief changes no relationship: never an orphan, still listed as unbound.
		expect(read.orphans).toEqual([]);
		expect(read.unbound?.map((u) => u.metric.id)).toEqual(["bad-brief"]);
	});
});

describe("every read that names a metric carries its brief", () => {
	it("reaches the metric view, the KPI, served, orphan and unbound rows", async () => {
		const h = hub([
			row("kpi", { brief }),
			row("served", { brief, serves: { kpi: "kpi", role: "input" } }),
			row("lost", { brief, serves: { kpi: "nope", role: "diagnostic" } }),
			row("loose", { brief }),
			row("plain"),
		]);
		expect((await h.reader.read("served")).definition.brief).toEqual(brief);
		const read = await readGoalsProgress({
			goals: goal("kpi"),
			metrics: h.reader,
			environment: "test",
		});
		expect(GoalsProgressSchema.parse(read)).toEqual(read);
		const kpi = read.goals[0]?.kpis[0];
		expect(kpi?.metric?.brief).toEqual(brief);
		expect(kpi?.served?.[0]?.metric.brief).toEqual(brief);
		expect(read.orphans?.[0]).toMatchObject({ metricId: "lost", brief });
		const unbound = Object.fromEntries(
			(read.unbound ?? []).map((u) => [u.metric.id, u.metric.brief]),
		);
		expect(unbound).toEqual({ loose: brief, plain: undefined });
	});
});
