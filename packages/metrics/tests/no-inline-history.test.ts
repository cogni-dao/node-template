// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * no-inline-history@1: the state and scope source reads with their caps and
 * failure map, the calculator in the goal-metric service, and the removal of
 * package-served definitions (definitions are hub rows only).
 */
import { describe, expect, it } from "vitest";
import {
	calculatorFamily,
	createGoalMetrics,
	PACKAGE_CALCULATOR_IDS,
	RESERVED_CALCULATOR_FAMILIES,
} from "../src/knowledge.js";
import * as knowledge from "../src/knowledge.js";
import {
	readNoInlineHistoryScope,
	readNoInlineHistoryState,
	NO_INLINE_HISTORY_MAX_BYTES,
	NO_INLINE_HISTORY_MAX_ROWS,
	noInlineHistoryStateSql,
} from "../src/sources.js";
import { fakeSql, hub, metricRow, noObservations, type Row } from "./fakes.js";

const signal = new AbortController().signal;
const ASOF = "2026-11-09T12:00:00.000Z";

/* ---------------------------------------------------------------- state */

const GOAL = "Goal = Work items say what is true now";
const DONE = "Done when = Three KPIs show on the Goals tab";
const joined = (rows: Row[], bytes = 1000) =>
	rows.map((r) => ({ as_of: ASOF, n: String(rows.length), bytes: String(bytes), oversize: false, ...r }));
const itemRow = (id: string, outcome: string, extra: Row = {}): Row => ({
	id,
	title: "A title",
	summary: "A summary.",
	outcome,
	...extra,
});
const atomRow = (id: string, extra: Row = {}): Row => ({
	id,
	title: "A title",
	use_when: "choosing a metric",
	content: "A short body.",
	...extra,
});

describe("no-inline-history@1 state read", () => {
	it("issues one statement and scores every open work item", async () => {
		const { sql, queries } = fakeSql(() =>
			joined([
				itemRow("task.1", `${GOAL}\n${DONE}`),
				itemRow("task.2", "no approved lines"),
				itemRow("task.3", `${GOAL}\n${DONE}\nUpdate: shipped\nRev 3`),
				itemRow("task.4", `${GOAL}\n${DONE}`, { summary: "~~old~~ new" }),
				// A lone approval date and a checklist pass.
				itemRow("task.5", `${GOAL}\n${DONE}\nApproved on 2026-11-01:\n- [ ] 2026-11-02 a\n- [ ] Update: b`),
			]),
		);
		const sample = await readNoInlineHistoryState(sql, "work-items", signal);
		expect(queries).toHaveLength(1);
		expect(sample).toMatchObject({ value: 60, unit: "%", complete: true });
		expect(sample.sourceWatermarks).toEqual([{ source: "node.work_items", asOf: ASOF }]);
		expect(sample.evidenceRefs).toEqual([
			"rules:no-inline-history-rules@1",
			"counts:evaluated=5;passing=3",
			"rule:dated_line=0",
			"rule:label_line=1",
			"rule:revision_tag=1",
			"rule:caps_marker=0",
			"rule:review_transcript=0",
			"rule:strikethrough=1",
			"rule:oversize=0",
			// Never part of the value: task.2 lacks both lines, nothing else does.
			"missing_goal=1;missing_done_when=1",
			"worst:task.3:label_line+revision_tag",
			"worst:task.4:strikethrough",
		]);
	});

	it("scores active atoms over title, use_when and content, with no missing-line evidence", async () => {
		const { sql } = fakeSql(() =>
			joined([
				atomRow("e1"),
				atomRow("e2", { use_when: "Update: x" }),
				atomRow("e3", { content: "2026-11-01 a\n2026-11-02 b" }),
				atomRow("e4", { content: "Single 2026-11-01 date" }),
			]),
		);
		const sample = await readNoInlineHistoryState(sql, "atoms", signal);
		expect(sample).toMatchObject({ value: 50, unit: "%", complete: true });
		expect(sample.sourceWatermarks[0]?.source).toBe("node.knowledge");
		expect(sample.evidenceRefs).toContain("counts:evaluated=4;passing=2");
		expect(sample.evidenceRefs).toContain("rule:dated_line=1");
		expect(sample.evidenceRefs.some((r) => r.startsWith("missing_goal"))).toBe(false);
	});

	it("never puts row text in evidence and reads frozen rows as equal", async () => {
		const secret = "SECRET-BODY-TEXT";
		const { sql } = fakeSql(() => joined([atomRow("e1", { content: `Update: ${secret}` }), atomRow("e2")]));
		const a = await readNoInlineHistoryState(sql, "atoms", signal);
		const b = await readNoInlineHistoryState(sql, "atoms", signal);
		expect(b).toEqual(a);
		expect(a.evidenceRefs.join("\n")).not.toContain(secret);
	});

	it("maps an empty scope to zero_denominator, never 0", async () => {
		const { sql } = fakeSql(() => [{ as_of: ASOF, n: "0", bytes: "0", id: null }]);
		expect(await readNoInlineHistoryState(sql, "work-items", signal)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
		expect(await readNoInlineHistoryState(fakeSql(() => []).sql, "atoms", signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it.each([
		["rows", { n: String(NO_INLINE_HISTORY_MAX_ROWS + 1), bytes: "10" }],
		["bytes", { n: "10", bytes: String(NO_INLINE_HISTORY_MAX_BYTES + 1) }],
	])("fails closed on a cap hit on %s without scoring", async (_cap, totals) => {
		const { sql } = fakeSql(() => [{ as_of: ASOF, id: null, ...totals }]);
		const sample = await readNoInlineHistoryState(sql, "atoms", signal);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs.join()).toContain("cap_hit");
	});

	it("fails closed when the rows disagree with their own count", async () => {
		const { sql } = fakeSql(() => joined([atomRow("e1")]).map((r) => ({ ...r, n: "2" })));
		expect(await readNoInlineHistoryState(sql, "atoms", signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it("fails a row whose field the statement sent absent as oversize", async () => {
		const { sql } = fakeSql(() => joined([atomRow("e1", { content: null, oversize: true }), atomRow("e2")]));
		const sample = await readNoInlineHistoryState(sql, "atoms", signal);
		expect(sample).toMatchObject({ value: 50, complete: true });
		expect(sample.evidenceRefs).toContain("rule:oversize=1");
		expect(sample.evidenceRefs).toContain("worst:e1:oversize");
	});

	it("maps a read error to source_failed and keeps a timeout its own failure", async () => {
		const failing = fakeSql(() => {
			throw new RangeError("relation does not exist SECRET-BODY-TEXT");
		});
		const sample = await readNoInlineHistoryState(failing.sql, "work-items", signal);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		// The error class is observable; its message never is.
		expect(sample.evidenceRefs).toEqual(["error:RangeError"]);
		const controller = new AbortController();
		const slow = fakeSql(async () => {
			controller.abort();
			throw new Error("canceled");
		});
		await expect(readNoInlineHistoryState(slow.sql, "work-items", controller.signal)).rejects.toThrow();
	});

	it("sends the scope and caps to the database in one read-only statement", () => {
		const items = noInlineHistoryStateSql("work-items");
		expect(items).toContain("status NOT IN ('done','cancelled')");
		for (const label of ['"test-fixture"', '"synthetic"', '"synthetic-fixture"']) expect(items).toContain(label);
		expect(items).toContain("s.title, s.summary, s.outcome");
		const atoms = noInlineHistoryStateSql("atoms");
		expect(atoms).toContain("status <> 'deprecated'");
		expect(atoms).toContain("entry_type <> 'html'");
		expect(atoms).toContain("[TEST]");
		expect(atoms).toContain("s.title, s.use_when, s.content");
		for (const text of [items, atoms]) {
			expect(text).toContain(`t.n <= ${NO_INLINE_HISTORY_MAX_ROWS}`);
			expect(text).toContain(`t.bytes <= ${NO_INLINE_HISTORY_MAX_BYTES}`);
			expect(text).toContain("> 100000 THEN NULL");
			expect(text).not.toContain(";");
			expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
		}
	});
});

describe("no-inline-history@1 state statement", () => {
	// Captured from the statement before the brief.conformance calculator was retired;
	// the live KPIs read exactly this text.
	const WORK_ITEMS_SQL =
		"WITH scope AS (SELECT id, CASE WHEN char_length(title) > 100000 THEN NULL ELSE title END AS title, CASE WHEN char_length(summary) > 100000 THEN NULL ELSE summary END AS summary, CASE WHEN char_length(outcome) > 100000 THEN NULL ELSE outcome END AS outcome, COALESCE(CASE WHEN char_length(title) > 100000 THEN 0 ELSE octet_length(substr(title, 1, 100000)) END, 0) AS title_bytes, COALESCE(CASE WHEN char_length(summary) > 100000 THEN 0 ELSE octet_length(substr(summary, 1, 100000)) END, 0) AS summary_bytes, COALESCE(CASE WHEN char_length(outcome) > 100000 THEN 0 ELSE octet_length(substr(outcome, 1, 100000)) END, 0) AS outcome_bytes, (COALESCE(char_length(title), 0) > 100000 OR COALESCE(char_length(summary), 0) > 100000 OR COALESCE(char_length(outcome), 0) > 100000) AS oversize FROM work_items WHERE status NOT IN ('done','cancelled') AND (labels IS NULL OR (CAST(labels AS TEXT) NOT LIKE '%\"test-fixture\"%' AND CAST(labels AS TEXT) NOT LIKE '%\"synthetic\"%' AND CAST(labels AS TEXT) NOT LIKE '%\"synthetic-fixture\"%'))), totals AS (SELECT COUNT(*) AS n, CAST(COALESCE(SUM(title_bytes + summary_bytes + outcome_bytes), 0) AS BIGINT) AS bytes FROM scope) SELECT NOW() AS as_of, t.n, t.bytes, s.id, s.title, s.summary, s.outcome, s.oversize FROM totals t LEFT JOIN scope s ON t.n <= 5000 AND t.bytes <= 16777216 ORDER BY s.id";
	const ATOMS_SQL =
		"WITH scope AS (SELECT id, CASE WHEN char_length(title) > 100000 THEN NULL ELSE title END AS title, CASE WHEN char_length(use_when) > 100000 THEN NULL ELSE use_when END AS use_when, CASE WHEN char_length(content) > 100000 THEN NULL ELSE content END AS content, COALESCE(CASE WHEN char_length(title) > 100000 THEN 0 ELSE octet_length(substr(title, 1, 100000)) END, 0) AS title_bytes, COALESCE(CASE WHEN char_length(use_when) > 100000 THEN 0 ELSE octet_length(substr(use_when, 1, 100000)) END, 0) AS use_when_bytes, COALESCE(CASE WHEN char_length(content) > 100000 THEN 0 ELSE octet_length(substr(content, 1, 100000)) END, 0) AS content_bytes, (COALESCE(char_length(title), 0) > 100000 OR COALESCE(char_length(use_when), 0) > 100000 OR COALESCE(char_length(content), 0) > 100000) AS oversize FROM knowledge WHERE status <> 'deprecated' AND entry_type <> 'html' AND (tags IS NULL OR CAST(tags AS TEXT) NOT LIKE '%\"test-fixture\"%') AND title NOT LIKE '%[TEST]%'), totals AS (SELECT COUNT(*) AS n, CAST(COALESCE(SUM(title_bytes + use_when_bytes + content_bytes), 0) AS BIGINT) AS bytes FROM scope) SELECT NOW() AS as_of, t.n, t.bytes, s.id, s.title, s.use_when, s.content, s.oversize FROM totals t LEFT JOIN scope s ON t.n <= 5000 AND t.bytes <= 16777216 ORDER BY s.id";

	it("sends the same text for work items as before", () => {
		expect(noInlineHistoryStateSql("work-items")).toBe(WORK_ITEMS_SQL);
	});

	it("sends the same text for atoms as before", () => {
		expect(noInlineHistoryStateSql("atoms")).toBe(ATOMS_SQL);
	});
});

describe("no-inline-history@1 scope read", () => {
	it("counts open work items outside fixtures in one statement", async () => {
		const { sql, queries } = fakeSql(() => [{ as_of: ASOF, value: "73" }]);
		const sample = await readNoInlineHistoryScope(sql, signal);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("status NOT IN ('done','cancelled')");
		expect(sample).toMatchObject({ value: 73, unit: "items", complete: true });
		expect(sample.sourceWatermarks).toEqual([{ source: "node.work_items", asOf: ASOF }]);
		expect(sample.evidenceRefs).toContain("counts:evaluated=73");
	});

	it("keeps a real zero but never a missing count", async () => {
		expect(await readNoInlineHistoryScope(fakeSql(() => [{ as_of: ASOF, value: "0" }]).sql, signal)).toMatchObject({
			value: 0,
			complete: true,
		});
		expect(await readNoInlineHistoryScope(fakeSql(() => []).sql, signal)).toMatchObject({ complete: false });
	});
});

/* ------------------------------------------------------------- service */

const spec = {
	state: { measure: "state", subject: "work-items" },
	atoms: { measure: "state", subject: "atoms" },
	scope: { measure: "scope", subject: "work-items" },
} as const;
// The service reads the real clock: source times stay a minute behind it.
const live = (rows: Row[]): Row[] => {
	const asOf = new Date(Date.now() - 60_000).toISOString();
	return rows.map((r) => ("as_of" in r ? { ...r, as_of: asOf } : r));
};
const rowsFor = (text: string): Row[] => {
	if (text.startsWith("WITH scope AS") && text.includes("FROM work_items"))
		return live(joined([itemRow("task.1", `${GOAL}\n${DONE}`), itemRow("task.2", `${GOAL}\n${DONE}\nUpdate: x`)]));
	if (text.startsWith("WITH scope AS")) return live(joined([atomRow("e1")]));
	if (text.includes("COUNT(*) FROM work_items")) return live([{ as_of: ASOF, value: "73" }]);
	return [];
};
const noInlineHistoryRows = () => [
	metricRow("work-items-no-inline-history", "no-inline-history@1", spec.state),
	metricRow("atoms-no-inline-history", "no-inline-history@1", spec.atoms),
	metricRow("work-items-in-scope", "no-inline-history@1", spec.scope),
];

describe("no-inline-history@1 in the goal-metric service", () => {
	it("is a published calculator whose family no node calculator may take", () => {
		expect(PACKAGE_CALCULATOR_IDS).toContain("no-inline-history@1");
		expect(calculatorFamily("no-inline-history@1")).toBe("no-inline-history");
		expect(RESERVED_CALCULATOR_FAMILIES.has("no-inline-history")).toBe(true);
		const { reader } = hub([]);
		const node = {
			id: "no-inline-history@2",
			unit: "%",
			paramsSchema: reader.registry.get("no-inline-history@1").paramsSchema,
			budget: { timeoutMs: 1000, maxSourceCalls: 1, maxRows: 1, maxResponseBytes: 1024 },
			compute: async () => {
				throw new Error("unused");
			},
		};
		expect(() =>
			createGoalMetrics({
				knowledgeSql: fakeSql(() => []).sql,
				observationsSql: noObservations,
				node: "n",
				environment: "test",
				log: () => undefined,
				nodeCalculators: [node],
			}),
		).toThrow(expect.objectContaining({ code: "reserved_calculator_family", status: 422 }));
	});

	it("registers the retired brief.conformance@1 nowhere and keeps its family reserved", () => {
		const { reader } = hub([]);
		expect(reader.registry.describe().map((c) => c.id)).toEqual([
			"work.count@1",
			"work.convergence@1",
			"github.stars@1",
			"no-inline-history@1",
		]);
		expect(PACKAGE_CALCULATOR_IDS).not.toContain("brief.conformance@1");
		expect(RESERVED_CALCULATOR_FAMILIES.has("brief.conformance")).toBe(true);
		const calc = reader.registry.get("no-inline-history@1");
		expect(calc.budget).toEqual({
			timeoutMs: 15000,
			maxSourceCalls: 1,
			maxRows: 5000,
			maxResponseBytes: 16_777_216,
		});
		// Readings are of main now: no interval has a width.
		expect(calc.historicalWindows).toBeUndefined();
		expect(calc.windowSeconds).toBeUndefined();
		const unit = (params: unknown) => calc.unitFor?.(params);
		expect([spec.state, spec.atoms, spec.scope].map(unit)).toEqual(["%", "%", "items"]);
		const display = (params: unknown) => calc.displayFor?.(params);
		expect([spec.state, spec.scope].map(display)).toEqual(["progress", "volume"]);
	});

	it("takes the designed param shapes and nothing else", () => {
		const schema = hub([]).reader.registry.get("no-inline-history@1").paramsSchema;
		for (const ok of Object.values(spec)) expect(schema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
		for (const bad of [
			{ measure: "state" },
			{ measure: "state", subject: "goals" },
			{ measure: "state", subject: "atoms", extra: 1 },
			{ measure: "scope", subject: "atoms" },
			{ measure: "edits", output: "share", days: 7 },
			{ measure: "other", subject: "atoms" },
			{},
		])
			expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
	});

	it.each([
		["work-items-no-inline-history", 50, "%", "counts:evaluated=2;passing=1", 1],
		["atoms-no-inline-history", 100, "%", "counts:evaluated=1;passing=1", 1],
		["work-items-in-scope", 73, "items", "counts:evaluated=73", 1],
	])("computes %s end to end with one terminal log event and one source call", async (id, value, unit, evidence, calls) => {
		const { service, events, queries } = hub(noInlineHistoryRows(), rowsFor);
		const saved = await service.compute(id, { requestKey: `k-${id}` });
		expect(saved).toMatchObject({ status: "ok", unit, reason: null, calculatorVersion: "no-inline-history@1" });
		expect(saved.value).toBeCloseTo(value as number, 10);
		expect(saved.evidenceRefs).toContain(evidence);
		const source = queries.filter((q) => !q.startsWith("SELECT id,title,metric_spec"));
		expect(source).toHaveLength(calls as number);
		const terminal = events.filter((e) => (e as { event: string }).event === "metric.compute.completed");
		expect(terminal).toEqual([expect.objectContaining({ metricId: id, status: "ok", reason: null })]);
	});

	it("refuses a historical evaluation time, since state is read from main now", async () => {
		const { service } = hub(noInlineHistoryRows(), rowsFor);
		await expect(
			service.compute("work-items-no-inline-history", { requestKey: "k-hist", evaluationAt: "2026-11-01T00:00:00.000Z" }),
		).rejects.toMatchObject({ code: "historical_window_not_supported", status: 422 });
	});
});

/* ------------------------------------------- no package-served definitions */

const count = (id: string, extra: Row = {}) => metricRow(id, "work.count@1", { mode: "open" }, extra);
const ids = (items: Array<{ definition: { id: string } }>) => items.map((v) => v.definition.id);

describe("package-served definitions are gone", () => {
	it("exports no built-in definitions or revision", () => {
		expect(Object.keys(knowledge)).not.toContain("BUILTIN_METRICS");
		expect(Object.keys(knowledge)).not.toContain("BUILTIN_METRIC_REVISION");
	});

	it("reads a retired built-in id as absent while the hub holds no row", async () => {
		const { reader } = hub([]);
		for (const id of ["b-retired-items", "b-retired-entries"])
			await expect(reader.read(id)).rejects.toMatchObject({ code: "metric_not_found", status: 404 });
	});

	it("lists nothing when the hub has no metric row", async () => {
		const { reader } = hub([]);
		expect(await reader.list(50)).toMatchObject({ items: [], nextCursor: null });
	});

	it("serves a hub row of a retired built-in id exactly as any other row", async () => {
		const { reader } = hub([count("b-retired-items")]);
		const view = await reader.read("b-retired-items");
		expect(view.definition.spec.calculatorId).toBe("work.count@1");
		expect(view.definition.revision).toBe("2026-11-01T00:00:00.000Z");
		expect(ids((await reader.list(50)).items)).toEqual(["b-retired-items"]);
	});

	it("hides a deprecated hub row and logs nothing, as for any other id", async () => {
		const { reader, events } = hub([count("b-retired-items", { status: "deprecated" })]);
		await expect(reader.read("b-retired-items")).rejects.toMatchObject({ code: "metric_not_found" });
		expect(await reader.list(50)).toMatchObject({ items: [] });
		expect(events).toEqual([]);
	});

	it("logs and skips an invalid hub row without stopping the rest", async () => {
		const { reader, events } = hub([count("a-bad", { metric_spec: '{"calculatorId":"nope"}' }), count("b-good")]);
		expect(ids((await reader.list(50)).items)).toEqual(["b-good"]);
		expect(events).toContainEqual({ event: "metric.definition_invalid", metricId: "a-bad" });
	});

	it.each([1, 2, 3, 50])("pages hub rows alone, once each, at page size %i", async (limit) => {
		const { reader } = hub([count("a-count"), count("b-retired-items"), count("m-count"), count("z-count")]);
		const seen: string[] = [];
		let after: string | undefined;
		for (let page = 0; page < 20; page++) {
			const r = await reader.list(limit, after);
			expect(r.items.length).toBeLessThanOrEqual(limit);
			seen.push(...ids(r.items));
			if (!r.nextCursor) break;
			after = r.nextCursor;
		}
		expect(seen).toEqual(["a-count", "b-retired-items", "m-count", "z-count"]);
	});

	it("never queries a built-in id list", async () => {
		const { reader, queries } = hub([count("a-count")]);
		await reader.list(50);
		await reader.read("a-count");
		expect(queries.every((q) => !q.includes("id IN ("))).toBe(true);
	});

	it("still lists the no-inline-history rows through the registry catalog", async () => {
		const { reader } = hub(noInlineHistoryRows());
		const page = await reader.list(50);
		expect(ids(page.items).sort()).toEqual([
			"atoms-no-inline-history",
			"work-items-in-scope",
			"work-items-no-inline-history",
		]);
		expect(page.catalog.map((c) => c.id)).toContain("no-inline-history@1");
	});
});
