// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** story.0033 part A: `serves` + `band` live beside the hashed spec, never inside it. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createMetricService,
	type GoalSourcePort,
	GoalsProgressSchema,
	type KpiBinding,
	type MetricBand,
	type MetricDefinition,
	MetricListResponseSchema,
	type MetricObservation,
	type MetricObservationsPort,
	MetricRegistry,
	MetricSpecSchema,
	MetricViewSchema,
	metricDefinitionHash,
	parseStoredMetricSpec,
	readGoalsProgress,
	SERVES_SCAN_MAX,
	StoredMetricSpecSchema,
} from "../src/index";
import { hub } from "./fakes";

const NOW = new Date("2026-11-10T12:00:00Z");
const spec = {
	calculatorId: "work.count@1",
	params: {},
	cadenceSeconds: 3600,
	maxAgeSeconds: 7200,
};
const band: MetricBand = {
	comparator: "gte",
	target: { value: 90, unit: "items" },
};

function definition(
	id: string,
	extra: Partial<MetricDefinition> = {},
): MetricDefinition {
	return { id, title: id, revision: "1", spec, ...extra };
}

/** One ok reading, fresh at NOW, for a metric. */
function reading(
	d: MetricDefinition,
	value: number,
	status: MetricObservation["status"] = "ok",
): MetricObservation {
	const at = new Date(NOW.getTime() - 60_000).toISOString();
	return {
		id: crypto.randomUUID(),
		metricId: d.id,
		definitionRevision: d.revision,
		definitionHash: metricDefinitionHash(d),
		calculatorVersion: "work.count@1",
		paramsHash: "p",
		node: "n",
		environment: "test",
		dataScope: "members",
		window: { start: at, end: at },
		sourceWatermarks: [{ source: "work", asOf: at }],
		observedAt: at,
		status,
		value: status === "ok" ? value : null,
		unit: "items",
		reason: status === "ok" ? null : "source_failed",
		evidenceRefs: [],
	};
}

function setup(
	defs: MetricDefinition[],
	readings: Record<string, MetricObservation[]> = {},
) {
	const calls = { buckets: 0 };
	const registry = new MetricRegistry();
	registry.register({
		id: "work.count@1",
		unit: "items",
		paramsSchema: z.object({}),
		budget: {
			timeoutMs: 50,
			maxSourceCalls: 1,
			maxRows: 1,
			maxResponseBytes: 1000,
		},
		compute: async () => {
			throw new Error("never computed");
		},
	});
	const observations = {
		history: async (id: string) => readings[id] ?? [],
		lastGood: async (id: string) =>
			(readings[id] ?? []).find((r) => r.status === "ok") ?? null,
		buckets: async () => {
			calls.buckets++;
			return [];
		},
		at: async () => null,
		snapshot: async () => null,
	} as unknown as MetricObservationsPort;
	const service = createMetricService({
		definitions: {
			get: async (id) => defs.find((d) => d.id === id) ?? null,
			list: async (limit, after) => {
				const rest = defs.filter((d) => !after || d.id > after);
				return {
					items: rest.slice(0, limit),
					nextCursor: rest.length > limit ? (rest[limit - 1]?.id ?? null) : null,
				};
			},
		},
		observations,
		registry,
		scope: { node: "n", environment: "test", dataScope: "members" },
		now: () => NOW,
		authorize: async () => true,
	});
	return { service, calls };
}

describe("serves and band schema (story.0033)", () => {
	it("parses serves and band beside the spec and returns all three", () => {
		const parsed = parseStoredMetricSpec({
			...spec,
			display: "volume",
			serves: { kpi: "deploy-first-try-7d", role: "diagnostic" },
			band: { ...band, breach: "failing" },
		});
		expect(parsed.spec).toEqual(spec);
		expect(parsed.display).toBe("volume");
		expect(parsed.serves).toEqual({
			kpi: "deploy-first-try-7d",
			role: "diagnostic",
		});
		expect(parsed.band).toEqual({ ...band, breach: "failing" });
		expect(parseStoredMetricSpec(spec)).toEqual({
			spec,
			display: undefined,
			serves: undefined,
			band: undefined,
		});
	});

	it.each([
		["a role outside the enum", { serves: { kpi: "k", role: "driver" } }],
		["an empty kpi", { serves: { kpi: "", role: "input" } }],
		["a kpi over 40 characters", { serves: { kpi: "k".repeat(41), role: "input" } }],
		["an unknown serves key", { serves: { kpi: "k", role: "input", why: "x" } }],
		["a band that names a metricId", { band: { ...band, metricId: "x" } }],
		[
			"a band with a deadline",
			{ band: { ...band, evaluationAt: "2026-12-01T00:00:00Z" } },
		],
		["a band without a comparator", { band: { target: band.target } }],
	])("rejects %s", (_name, extra) => {
		expect(StoredMetricSpecSchema.safeParse({ ...spec, ...extra }).success).toBe(
			false,
		);
	});

	it("keeps serves and band out of the hashed spec", () => {
		// The strict spec still refuses them: they can never enter the hash by parsing.
		expect(
			MetricSpecSchema.safeParse({
				...spec,
				serves: { kpi: "k", role: "input" },
			}).success,
		).toBe(false);
		const plain = definition("m");
		const linked = definition("m", {
			serves: { kpi: "k", role: "guardrail" },
			band,
			display: "volume",
		});
		expect(metricDefinitionHash(linked)).toBe(metricDefinitionHash(plain));
		const stored = parseStoredMetricSpec({
			...spec,
			serves: { kpi: "k", role: "input" },
			band,
		});
		expect(
			metricDefinitionHash({ id: "m", title: "m", revision: "1", spec: stored.spec }),
		).toBe(metricDefinitionHash(plain));
	});

	it("reads serves and band from a stored hub row and keeps an invalid row visible in the log", async () => {
		const row = (id: string, extra: object) => ({
			id,
			title: id,
			metric_spec: {
				calculatorId: "work.count@1",
				params: { mode: "open" },
				maxAgeSeconds: 7200,
				...extra,
			},
			updated_at: "2026-11-01T00:00:00Z",
			status: "active",
		});
		const h = hub([
			row("linked", { serves: { kpi: "k", role: "input" }, band }),
			row("broken", { serves: { kpi: "k", role: "nope" } }),
		]);
		const view = await h.reader.read("linked");
		expect(view.definition.serves).toEqual({ kpi: "k", role: "input" });
		expect(view.definition.band).toEqual(band);
		// An invalid serves is the existing malformed-row path: logged, never silently coerced.
		await expect(h.reader.read("broken")).rejects.toMatchObject({
			code: "metric_not_found",
		});
		expect(h.events).toContainEqual({
			event: "metric.definition_invalid",
			metricId: "broken",
		});
	});
});

describe("band assessment goes through the one KPI path", () => {
	const view = async (
		b: MetricBand,
		value: number | "error",
		extra: Partial<MetricDefinition> = {},
	) => {
		const d = definition("m", { band: b, ...extra });
		const r = value === "error" ? reading(d, 0, "error") : reading(d, value);
		const s = setup([d], { m: [r] });
		return { ...s, v: await s.service.read("m") };
	};

	it("is on_track when the latest reading satisfies the band", async () => {
		const { v } = await view(band, 95);
		expect(v.bandAssessment).toMatchObject({
			status: "on_track",
			reason: null,
			value: 95,
			unit: "items",
			deadline: null,
		});
		expect(MetricViewSchema.parse(v).bandAssessment?.status).toBe("on_track");
	});

	it("is behind below the band and failing/target_breached with breach", async () => {
		expect((await view(band, 80)).v.bandAssessment).toMatchObject({
			status: "behind",
		});
		expect(
			(await view({ ...band, breach: "failing" }, 80)).v.bandAssessment,
		).toMatchObject({ status: "failing", reason: "target_breached", value: 80 });
	});

	it("reads red for a failed attempt and not_measured for a unit mismatch", async () => {
		expect((await view(band, "error")).v.bandAssessment).toMatchObject({
			status: "failing",
			reason: "source_failed",
		});
		expect(
			(await view({ ...band, target: { value: 90, unit: "%" } }, 95)).v
				.bandAssessment,
		).toMatchObject({ status: "not_measured", reason: "unit_mismatch" });
	});

	it("reads the same synthetic binding a KPI would: kpi() agrees", async () => {
		const d = definition("m", { band });
		const s = setup([d], { m: [reading(d, 80)] });
		const binding: KpiBinding = { metricId: "m", ...band };
		const viaKpi = (await s.service.kpi(binding)).assessment;
		const viaBand = (await s.service.read("m")).bandAssessment;
		expect(viaBand).toEqual({ ...viaKpi, observationId: viaBand?.observationId });
		expect(viaKpi.observationId).toBe(viaBand?.observationId);
	});

	it("makes no trend or history-range query", async () => {
		const { calls } = await view(band, 95);
		expect(calls.buckets).toBe(0);
	});

	it("omits bandAssessment without a band and exposes serves and band on list", async () => {
		const d = definition("plain");
		const linked = definition("linked", {
			serves: { kpi: "k", role: "input" },
			band,
		});
		const s = setup([d, linked], { linked: [reading(linked, 95)] });
		expect((await s.service.read("plain")).bandAssessment).toBeUndefined();
		const page = MetricListResponseSchema.parse(await s.service.list());
		const item = page.items.find((i) => i.definition.id === "linked");
		expect(item?.definition.serves).toEqual({ kpi: "k", role: "input" });
		expect(item?.definition.band).toEqual(band);
		expect(item?.bandAssessment?.status).toBe("on_track");
	});
});

describe("goal read lists served metrics under their KPI", () => {
	const kpiBinding = {
		metricId: "kpi",
		comparator: "gte",
		target: { value: 50, unit: "items" },
	};
	const goals = (kpiBindings: unknown = [kpiBinding]): GoalSourcePort => ({
		listGoals: async () => [
			{ id: "goal", title: "Goal", evaluateAt: null, kpiBindings },
		],
		hypotheses: async () => ({ items: [], more: false }),
	});

	it("nests each served metric with role and band assessment, keeps orphans and the unbanded", async () => {
		const kpi = definition("kpi");
		const input = definition("input-m", {
			serves: { kpi: "kpi", role: "input" },
			band,
		});
		const guard = definition("guard-m", {
			serves: { kpi: "kpi", role: "guardrail" },
			band: { ...band, breach: "failing" },
		});
		const unbanded = definition("unbanded-m", {
			serves: { kpi: "kpi", role: "diagnostic" },
		});
		const lost = definition("lost-m", {
			serves: { kpi: "no-such-kpi", role: "diagnostic" },
			band,
		});
		const other = definition("other-m");
		const s = setup([kpi, input, guard, unbanded, lost, other], {
			kpi: [reading(kpi, 60)],
			"input-m": [reading(input, 95)],
			"guard-m": [reading(guard, 10)],
			"lost-m": [reading(lost, 5)],
		});
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(GoalsProgressSchema.parse(read)).toEqual(read);
		const served = read.goals[0]?.kpis[0]?.served ?? [];
		expect(served.map((x) => [x.metric.id, x.metric.role])).toEqual([
			["input-m", "input"],
			["guard-m", "guardrail"],
			["unbanded-m", "diagnostic"],
		]);
		expect(served.find((x) => x.metric.id === "input-m")).toMatchObject({
			metric: { title: "input-m", calculatorId: "work.count@1" },
			assessment: { status: "on_track", value: 95 },
		});
		expect(served.find((x) => x.metric.id === "guard-m")?.assessment).toMatchObject({
			status: "failing",
			reason: "target_breached",
		});
		expect(served.find((x) => x.metric.id === "unbanded-m")?.assessment).toBeNull();
		// The KPI's own assessment is untouched by what serves it.
		expect(read.goals[0]?.kpis[0]?.assessment.status).toBe("on_track");
		// A metric serving no bound KPI is reported and assessed, never hidden.
		expect(read.orphans).toEqual([
			{
				metricId: "lost-m",
				kpi: "no-such-kpi",
				reason: "serves_unknown_kpi",
				assessment: expect.objectContaining({ status: "behind", value: 5 }),
			},
		]);
		expect(read.servedTruncated).toBe(false);
		// Only the KPI's own 30-day trend and 24-hour recent: served metrics add none.
		expect(s.calls.buckets).toBe(2);
	});

	it("lists a served metric under every goal KPI that binds it, and no orphans when all are bound", async () => {
		const kpi = definition("kpi");
		const m = definition("m", { serves: { kpi: "kpi", role: "input" } });
		const s = setup([kpi, m]);
		const read = await readGoalsProgress({
			goals: {
				listGoals: async () => [
					{ id: "a", title: "A", evaluateAt: null, kpiBindings: [kpiBinding] },
					{ id: "b", title: "B", evaluateAt: null, kpiBindings: [kpiBinding] },
				],
				hypotheses: async () => ({ items: [], more: false }),
			},
			metrics: s.service,
			environment: "test",
		});
		expect(read.goals.map((g) => g.kpis[0]?.served?.[0]?.metric.id)).toEqual([
			"m",
			"m",
		]);
		expect(read.orphans).toEqual([]);
	});

	it("omits served when nothing serves a KPI, and reports every serving metric as an orphan when goals bind nothing", async () => {
		const lone = definition("lone", { serves: { kpi: "kpi", role: "input" } });
		const s = setup([lone]);
		const withKpi = await readGoalsProgress({
			goals: goals(),
			metrics: setup([definition("kpi")]).service,
			environment: "test",
		});
		expect(withKpi.goals[0]?.kpis[0]).not.toHaveProperty("served");
		const none = await readGoalsProgress({
			goals: goals([]),
			metrics: s.service,
			environment: "test",
		});
		expect(none.orphans?.map((o) => o.metricId)).toEqual(["lone"]);
	});

	it("reports no orphans and no served when the node has no metrics service", async () => {
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: undefined,
			environment: "test",
		});
		expect(read.orphans).toBeUndefined();
		expect(read.servedTruncated).toBeUndefined();
		expect(read.goals[0]?.kpis[0]).not.toHaveProperty("served");
	});

	it("admits a truncated scan instead of reading unbounded definitions", async () => {
		const many = Array.from({ length: SERVES_SCAN_MAX + 60 }, (_, i) =>
			definition(`m${String(i).padStart(4, "0")}`, {
				serves: { kpi: "kpi", role: "input" },
			}),
		);
		const s = setup(many);
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(read.servedTruncated).toBe(true);
		expect(read.goals[0]?.kpis[0]?.served?.length).toBe(SERVES_SCAN_MAX);
	});
});
