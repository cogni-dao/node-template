// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * brief.conformance@1 and its two package-served definitions: the source read
 * and its caps, the failure map, built-in resolution beside hub rows, paging,
 * and one terminal log event per computation.
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { briefEvidenceRefs, scoreBrief, summarizeBriefs } from "../src/briefs.js";
import {
	BUILTIN_METRIC_REVISION,
	BUILTIN_METRICS,
	createGoalMetrics,
	PACKAGE_CALCULATOR_IDS,
	RESERVED_CALCULATOR_FAMILIES,
} from "../src/knowledge.js";
import {
	BRIEF_MAX_BYTES,
	BRIEF_MAX_ROWS,
	briefConformanceSql,
	readBriefConformance,
} from "../src/sources.js";

type Row = Record<string, unknown>;
const signal = new AbortController().signal;
const GOAL = "Goal = Measure briefs weekly";
const DONE = "Done when = A reading appears on candidate";

/** Fake Sql whose `unsafe` answers from a function and records every statement. */
function fakeSql(answer: (text: string) => Row[] | Promise<Row[]>) {
	const queries: string[] = [];
	const sql = {
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(() => answer(text));
			return Object.assign(p, { cancel: () => undefined });
		},
	} as unknown as Sql;
	return { sql, queries };
}
const ASOF = "2026-11-08T00:00:00.000Z";
/** What the one statement returns when the scope is inside the caps. */
const joined = (rows: Row[], bytes = 1000) =>
	rows.map((r) => ({
		as_of: ASOF,
		n: String(rows.length),
		bytes: String(bytes),
		oversize: false,
		...r,
	}));
const itemRow = (id: string, outcome: string, extra: Row = {}): Row => ({
	id,
	title: "A title",
	summary: "A summary.",
	outcome,
	...extra,
});
const entryRow = (id: string, extra: Row = {}): Row => ({
	id,
	title: "A title",
	use_when: "choosing a metric",
	content: "A short body.",
	...extra,
});

describe("brief.conformance@1 source read", () => {
	it("issues exactly one statement per compute and scores every row", async () => {
		const { sql, queries } = fakeSql(() =>
			joined([
				itemRow("task.1", `${GOAL}\n${DONE}`),
				itemRow("task.2", "no approved lines"),
				itemRow("task.3", `${GOAL}\n${DONE}\nUpdate: shipped`),
				itemRow("task.4", `${GOAL}\n${DONE}`, { summary: Array(40).fill("alpha").join(" ") }),
			]),
		);
		const sample = await readBriefConformance(sql, "items", 0.1, signal);
		expect(queries).toHaveLength(1);
		// task.2 breaks only human-gated rules, so it passes and stays counted.
		expect(sample).toMatchObject({ value: 50, unit: "%", complete: true });
		expect(sample.sourceWatermarks).toEqual([{ source: "node.work_items", asOf: ASOF }]);
		expect(sample.evidenceRefs).toEqual([
			"counts:evaluated=4;passing=2",
			"rule:no_goal=1",
			"rule:no_done_when=1",
			"rule:approved_line_long=0",
			"rule:log_block=1",
			"rule:long_sentences=1",
			"rule:unbounded_text=0",
			"human_gated_failing=1",
			"worst:task.3:log_block",
			"worst:task.4:long_sentences",
		]);
	});

	it("never puts row text in evidence", async () => {
		const secret = "SECRET-BODY-TEXT";
		const { sql } = fakeSql(() => joined([entryRow("e1", { content: `Update: ${secret}` })]));
		const sample = await readBriefConformance(sql, "entries", 0.1, signal);
		expect(sample.evidenceRefs.join("\n")).not.toContain(secret);
		expect(sample.sourceWatermarks[0]?.source).toBe("node.knowledge");
	});

	it("reads two computes over frozen rows as equal", async () => {
		const rows = joined([
			entryRow("e1"),
			entryRow("e2", { use_when: "" }),
			entryRow("e3", { content: "Update: x" }),
		]);
		const { sql } = fakeSql(() => rows);
		const a = await readBriefConformance(sql, "entries", 0.1, signal);
		const b = await readBriefConformance(sql, "entries", 0.1, signal);
		expect(b).toEqual(a);
		expect(a.value).toBeCloseTo(100 / 3, 10);
	});

	it("scores 700 briefs of 6 KB inside the budget", async () => {
		const body = `${"Alpha beta gamma. ".repeat(350)}`;
		const rows = joined(
			Array.from({ length: 700 }, (_, i) => entryRow(`e${String(i).padStart(4, "0")}`, { content: body })),
			700 * 6300,
		);
		const { sql, queries } = fakeSql(() => rows);
		const started = Date.now();
		const sample = await readBriefConformance(sql, "entries", 0.1, signal);
		expect(Date.now() - started).toBeLessThan(15000);
		expect(queries).toHaveLength(1);
		expect(sample).toMatchObject({ value: 100, complete: true });
		expect(sample.evidenceRefs[0]).toBe("counts:evaluated=700;passing=700");
	});

	it("maps an empty scope to zero_denominator, never 0", async () => {
		const { sql } = fakeSql(() => [{ as_of: ASOF, n: "0", bytes: "0", id: null }]);
		expect(await readBriefConformance(sql, "items", 0.1, signal)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
		const none = fakeSql(() => []);
		expect(await readBriefConformance(none.sql, "items", 0.1, signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it.each([
		["rows", { n: String(BRIEF_MAX_ROWS + 1), bytes: "10" }],
		["bytes", { n: "10", bytes: String(BRIEF_MAX_BYTES + 1) }],
	])("maps a cap hit on %s to incomplete_or_invalid_source without scoring", async (_cap, totals) => {
		// Over a cap the statement answers with the totals row alone.
		const { sql } = fakeSql(() => [{ as_of: ASOF, id: null, ...totals }]);
		const sample = await readBriefConformance(sql, "entries", 0.1, signal);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs.join()).toContain("cap_hit");
	});

	it("refuses a result that disagrees with its own row count", async () => {
		const { sql } = fakeSql(() => joined([entryRow("e1")]).map((r) => ({ ...r, n: "2" })));
		expect(await readBriefConformance(sql, "entries", 0.1, signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it("maps any other read error to source_failed and keeps a timeout its own failure", async () => {
		const failing = fakeSql(() => {
			throw new Error("relation does not exist");
		});
		expect(await readBriefConformance(failing.sql, "items", 0.1, signal)).toMatchObject({
			complete: false,
			reason: "source_failed",
		});
		const controller = new AbortController();
		const slow = fakeSql(async () => {
			controller.abort();
			throw new Error("canceled");
		});
		await expect(readBriefConformance(slow.sql, "items", 0.1, controller.signal)).rejects.toThrow();
	});

	it("flags an oversize field the statement sent absent", async () => {
		const { sql } = fakeSql(() => joined([entryRow("e1", { content: null, oversize: true })]));
		const sample = await readBriefConformance(sql, "entries", 0.1, signal);
		expect(sample.value).toBe(0);
		expect(sample.complete).toBe(true);
		expect(sample.evidenceRefs).toContain("rule:unbounded_text=1");
	});

	it("agrees with the pure scorer row by row", async () => {
		const rows = [entryRow("a", { content: "Update: x" }), entryRow("b")];
		const { sql } = fakeSql(() => joined(rows));
		const sample = await readBriefConformance(sql, "entries", 0.1, signal);
		const expected = summarizeBriefs(
			"entries",
			rows.map((r) => ({ id: String(r.id), broken: scoreBrief("entries", { title: "A title", use_when: "choosing a metric", content: String(r.content) }, 0.1).broken })),
		);
		expect(sample.evidenceRefs).toEqual(briefEvidenceRefs(expected));
	});
});

describe("brief.conformance@1 statement", () => {
	it("is one read-only statement that pushes the caps and scope into the database", () => {
		for (const subject of ["items", "entries"] as const) {
			const text = briefConformanceSql(subject);
			expect(text).not.toContain(";");
			expect(text.startsWith("WITH scope AS")).toBe(true);
			expect(text).toContain(`t.n <= ${BRIEF_MAX_ROWS}`);
			expect(text).toContain(`t.bytes <= ${BRIEF_MAX_BYTES}`);
			// Over-cap fields are sent absent and the bytes are summed over the capped text.
			expect(text).toContain("char_length(");
			expect(text).toContain("> 100000 THEN NULL");
			expect(text).toContain("CAST(COALESCE(SUM(");
			expect(text).toContain("LEFT JOIN scope s ON");
			expect(text).toContain("ORDER BY s.id");
			expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
		}
		const items = briefConformanceSql("items");
		expect(items).toContain("status NOT IN ('done','cancelled')");
		expect(items).toContain('"test-fixture"');
		expect(items).toContain('"synthetic"');
		expect(items).toContain('"synthetic-fixture"');
		expect(items).toContain("s.title, s.summary, s.outcome");
		const entries = briefConformanceSql("entries");
		expect(entries).toContain("status <> 'deprecated'");
		expect(entries).toContain("entry_type <> 'html'");
		expect(entries).toContain('"test-fixture"');
		expect(entries).toContain("[TEST]");
		expect(entries).toContain("s.title, s.use_when, s.content");
	});
});

describe("brief.conformance@1 in the goal-metric service", () => {
	/** In-memory stand-in for the observation adapter's tagged-template SQL. */
	function memoryObservations() {
		let row: Row | undefined;
		const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?");
			if (text.startsWith("INSERT INTO execution_requests"))
				return Promise.resolve([{ run_id: values[2] }]);
			if (text.startsWith("INSERT INTO metric_observations")) {
				row = { id: values[0], snapshot: values[6], observation: values[7] };
				return Promise.resolve([row]);
			}
			if (text.startsWith("UPDATE metric_observations SET lease_token"))
				return Promise.resolve(row ? [row] : []);
			if (text.startsWith("UPDATE metric_observations SET observation="))
				return Promise.resolve([{ observation: values[0] }]);
			return Promise.resolve([]);
		}) as unknown as Sql & { begin: unknown };
		Object.assign(sql, { begin: (fn: (tx: Sql) => Promise<unknown>) => fn(sql) });
		return sql;
	}
	const noObservations = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;

	/** A hub that answers the definition reads and the brief statement. */
	function hub(hubRows: Row[], briefRows: Row[] = []) {
		const events: object[] = [];
		const knowledge = fakeSql((text) => {
			if (text.startsWith("WITH scope AS")) return briefRows;
			const one = /WHERE id='([^']+)'/.exec(text)?.[1];
			if (one)
				return hubRows
					.filter((r) => r.id === one)
					// The plain id read keeps its metric and status filters.
					.filter((r) => !text.includes("AND metric_spec IS NOT NULL") || (r.metric_spec != null && r.status !== "deprecated"));
			const ids = /WHERE id IN \(([^)]*)\)/.exec(text)?.[1];
			if (ids !== undefined) {
				const wanted = ids.split(",").map((x) => x.replace(/'/g, ""));
				return hubRows.filter((r) => wanted.includes(String(r.id))).map((r) => ({ id: r.id }));
			}
			const after = /AND id > '([^']+)'/.exec(text)?.[1];
			const limit = Number(/LIMIT (\d+)/.exec(text)?.[1] ?? 50);
			return hubRows
				.filter((r) => r.metric_spec != null && r.status !== "deprecated")
				.filter((r) => !after || String(r.id) > after)
				.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
				.slice(0, limit);
		});
		const service = createGoalMetrics({
			knowledgeSql: knowledge.sql,
			observationsSql: memoryObservations(),
			node: "node-template",
			environment: "test",
			log: (event) => events.push(event),
		});
		const reader = createGoalMetrics({
			knowledgeSql: knowledge.sql,
			observationsSql: noObservations,
			node: "node-template",
			environment: "test",
			log: (event) => events.push(event),
		});
		return { service, reader, events, queries: knowledge.queries };
	}
	const count = (id: string, extra: Row = {}): Row => ({
		id,
		title: id,
		metric_spec: { calculatorId: "work.count@1", params: { mode: "open" }, maxAgeSeconds: 120 },
		updated_at: "2026-11-01T00:00:00Z",
		status: "active",
		...extra,
	});
	const ids = (items: Array<{ definition: { id: string } }>) => items.map((v) => v.definition.id);

	it("publishes the calculator in the reserved set with its single-statement budget", () => {
		expect(PACKAGE_CALCULATOR_IDS).toContain("brief.conformance@1");
		expect(RESERVED_CALCULATOR_FAMILIES.has("brief.conformance")).toBe(true);
		const { reader } = hub([]);
		const calc = reader.registry.get("brief.conformance@1");
		expect(calc.unit).toBe("%");
		expect(calc.budget).toEqual({
			timeoutMs: 15000,
			maxSourceCalls: 1,
			maxRows: 5000,
			maxResponseBytes: 16_777_216,
		});
		// Registered after the three older calculators, before node calculators.
		expect(reader.registry.describe().map((c) => c.id)).toEqual([
			"work.count@1",
			"work.convergence@1",
			"github.stars@1",
			"brief.conformance@1",
		]);
	});

	it("takes a strict flat params schema", () => {
		const { reader } = hub([]);
		const schema = reader.registry.get("brief.conformance@1").paramsSchema;
		expect(schema.safeParse({ subject: "items", maxLongShare: 0.1 }).success).toBe(true);
		expect(schema.safeParse({ subject: "entries", maxLongShare: 0 }).success).toBe(true);
		expect(schema.safeParse({ subject: "entries", maxLongShare: 0.5 }).success).toBe(true);
		for (const bad of [
			{ subject: "goals", maxLongShare: 0.1 },
			{ subject: "items", maxLongShare: 0.51 },
			{ subject: "items", maxLongShare: -0.1 },
			{ subject: "items" },
			{ subject: "items", maxLongShare: 0.1, extra: 1 },
		])
			expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
	});

	it("serves both built-in definitions with the designed spec while main holds no metric row", async () => {
		const { reader } = hub([]);
		expect(BUILTIN_METRICS.map((b) => b.id)).toEqual(["brief-conformance-entries", "brief-conformance-items"]);
		for (const [id, subject] of [
			["brief-conformance-items", "items"],
			["brief-conformance-entries", "entries"],
		] as const) {
			const view = await reader.read(id);
			expect(view.definition).toMatchObject({
				id,
				revision: BUILTIN_METRIC_REVISION,
				spec: {
					calculatorId: "brief.conformance@1",
					params: { subject, maxLongShare: 0.1 },
					cadenceSeconds: 3600,
					maxAgeSeconds: 7200,
				},
				display: "progress",
			});
		}
		expect(BUILTIN_METRIC_REVISION).toBe("builtin:brief-rules@1");
	});

	it("computes a built-in end to end with one terminal log event carrying its reason", async () => {
		const briefRows = joined([entryRow("e1"), entryRow("e2", { use_when: "" })]);
		const { service, events, queries } = hub([], briefRows);
		const saved = await service.compute("brief-conformance-entries", { requestKey: "k1" });
		expect(saved).toMatchObject({ status: "ok", value: 50, unit: "%", reason: null });
		expect(saved.evidenceRefs).toContain("counts:evaluated=2;passing=1");
		expect(queries.filter((q) => q.startsWith("WITH scope AS"))).toHaveLength(1);
		const terminal = events.filter((e) => (e as { event: string }).event === "metric.compute.completed");
		expect(terminal).toEqual([
			expect.objectContaining({
				metricId: "brief-conformance-entries",
				status: "ok",
				reason: null,
			}),
		]);
	});

	it("records an unknown reading with its reason on the one terminal event", async () => {
		const { service, events } = hub([], [{ as_of: ASOF, n: "0", bytes: "0", id: null }]);
		const saved = await service.compute("brief-conformance-items", { requestKey: "k2" });
		expect(saved).toMatchObject({ status: "unavailable", value: null, reason: "zero_denominator" });
		expect(events.filter((e) => (e as { event: string }).event === "metric.compute.completed")).toEqual([
			expect.objectContaining({ status: "unavailable", reason: "zero_denominator" }),
		]);
	});

	describe("hub row beside a built-in", () => {
		it("lets a hub row win in get, whatever its params", async () => {
			const row = count("brief-conformance-items");
			const { reader } = hub([row]);
			const view = await reader.read("brief-conformance-items");
			expect(view.definition.spec.calculatorId).toBe("work.count@1");
			expect(view.definition.revision).toBe("2026-11-01T00:00:00.000Z");
		});

		it("never falls back to the built-in for a deprecated hub row, and logs it", async () => {
			const { reader, events } = hub([count("brief-conformance-items", { status: "deprecated" })]);
			await expect(reader.read("brief-conformance-items")).rejects.toMatchObject({
				code: "metric_not_found",
				status: 404,
			});
			expect(events).toContainEqual({ event: "metric.definition_invalid", metricId: "brief-conformance-items" });
			// The other built-in is untouched.
			expect((await reader.read("brief-conformance-entries")).definition.id).toBe("brief-conformance-entries");
		});

		it("never falls back to the built-in for an invalid or non-metric hub row", async () => {
			const bad = count("brief-conformance-items", { metric_spec: '{"calculatorId":"nope"}' });
			const plain = count("brief-conformance-entries", { metric_spec: null });
			const { reader, events } = hub([bad, plain]);
			for (const id of ["brief-conformance-items", "brief-conformance-entries"])
				await expect(reader.read(id)).rejects.toMatchObject({ code: "metric_not_found" });
			expect(events.map((e) => (e as { metricId: string }).metricId).sort()).toEqual([
				"brief-conformance-entries",
				"brief-conformance-items",
			]);
		});

		it("keeps the old rule for ids that are not built-ins: a deprecated row is simply absent", async () => {
			const { reader, events } = hub([count("other", { status: "deprecated" })]);
			await expect(reader.read("other")).rejects.toMatchObject({ code: "metric_not_found" });
			expect(events).toEqual([]);
		});
	});

	describe("list merges one hub page with the built-ins by id", () => {
		async function walk(service: ReturnType<typeof hub>["reader"], limit: number) {
			const seen: string[] = [];
			let after: string | undefined;
			for (let page = 0; page < 20; page++) {
				const r = await service.list(limit, after);
				expect(r.items.length).toBeLessThanOrEqual(limit);
				seen.push(...ids(r.items));
				if (!r.nextCursor) return seen;
				after = r.nextCursor;
			}
			throw new Error("paging did not end");
		}

		it.each([1, 2, 3, 50])("lists every id once, in id order, at page size %i", async (limit) => {
			const { reader } = hub([count("a-count"), count("m-count"), count("z-count")]);
			expect(await walk(reader, limit)).toEqual([
				"a-count",
				"brief-conformance-entries",
				"brief-conformance-items",
				"m-count",
				"z-count",
			]);
		});

		it("lists only the built-ins when the hub has no metric rows, and only those after the cursor", async () => {
			const { reader } = hub([]);
			expect(ids((await reader.list(50)).items)).toEqual(["brief-conformance-entries", "brief-conformance-items"]);
			expect(ids((await reader.list(50, "brief-conformance-entries")).items)).toEqual(["brief-conformance-items"]);
			expect((await reader.list(50, "brief-conformance-items")).items).toEqual([]);
			const first = await reader.list(1);
			expect(ids(first.items)).toEqual(["brief-conformance-entries"]);
			expect(first.nextCursor).toBe("brief-conformance-entries");
		});

		it("lists a built-in only when no hub row of any status holds its id", async () => {
			const hubRows = [
				count("brief-conformance-items"),
				count("brief-conformance-entries", { status: "deprecated" }),
			];
			const { reader } = hub(hubRows);
			for (const limit of [1, 50]) {
				const seen = await walk(reader, limit);
				// The hub row of the items id is listed once; the deprecated entries row is not, and its built-in stays hidden.
				expect(seen).toEqual(["brief-conformance-items"]);
			}
			const items = (await reader.list(50)).items;
			expect(items[0]?.definition.spec.calculatorId).toBe("work.count@1");
		});

		it("hides a built-in whose hub row is invalid, and logs the invalid row", async () => {
			const { reader, events } = hub([count("brief-conformance-entries", { metric_spec: '{"calculatorId":"nope"}' })]);
			expect(await walk(reader, 50)).toEqual(["brief-conformance-items"]);
			expect(events).toContainEqual({ event: "metric.definition_invalid", metricId: "brief-conformance-entries" });
		});

		it("never advances a page past a hub row the page left out", async () => {
			// Page of 2 with the built-ins landing between hub rows: nothing skipped or repeated.
			const { reader } = hub([count("brief-a"), count("brief-conformance-f"), count("brief-z")]);
			const seen = await walk(reader, 2);
			expect(seen).toEqual(["brief-a", "brief-conformance-entries", "brief-conformance-f", "brief-conformance-items", "brief-z"]);
		});
	});
});
