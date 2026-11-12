// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** task.0118: the metric → KPI → goal chain of a work item's moves, from cheap reads only. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createMetricService,
	type GoalSourcePort,
	type MetricDefinition,
	type MetricObservationsPort,
	MetricRegistry,
	readMetricChains,
} from "../src/index";

const NOW = new Date("2026-11-10T12:00:00Z");
const spec = {
	calculatorId: "work.count@1",
	params: {},
	cadenceSeconds: 3600,
	maxAgeSeconds: 7200,
};
const definition = (
	id: string,
	extra: Partial<MetricDefinition> = {},
): MetricDefinition => ({ id, title: `Title ${id}`, revision: "1", spec, ...extra });

const kpiBinding = {
	metricId: "work-validated",
	comparator: "gte",
	target: { value: 10, unit: "items" },
};
const goals: GoalSourcePort = {
	listGoals: async () => [
		{
			id: "goal-ai-work-converges",
			title: "AI work converges faster than it sprawls",
			evaluateAt: null,
			kpiBindings: [kpiBinding],
		},
		{ id: "goal-broken", title: "Broken", evaluateAt: null, kpiBindings: "nope" },
	],
	hypotheses: async () => ({ items: [], more: false }),
};

function setup(defs: MetricDefinition[], options: { getManyFails?: boolean } = {}) {
	const calls = { getMany: [] as string[][], history: 0, goalsRead: 0 };
	const registry = new MetricRegistry();
	registry.register({
		id: "work.count@1",
		unit: "items",
		display: "volume",
		paramsSchema: z.object({}),
		budget: { timeoutMs: 50, maxSourceCalls: 1, maxRows: 1, maxResponseBytes: 1000 },
		compute: async () => {
			throw new Error("never computed");
		},
	});
	const observations = {
		history: async () => {
			calls.history++;
			return [];
		},
		lastGood: async () => null,
		buckets: async () => [],
		at: async () => null,
		snapshot: async () => null,
	} as unknown as MetricObservationsPort;
	const metrics = createMetricService({
		definitions: {
			get: async (id) => defs.find((d) => d.id === id) ?? null,
			getMany: async (ids) => {
				calls.getMany.push([...ids]);
				if (options.getManyFails) throw new Error("definitions read failed");
				return defs.filter((d) => ids.includes(d.id));
			},
			list: async () => ({ items: [], nextCursor: null }),
		},
		observations,
		registry,
		scope: { node: "n", environment: "test", dataScope: "members" },
		now: () => NOW,
		authorize: async (_action, d) => d.id !== "denied",
	});
	const countingGoals: Pick<GoalSourcePort, "listGoals"> = {
		listGoals: async () => {
			calls.goalsRead++;
			return goals.listGoals();
		},
	};
	return { metrics, calls, goals: countingGoals };
}

const kpi = definition("work-validated", { title: "Validated work", display: "progress" });
const supporting = definition("work-open", {
	serves: { kpi: "work-validated", role: "input" },
});
const lonely = definition("work-lonely");

describe("readMetricChains (task.0118)", () => {
	it("a moved KPI is its own KPI, with its goal and target", async () => {
		const { metrics, goals, calls } = setup([kpi, supporting]);
		const chains = await readMetricChains({ metrics, goals, metricIds: ["work-validated"] });
		expect(chains.get("work-validated")).toMatchObject({
			metric: { id: "work-validated", title: "Validated work", unit: "items", display: "progress" },
			kpi: {
				metricId: "work-validated",
				title: "Validated work",
				comparator: "gte",
				target: { value: 10, unit: "items" },
			},
			goal: { id: "goal-ai-work-converges", title: "AI work converges faster than it sprawls" },
		});
		// One definitions read; the KPI needs no second one.
		expect(calls.getMany).toEqual([["work-validated"]]);
		expect(calls.goalsRead).toBe(1);
	});

	it("a supporting metric resolves the KPI it serves, titled by a second definitions read", async () => {
		const { metrics, goals, calls } = setup([kpi, supporting]);
		const chains = await readMetricChains({ metrics, goals, metricIds: ["work-open"] });
		expect(chains.get("work-open")).toMatchObject({
			metric: { id: "work-open", title: "Title work-open", unit: "items" },
			kpi: { metricId: "work-validated", title: "Validated work", comparator: "gte" },
			goal: { id: "goal-ai-work-converges" },
		});
		expect(calls.getMany).toEqual([["work-open"], ["work-validated"]]);
	});

	it("a metric that serves no goal KPI has the metric only: no kpi, no goal", async () => {
		const orphan = definition("work-orphan", { serves: { kpi: "bet-only-kpi", role: "input" } });
		const { metrics, goals } = setup([kpi, lonely, orphan]);
		const chains = await readMetricChains({
			metrics,
			goals,
			metricIds: ["work-lonely", "work-orphan"],
		});
		expect(chains.get("work-lonely")).toEqual({
			metric: { id: "work-lonely", title: "Title work-lonely", unit: "items", display: "volume" },
		});
		expect(chains.get("work-orphan")?.kpi).toBeUndefined();
		expect(chains.get("work-orphan")?.goal).toBeUndefined();
	});

	it("an unknown or unreadable metric is absent, never invented", async () => {
		const denied = definition("denied");
		const { metrics, goals } = setup([kpi, denied]);
		const chains = await readMetricChains({
			metrics,
			goals,
			metricIds: ["no-such-metric", "denied", "work-validated"],
		});
		expect([...chains.keys()]).toEqual(["work-validated"]);
	});

	it("never reads history ranges or the goal progress read; status comes from one latest-only assessment", async () => {
		const { metrics, goals, calls } = setup([kpi, supporting]);
		const kpiRead = vi.spyOn(metrics, "kpi");
		const chains = await readMetricChains({
			metrics,
			goals,
			metricIds: ["work-open", "work-validated"],
		});
		// Two moves, one KPI: assessed once, latest only.
		expect(kpiRead).toHaveBeenCalledTimes(1);
		expect(kpiRead.mock.calls[0]?.[1]).toMatchObject({ latestOnly: true });
		// No reading exists: the status is the assessor's own verdict, never a guess of ours.
		const direct = await metrics.kpi(
			{ ...kpiBinding, comparator: "gte" },
			{ latestOnly: true },
		);
		expect(chains.get("work-validated")?.kpi?.status).toBe(direct.assessment.status);
		// One assessment read one latest attempt, plus the direct one above: nothing walked history.
		expect(calls.history).toBe(2);
	});

	it("omits status when the KPI assessment errors, keeping the rest of the chain", async () => {
		const { metrics, goals } = setup([kpi]);
		vi.spyOn(metrics, "kpi").mockRejectedValue(new Error("boom"));
		const chains = await readMetricChains({ metrics, goals, metricIds: ["work-validated"] });
		const chain = chains.get("work-validated");
		expect(chain?.kpi).toMatchObject({ metricId: "work-validated", comparator: "gte" });
		expect(chain?.kpi?.status).toBeUndefined();
		expect(chain?.goal?.id).toBe("goal-ai-work-converges");
	});

	it("rejects when the definitions read fails, so the caller marks the context unavailable", async () => {
		const { metrics, goals } = setup([kpi], { getManyFails: true });
		await expect(
			readMetricChains({ metrics, goals, metricIds: ["work-validated"] }),
		).rejects.toThrow("definitions read failed");
	});

	it("rejects when the goals read fails", async () => {
		const { metrics } = setup([kpi]);
		await expect(
			readMetricChains({
				metrics,
				goals: { listGoals: async () => Promise.reject(new Error("goals down")) },
				metricIds: ["work-validated"],
			}),
		).rejects.toThrow("goals down");
	});
});
