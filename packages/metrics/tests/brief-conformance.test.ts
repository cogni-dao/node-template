// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * brief.conformance@1: the source read and its caps, the failure map, and one
 * terminal log event per computation of a reviewed hub definition. The package
 * serves no definition of its own (see definitions.test.ts).
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { briefEvidenceRefs, scoreBrief, summarizeBriefs } from "../src/briefs.js";
import {
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
			"no-inline-history@1",
			"work.cite-share@1",
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

	const briefRow = (id: string, subject: "items" | "entries"): Row => ({
		id,
		title: id,
		metric_spec: {
			calculatorId: "brief.conformance@1",
			params: { subject, maxLongShare: 0.1 },
			cadenceSeconds: 3600,
			maxAgeSeconds: 7200,
		},
		updated_at: "2026-11-01T00:00:00Z",
		status: "active",
	});

	it("computes a reviewed hub definition end to end with one terminal log event carrying its reason", async () => {
		const briefRows = joined([entryRow("e1"), entryRow("e2", { use_when: "" })]);
		const { service, events, queries } = hub([briefRow("brief-entries", "entries")], briefRows);
		const saved = await service.compute("brief-entries", { requestKey: "k1" });
		expect(saved).toMatchObject({ status: "ok", value: 50, unit: "%", reason: null });
		expect(saved.evidenceRefs).toContain("counts:evaluated=2;passing=1");
		expect(queries.filter((q) => q.startsWith("WITH scope AS"))).toHaveLength(1);
		const terminal = events.filter((e) => (e as { event: string }).event === "metric.compute.completed");
		expect(terminal).toEqual([
			expect.objectContaining({
				metricId: "brief-entries",
				status: "ok",
				reason: null,
			}),
		]);
	});

	it("records an unknown reading with its reason on the one terminal event", async () => {
		const { service, events } = hub([briefRow("brief-items", "items")], [{ as_of: ASOF, n: "0", bytes: "0", id: null }]);
		const saved = await service.compute("brief-items", { requestKey: "k2" });
		expect(saved).toMatchObject({ status: "unavailable", value: null, reason: "zero_denominator" });
		expect(events.filter((e) => (e as { event: string }).event === "metric.compute.completed")).toEqual([
			expect.objectContaining({ status: "unavailable", reason: "zero_denominator" }),
		]);
	});
});
