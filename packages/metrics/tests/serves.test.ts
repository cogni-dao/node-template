// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** story.0033 part A: `serves` + `band` live beside the hashed spec, never inside it. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	bucketObservations,
	createMetricService,
	type GoalSourcePort,
	GoalsProgressSchema,
	hashMetric,
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
	metricHistoryRange,
	parseStoredMetricSpec,
	readGoalsProgress,
	SERVES_SCAN_MAX,
	StoredMetricSpecSchema,
} from "../src/index";
import { createGoalProgressReader } from "../src/knowledge";
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
		paramsHash: hashMetric(d.spec.params),
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
	authorize: (d: MetricDefinition) => Promise<boolean> = async () => true,
) {
	const calls = { buckets: 0, history: 0, lastGood: 0, get: 0, batch: 0 };
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
		workReadBatch: async (requests: readonly { metricId: string }[]) => {
			calls.batch++;
			return requests.map(({ metricId }) => ({
				baseline: null,
				latest: readings[metricId]?.[0] ?? null,
				lastGood:
					(readings[metricId] ?? []).find((r) => r.status === "ok") ?? null,
			}));
		},
		history: async (id: string) => {
			calls.history++;
			return readings[id] ?? [];
		},
		lastGood: async (id: string) => {
			calls.lastGood++;
			return (readings[id] ?? []).find((r) => r.status === "ok") ?? null;
		},
		buckets: async () => {
			calls.buckets++;
			return [];
		},
		at: async () => null,
		snapshot: async () => null,
	} as unknown as MetricObservationsPort;
	const definitions = {
		get: async (id) => {
			calls.get++;
			return defs.find((d) => d.id === id) ?? null;
		},
		list: async (limit, after) => {
			const rest = defs.filter((d) => !after || d.id > after);
			return {
				items: rest.slice(0, limit),
				nextCursor: rest.length > limit ? (rest[limit - 1]?.id ?? null) : null,
			};
		},
	};
	const service = createMetricService({
		definitions,
		observations,
		registry,
		scope: { node: "n", environment: "test", dataScope: "members" },
		now: () => NOW,
		authorize: async (_action, d) => authorize(d),
	});
	return { service, calls, observations, definitions };
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
			invalid: [],
		});
	});

	it.each([
		["a role outside the enum", { serves: { kpi: "k", role: "driver" } }],
		["an empty kpi", { serves: { kpi: "", role: "input" } }],
		[
			"a kpi over 40 characters",
			{ serves: { kpi: "k".repeat(41), role: "input" } },
		],
		[
			"an unknown serves key",
			{ serves: { kpi: "k", role: "input", why: "x" } },
		],
		["a band that names a metricId", { band: { ...band, metricId: "x" } }],
		[
			"a band with a deadline",
			{ band: { ...band, evaluationAt: "2026-12-01T00:00:00Z" } },
		],
		["a band without a comparator", { band: { target: band.target } }],
	])("rejects %s", (_name, extra) => {
		expect(
			StoredMetricSpecSchema.safeParse({ ...spec, ...extra }).success,
		).toBe(false);
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
			metricDefinitionHash({
				id: "m",
				title: "m",
				revision: "1",
				spec: stored.spec,
			}),
		).toBe(metricDefinitionHash(plain));
	});

	const row = (id: string, extra: object, core: object = {}) => ({
		id,
		title: id,
		metric_spec: {
			calculatorId: "work.count@1",
			params: { mode: "open" },
			maxAgeSeconds: 7200,
			...core,
			...extra,
		},
		updated_at: "2026-11-01T00:00:00Z",
		status: "active",
	});

	it("reads serves and band from a stored hub row", async () => {
		const h = hub([
			row("linked", { serves: { kpi: "k", role: "input" }, band }),
		]);
		const view = await h.reader.read("linked");
		expect(view.definition.serves).toEqual({ kpi: "k", role: "input" });
		expect(view.definition.band).toEqual(band);
		expect(view.definition.annexInvalid).toBeUndefined();
	});

	it("keeps a metric whose serves or band is invalid, ignoring only the annex", async () => {
		const h = hub([
			row("bad-serves", { serves: { kpi: "k", role: "nope" }, band }),
			row("bad-band", {
				serves: { kpi: "k", role: "input" },
				band: { ...band, metricId: "x" },
			}),
		]);
		const a = await h.reader.read("bad-serves");
		expect(a.definition.spec.calculatorId).toBe("work.count@1");
		expect(a.definition.serves).toBeUndefined();
		expect(a.definition.band).toEqual(band);
		expect(a.definition.annexInvalid).toEqual([
			{ field: "serves", issues: ["serves.role:invalid_value"] },
		]);
		const b = await h.reader.read("bad-band");
		expect(b.definition.serves).toEqual({ kpi: "k", role: "input" });
		expect(b.definition.band).toBeUndefined();
		expect(b.definition.annexInvalid).toEqual([
			{ field: "band", issues: ["band:unrecognized_keys"] },
		]);
		// Neither is the skipped-and-logged path, and both still list and compute.
		expect(h.events).toEqual([]);
		const page = await h.reader.list();
		expect(page.items.map((i) => i.definition.id)).toEqual([
			"bad-band",
			"bad-serves",
		]);
		expect(h.reader.registry.get("work.count@1")).toBeDefined();
	});

	it("reports an invalid annex in orphans with its issue paths", async () => {
		const h = hub([
			row("bad-band", {
				serves: { kpi: "kpi", role: "input" },
				band: { comparator: "gte", target: { value: "x", unit: "items" } },
			}),
			row("bad-serves", { serves: { kpi: "kpi", role: "nope" } }),
			row("kpi", {}),
		]);
		const read = await readGoalsProgress({
			goals: {
				listGoals: async () => [
					{
						id: "g",
						title: "G",
						evaluateAt: null,
						kpiBindings: [
							{
								metricId: "kpi",
								comparator: "gte",
								target: { value: 1, unit: "items" },
							},
						],
					},
				],
				hypotheses: async () => ({ items: [], more: false }),
			},
			metrics: h.reader,
			environment: "test",
		});
		expect(GoalsProgressSchema.parse(read)).toEqual(read);
		expect(
			read.orphans?.map((o) => [o.metricId, o.kpi, o.reason, o.issues]),
		).toEqual([
			["bad-band", "kpi", "band_invalid", ["band.target.value:invalid_type"]],
			["bad-serves", null, "serves_invalid", ["serves.role:invalid_value"]],
		]);
		// A valid serves with an invalid band still nests under its KPI, unjudged.
		expect(read.goals[0]?.kpis[0]?.served).toEqual([
			expect.objectContaining({
				metric: expect.objectContaining({ id: "bad-band", role: "input" }),
				assessment: null,
			}),
		]);
	});

	it("still skips and logs a row whose core spec is invalid", async () => {
		const h = hub([
			row(
				"bad-core",
				{ serves: { kpi: "k", role: "input" } },
				{ maxAgeSeconds: -1 },
			),
		]);
		await expect(h.reader.read("bad-core")).rejects.toMatchObject({
			code: "metric_not_found",
		});
		expect(h.events).toContainEqual({
			event: "metric.definition_invalid",
			metricId: "bad-core",
		});
	});

	it("parseStoredMetricSpec splits core from annex", () => {
		const parsed = parseStoredMetricSpec({
			...spec,
			serves: { kpi: "k", role: "x" },
			band: band,
		});
		expect(parsed.spec).toEqual(spec);
		expect(parsed.serves).toBeUndefined();
		expect(parsed.band).toEqual(band);
		expect(parsed.invalid).toEqual([
			{ field: "serves", issues: ["serves.role:invalid_value"] },
		]);
		expect(() =>
			parseStoredMetricSpec({ ...spec, maxAgeSeconds: 0 }),
		).toThrow();
		expect(() => parseStoredMetricSpec({ ...spec, extra: 1 })).toThrow();
		expect(() => parseStoredMetricSpec(null)).toThrow();
	});
});

describe("serving evidence compatibility", () => {
	it.each([
		["unit", { unit: "USD" }],
		["params hash", { paramsHash: "incorrect" }],
		["calculator version", { calculatorVersion: "work.count@2" }],
	] satisfies [string, Partial<MetricObservation>][])(
		"rejects incompatible %s in latest and last-good without losing healthy siblings",
		async (_name, mismatch) => {
			for (const slot of ["latest", "lastGood"] as const) {
				const bad = definition("bad", {
					serves: { kpi: "unknown-kpi", role: "input" },
				});
				const good = definition("good");
				const badReading = reading(bad, 123);
				const goodReading = reading(good, 10);
				const s = setup([bad, good]);
				s.observations.workReadBatch = async () => [
					{
						baseline: null,
						latest: badReading,
						lastGood: badReading,
						[slot]: { ...badReading, ...mismatch },
					},
					{ baseline: null, latest: goodReading, lastGood: goodReading },
				];
				const result = await readGoalsProgress({
					goals: {
						listGoals: async () => [],
						hypotheses: async () => ({ items: [], more: false }),
					},
					metrics: s.service,
					environment: "test",
				});
				expect(result.orphans?.[0]?.latest).toMatchObject({
					viewState: "error",
					value: null,
					reason: "incomplete_or_invalid_source",
				});
				expect(result.unbound?.[0]?.latest).toMatchObject({
					viewState: "ok",
					value: 10,
					unit: "items",
					reason: null,
				});
			}
		},
	);
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
		).toMatchObject({
			status: "failing",
			reason: "target_breached",
			value: 80,
		});
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
		expect(viaBand).toEqual({
			...viaKpi,
			observationId: viaBand?.observationId,
		});
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

	it("keeps an unbound metric with an invalid band and its warning", async () => {
		const d = definition("bad-band", {
			annexInvalid: [
				{ field: "band", issues: ["band.target.value:invalid_type"] },
			],
		});
		const s = setup([d], { "bad-band": [reading(d, 12)] });
		const read = await readGoalsProgress({
			goals: goals([]),
			metrics: s.service,
			environment: "test",
		});
		expect(read.unbound).toEqual([
			expect.objectContaining({
				metric: expect.objectContaining({ id: "bad-band" }),
				latest: expect.objectContaining({ value: 12 }),
			}),
		]);
		expect(read.orphans).toEqual([
			expect.objectContaining({ metricId: "bad-band", reason: "band_invalid" }),
		]);
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
		expect(
			served.find((x) => x.metric.id === "guard-m")?.assessment,
		).toMatchObject({
			status: "failing",
			reason: "target_breached",
		});
		expect(
			served.find((x) => x.metric.id === "unbanded-m")?.assessment,
		).toBeNull();
		// The KPI's own assessment is untouched by what serves it.
		expect(read.goals[0]?.kpis[0]?.assessment.status).toBe("on_track");
		// A metric serving no bound KPI is reported and assessed, never hidden.
		expect(read.orphans).toEqual([
			{
				metricId: "lost-m",
				title: "lost-m",
				kpi: "no-such-kpi",
				reason: "serves_unknown_kpi",
				assessment: expect.objectContaining({ status: "behind", value: 5 }),
				latest: expect.objectContaining({ viewState: "ok", value: 5 }),
			},
		]);
		// The KPI's own metric is the KPI, never unbound; only `other-m` serves nothing.
		expect(read.unbound?.map((u) => u.metric.id)).toEqual(["other-m"]);
		expect(read.servedTruncated).toBe(false);
		// Only the KPI's own 30-day trend and 24-hour recent: served metrics add none.
		expect(s.calls.buckets).toBe(2);
	});

	it("carries the latest reading on every listed metric, banded or not", async () => {
		const kpi = definition("kpi");
		const banded = definition("banded", {
			serves: { kpi: "kpi", role: "input" },
			band,
		});
		const bare = definition("bare", {
			serves: { kpi: "kpi", role: "diagnostic" },
		});
		const loose = definition("loose");
		const failing = definition("failing-m");
		const never = definition("never-m");
		const s = setup([kpi, banded, bare, loose, failing, never], {
			banded: [reading(banded, 95)],
			bare: [reading(bare, 7)],
			loose: [reading(loose, 3)],
			"failing-m": [reading(failing, 0, "error")],
		});
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(GoalsProgressSchema.parse(read)).toEqual(read);
		const served = read.goals[0]?.kpis[0]?.served ?? [];
		expect(served.find((x) => x.metric.id === "bare")).toMatchObject({
			assessment: null,
			latest: { viewState: "ok", value: 7, unit: "items", reason: null },
		});
		expect(served.find((x) => x.metric.id === "banded")?.latest?.value).toBe(
			95,
		);
		// Unbound: no serves and not a KPI. A failed latest attempt keeps its reason; unknown is null, never zero.
		expect(read.unbound?.map((u) => u.metric.id)).toEqual([
			"loose",
			"failing-m",
			"never-m",
		]);
		const byId = (id: string) => read.unbound?.find((u) => u.metric.id === id);
		expect(byId("loose")).toMatchObject({
			assessment: null,
			latest: { value: 3, viewState: "ok" },
		});
		expect(byId("failing-m")?.latest).toMatchObject({
			viewState: "error",
			value: null,
			reason: "source_failed",
		});
		expect(byId("never-m")?.latest).toMatchObject({
			viewState: "unavailable",
			value: null,
			observedAt: null,
			reason: null,
		});
	});

	it("reads each listed metric's newest attempt and last good reading once, banded or not", async () => {
		const kpi = definition("kpi");
		const banded = definition("banded", {
			serves: { kpi: "kpi", role: "input" },
			band,
		});
		const bare = definition("bare");
		const s = setup([banded, bare, kpi], {
			banded: [reading(banded, 95)],
			bare: [reading(bare, 7)],
		});
		const before = { ...s.calls };
		await s.service.serving();
		// Three definitions: one history read and one last-good read each, and no definition re-read for the band.
		expect(s.calls.history - before.history).toBe(0);
		expect(s.calls.batch - before.batch).toBe(1);
		expect(s.calls.lastGood - before.lastGood).toBe(0);
		expect(s.calls.get - before.get).toBe(0);
		expect(s.calls.buckets).toBe(0);
	});

	it("lists a metric whose reading cannot be read as red, and keeps the rest of the list", async () => {
		const kpi = definition("kpi");
		const broken = definition("broken");
		const fine = definition("fine");
		const s = setup([kpi, broken, fine], { fine: [reading(fine, 1)] });
		const real = s.observations.workReadBatch!;
		s.observations.workReadBatch = async (requests, signal) =>
			(await real(requests, signal)).map((pair, index) =>
				requests[index]?.metricId === "broken"
					? {
							...pair,
							get latest(): MetricObservation | null {
								throw new Error("corrupt row");
							},
						}
					: pair,
			);

		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(read.servedUnavailable).toBeUndefined();
		expect(
			read.unbound?.map((u) => [
				u.metric.id,
				u.latest.viewState,
				u.latest.reason,
			]),
		).toEqual([
			["broken", "error", "source_failed"],
			["fine", "ok", null],
		]);
	});

	it("never lists an unreadable metric, and lists a metric with a bad annex only as an orphan", async () => {
		const kpi = definition("kpi");
		const secret = definition("secret");
		const open = definition("open");
		const badAnnex = definition("bad-annex", {
			annexInvalid: [
				{ field: "serves", issues: ["serves.role:invalid_value"] },
			],
		});
		const s = setup(
			[kpi, secret, open, badAnnex],
			{},
			async (d) => d.id !== "secret",
		);
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(read.unbound?.map((u) => u.metric.id)).toEqual(["open"]);
		expect(read.orphans?.map((o) => o.metricId)).toEqual(["bad-annex"]);
	});

	it("marks a cut scan and still lists the unbound metrics it reached", async () => {
		const defs = Array.from({ length: SERVES_SCAN_MAX + 5 }, (_, i) =>
			definition(`m${String(i).padStart(4, "0")}`),
		);
		const s = setup(defs);
		const read = await readGoalsProgress({
			goals: goals([]),
			metrics: s.service,
			environment: "test",
		});
		expect(read.servedTruncated).toBe(true);
		expect(read.unbound).toHaveLength(SERVES_SCAN_MAX);
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
		expect(read.unbound).toBeUndefined();
		expect(read.servedTruncated).toBeUndefined();
		expect(read.goals[0]?.kpis[0]).not.toHaveProperty("served");
	});

	it("does not fail the goal read when the authority is unavailable for a served metric", async () => {
		const kpi = definition("kpi");
		const m = definition("m", { serves: { kpi: "kpi", role: "input" } });
		const s = setup([kpi, m], { kpi: [reading(kpi, 60)] }, async (d) => {
			if (d.id === "m") throw new Error("offline");
			return true;
		});
		const read = await readGoalsProgress({
			goals: goals(),
			metrics: s.service,
			environment: "test",
		});
		expect(GoalsProgressSchema.parse(read)).toEqual(read);
		expect(read.servedUnavailable).toBe("metric_authority_unavailable");
		expect(read.orphans).toBeUndefined();
		expect(read.goals[0]?.kpis[0]?.served).toBeUndefined();
		// The KPI itself is still assessed.
		expect(read.goals[0]?.kpis[0]?.assessment.status).toBe("on_track");
	});

	it("lists a metric that serves a bet-only KPI as an orphan, and the bet-only KPI metric as unbound", async () => {
		const bet = definition("bet-kpi");
		const m = definition("m", {
			serves: { kpi: "bet-kpi", role: "diagnostic" },
		});
		const s = setup([bet, m]);
		const read = await readGoalsProgress({
			goals: {
				listGoals: async () => [
					{ id: "g", title: "G", evaluateAt: null, kpiBindings: [] },
				],
				hypotheses: async () => ({
					items: [
						{
							id: "h",
							title: "H",
							evaluateAt: "2026-12-01T00:00:00Z",
							outcome: null,
							kpiBindings: [
								{
									metricId: "bet-kpi",
									comparator: "gte",
									target: { value: 1, unit: "items" },
									evaluationAt: "2026-12-01T00:00:00Z",
									baselineObservationId: crypto.randomUUID(),
								},
							],
						},
					],
					more: false,
				}),
			},
			metrics: s.service,
			environment: "test",
		});
		// A bet's KPI is a valid target (not unknown), but no goal card lists the metric.
		expect(read.orphans?.map((o) => [o.metricId, o.reason])).toEqual([
			["m", "serves_bet_kpi"],
		]);
		// A bet-only KPI metric serves no goal KPI, so the read lists it rather than hiding it.
		expect(read.unbound?.map((u) => u.metric.id)).toEqual(["bet-kpi"]);
		expect(read.servedTruncated).toBe(false);
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

describe("bounded complete goal reads", () => {
	it("starts no follow-on reads when a native definition page settles after the deadline", async () => {
		vi.useFakeTimers();
		try {
			const authorized = vi.fn(async () => true);
			const s = setup([definition("kpi")], {}, authorized);
			let finish!: (page: {
				items: MetricDefinition[];
				nextCursor: string | null;
			}) => void;
			const list = vi.fn(
				() =>
					new Promise<{ items: MetricDefinition[]; nextCursor: string | null }>(
						(resolve) => {
							finish = resolve;
						},
					),
			);
			s.definitions.list = list;
			const citations = vi.fn(async () => []);
			const reader = createGoalProgressReader({
				metrics: () => s.service,
				knowledge: () => ({
					listActiveGoals: async () => [],
					getKnowledge: async () => null,
					listCitationsByCitedId: citations,
				}),
				environment: "test",
			});
			const pending = reader();
			const rejected = expect(pending).rejects.toMatchObject({
				code: "batch_unavailable",
				status: 503,
			});
			await vi.advanceTimersByTimeAsync(8000);
			await rejected;
			expect(list).toHaveBeenCalledTimes(1);
			finish({ items: [definition("kpi")], nextCursor: "kpi" });
			await vi.advanceTimersByTimeAsync(0);
			expect(s.calls.batch).toBe(0);
			expect(authorized).not.toHaveBeenCalled();
			expect(citations).not.toHaveBeenCalled();
			expect(list).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops after an in-flight authorization and forwards cancellation to batches", async () => {
		let finish!: (allowed: boolean) => void;
		const s = setup(
			[definition("a"), definition("b")],
			{},
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new AbortController();
		const pending = s.service.serving(controller.signal);
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();
		finish(true);
		await expect(pending).rejects.toBeDefined();
		expect(s.calls.batch).toBe(0);

		const healthy = setup([definition("a")]);
		const originalBatch = healthy.observations.workReadBatch;
		if (!originalBatch) throw new Error("batch unavailable");
		const batch = vi.fn(originalBatch);
		healthy.observations.workReadBatch = batch;
		const signal = new AbortController().signal;
		await healthy.service.serving(signal);
		expect(batch).toHaveBeenCalledWith(expect.any(Array), signal);
	});

	it("renders all measurements, charts and seven supports inside the unchanged deadline", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(NOW);
			const pause = () =>
				new Promise<void>((resolve) => setTimeout(resolve, 100));
			const kpis = Array.from({ length: 6 }, (_, i) => definition(`kpi-${i}`));
			const supports = Array.from({ length: 7 }, (_, i) =>
				definition(`support-${i}`, {
					serves: { kpi: "kpi-0", role: "input" },
				}),
			);
			const defs = [...kpis, ...supports];
			const readings = Object.fromEntries(
				defs.map((d, i) => [d.id, [reading(d, i === 1 ? 24 : 8)]]),
			);
			const s = setup(defs, readings);
			s.observations.workReadBatch = async (requests) => {
				await pause();
				return requests.map((r) => ({
					baseline: null,
					latest: readings[r.metricId]?.[0] ?? null,
					lastGood: readings[r.metricId]?.[0] ?? null,
				}));
			};
			s.observations.buckets = async (id, _hash, range) => {
				s.calls.buckets++;
				await pause();
				return bucketObservations(
					readings[id] ?? [],
					metricHistoryRange(range, NOW, { allowOpenBucket: true }),
				);
			};
			const body = vi.fn(async () => {
				throw new Error("goal body must already be projected");
			});
			const reader = createGoalProgressReader({
				metrics: () => s.service,
				knowledge: () => ({
					listActiveGoals: async () => {
						await pause();
						return Array.from({ length: 3 }, (_, i) => ({
							id: `goal-${i}`,
							title: `Goal ${i}`,
							evaluateAt: null,
							kpiBindings: kpis.slice(i * 2, i * 2 + 2).map((d) => ({
								metricId: d.id,
								comparator: "gte",
								target: { value: 24, unit: "items" },
							})),
						}));
					},
					getKnowledge: body,
					listCitationsByCitedId: async () => {
						await pause();
						return [];
					},
				}),
				environment: "test",
			});
			const pending = reader();
			expect(reader()).toBe(pending);
			await vi.advanceTimersByTimeAsync(1200);
			const result = await pending;
			expect(result.asOf).toBe(NOW.toISOString());
			expect(result.goals.map((g) => g.id)).toEqual([
				"goal-0",
				"goal-1",
				"goal-2",
			]);
			expect(result.goals[0]?.kpis.map((k) => k.assessment.value)).toEqual([
				8, 24,
			]);
			expect(result.goals[0]?.kpis[0]?.served).toHaveLength(7);
			for (const goal of result.goals)
				for (const kpi of goal.kpis) {
					expect(kpi.trend?.buckets).toHaveLength(30);
					expect(kpi.recent?.buckets).toHaveLength(24);
				}
			expect(s.calls).toMatchObject({
				get: 0,
				history: 0,
				lastGood: 0,
				buckets: 12,
			});
			expect(body).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["ok", "zero", "pending", "error", "missing", "stale"] as const)(
		"preserves %s through request-local reuse",
		async (state) => {
			const d = definition("kpi");
			const good = reading(d, state === "zero" ? 0 : 8);
			let rows = [good];
			if (state === "pending" || state === "error")
				rows = [
					{
						...good,
						status: state,
						value: null,
						reason: state === "error" ? "source_failed" : null,
					},
					good,
				];
			if (state === "missing") rows = [];
			if (state === "stale")
				rows = [
					{
						...good,
						window: {
							start: "2020-01-01T00:00:00Z",
							end: "2020-01-01T00:00:00Z",
						},
					},
				];
			const s = setup([d], { kpi: rows });
			const binding = {
				metricId: "kpi",
				comparator: "gte" as const,
				target: { value: 24, unit: "items" },
			};
			const direct = await s.service.kpi(binding);
			const scan = await s.service.serving();
			const before = { ...s.calls };
			expect(await scan.readKpi(binding)).toEqual(direct);
			expect(s.calls.get).toBe(before.get);
			expect(s.calls.history).toBe(before.history);
			expect(s.calls.lastGood).toBe(before.lastGood);
		},
	);

	it("waits for every native KPI read when a sibling fails", async () => {
		const d = definition("kpi");
		const s = setup([d]);
		const finishes: ((rows: []) => void)[] = [];
		s.observations.history = async () => {
			throw new Error("source failed");
		};
		s.observations.buckets = () =>
			new Promise<[]>((resolve) => finishes.push(resolve));
		let returned = false;
		const pending = s.service
			.kpi({
				metricId: "kpi",
				comparator: "gte",
				target: { value: 24, unit: "items" },
			})
			.then((result) => {
				returned = true;
				return result;
			});
		await vi.waitFor(() => expect(finishes).toHaveLength(2));
		expect(returned).toBe(false);
		finishes[0]?.([]);
		await Promise.resolve();
		expect(returned).toBe(false);
		finishes[1]?.([]);
		expect(await pending).toMatchObject({
			viewState: "error",
			assessment: { reason: "source_failed" },
		});
	});

	it("reauthorizes reused readings and never substitutes them for pinned evidence", async () => {
		const d = definition("kpi");
		let allowed = true;
		let available = true;
		const s = setup([d], { kpi: [reading(d, 8)] }, async () => {
			if (!available) throw new Error("authority unavailable");
			return allowed;
		});
		const scan = await s.service.serving();
		const binding = {
			metricId: "kpi",
			comparator: "gte" as const,
			target: { value: 24, unit: "items" },
		};
		const pinned = {
			...binding,
			baselineObservationId: crypto.randomUUID(),
			evaluationAt: NOW.toISOString(),
		};
		const snapshot = vi.spyOn(s.observations, "snapshot");
		expect((await scan.readKpi(pinned)).assessment.reason).toBe(
			"baseline_unavailable_or_incompatible",
		);
		expect(snapshot).toHaveBeenCalledWith(pinned.baselineObservationId);
		expect(s.calls.get).toBe(1);
		allowed = false;
		expect((await scan.readKpi(binding)).assessment.reason).toBe(
			"metric_unavailable",
		);
		expect(s.calls.history).toBe(0);
		available = false;
		expect((await scan.readKpi(binding)).assessment.reason).toBe(
			"metric_authority_unavailable",
		);
	});
});
