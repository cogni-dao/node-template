// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * no-inline-history@1: the state, scope and edits source reads with their caps and
 * failure map, the (commit, row) merge-repeat collapse, append detection, the
 * calculator in the goal-metric service, and the removal of package-served
 * definitions (definitions are hub rows only).
 */
import { describe, expect, it, vi } from "vitest";
import {
	calculatorFamily,
	createGoalMetrics,
	PACKAGE_CALCULATOR_IDS,
	RESERVED_CALCULATOR_FAMILIES,
} from "../src/knowledge.js";
import * as knowledge from "../src/knowledge.js";
import {
	readNoInlineHistoryEdits,
	readNoInlineHistoryScope,
	readNoInlineHistoryState,
	NO_INLINE_HISTORY_MAX_BYTES,
	NO_INLINE_HISTORY_MAX_EDITS,
	NO_INLINE_HISTORY_MAX_ROWS,
	noInlineHistoryEditsSql,
	noInlineHistoryWindowCommitsSql,
	noInlineHistoryStateSql,
} from "../src/sources.js";
import { fakeSql, hub, metricRow, noObservations, memoryObservations, type Row } from "./fakes.js";

const signal = new AbortController().signal;
const ASOF = "2026-11-09T12:00:00.000Z";
const START = "2026-11-02T12:00:00.000Z";
const END = "2026-11-09T12:00:00.000Z";
const window = { start: START, end: END };
const read = <T>(source: (s: AbortSignal) => Promise<T>) => source(signal);

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

/* ---------------------------------------------------------------- edits */

let seq = 0;
/** One dolt_diff row of a work item: the kept commit and its before and after text. */
const itemEdit = (id: string, at: string, over: Row = {}): Row => ({
	id,
	commit_hash: `c${String(++seq).padStart(31, "0")}`,
	at,
	diff_type: "modified",
	reason_message: null,
	from_summary: "Summary",
	to_summary: "Summary changed",
	from_outcome: "Outcome",
	to_outcome: "Outcome",
	oversize: false,
	...over,
});
const atomEdit = (id: string, at: string, over: Row = {}): Row => ({
	id,
	commit_hash: `c${String(++seq).padStart(31, "0")}`,
	at,
	diff_type: "modified",
	reason_message: null,
	from_content: "Body",
	to_content: "Body changed",
	oversize: false,
	...over,
});
const IN = "2026-11-05 10:00:00";
const totals = (rows: Row[], bytes = 1000) =>
	// The engine sends no row at all when no diff row qualifies.
	rows.length === 0
		? []
		: rows.map((r) => ({ as_of: ASOF, n: String(rows.length), bytes: String(bytes), ...r }));

/** The window statement's answer: one row per commit hash, or the totals row alone for none. */
const windowRows = (hashes: string[]): Row[] =>
	hashes.length === 0
		? [{ as_of: ASOF, n: "0", commit_hash: null }]
		: hashes.map((commit_hash) => ({ as_of: ASOF, n: String(hashes.length), commit_hash }));
const HASH_A = "a".repeat(32);
const WINDOW = (text: string) => text.startsWith("WITH w AS");
const hashesOf = (...tables: Row[][]) => [...new Set(tables.flat().map((r) => String(r.commit_hash)))];

/** A fake hub answering the window statement and the two edits statements from per-table row lists. */
function history(items: Row[], atoms: Row[]) {
	return fakeSql((text) =>
		WINDOW(text)
			? windowRows(hashesOf(items, atoms))
			: text.includes("dolt_diff_work_items")
				? totals(items)
				: totals(atoms),
	);
}
const edits = async (items: Row[], atoms: Row[], output: "share" | "count" = "share") => {
	const { sql, queries } = history(items, atoms);
	return { sample: await readNoInlineHistoryEdits(sql, output, window, read), queries };
};

describe("no-inline-history@1 edits read", () => {
	it("reads the window commits, then work items, then atoms and scores the share that did not append", async () => {
		const clean = Array.from({ length: 8 }, (_, i) => itemEdit(`task.${i}`, IN));
		const appending = [
			itemEdit("task.8", IN, { from_outcome: "Outcome", to_outcome: "Outcome\nUpdate: shipped" }),
			itemEdit("task.9", IN, { from_summary: "S", to_summary: "S\nRev 3" }),
		];
		const atoms = [atomEdit("a1", IN), atomEdit("a2", IN)];
		const { sample, queries } = await edits([...clean, ...appending], atoms);
		expect(queries).toHaveLength(3);
		expect(queries[0]).toContain("FROM dolt_log l");
		expect(queries[1]).toContain("dolt_diff_work_items");
		expect(queries[2]).toContain("dolt_diff_knowledge");
		expect(sample).toMatchObject({ unit: "%", complete: true });
		expect(sample.value).toBeCloseTo((100 * 10) / 12, 10);
		expect(sample.sourceWatermarks).toEqual([
			{ source: "node.work_items", asOf: ASOF },
			{ source: "node.knowledge", asOf: ASOF },
		]);
		expect(sample.evidenceRefs).toEqual([
			"rules:no-inline-history-rules@1",
			`window:[${START},${END})`,
			"counts:edits=12;appending=2;withReason=0",
			"counts:merge_repeats=0",
		]);
	});

	it("counts a raw edits total for the count output, with no minimum", async () => {
		const { sample } = await edits([itemEdit("task.1", IN)], [atomEdit("a1", IN)], "count");
		expect(sample).toMatchObject({ value: 2, unit: "edits", complete: true });
		const none = await edits([], [], "count");
		expect(none.sample).toMatchObject({ value: 0, unit: "edits", complete: true });
	});

	describe("merge-repeat collapse", () => {
		it("counts a branch commit and its merge commit once, at the older commit", async () => {
			const to = "X\nUpdate: shipped";
			const branch = atomEdit("a1", "2026-11-04 09:00:00", { from_content: "X", to_content: to });
			const merge = atomEdit("a1", "2026-11-06 09:00:00", { from_content: "X", to_content: to });
			const { sample } = await edits([], [branch, merge], "count");
			expect(sample.value).toBe(1);
			expect(sample.evidenceRefs).toContain("counts:edits=1;appending=1;withReason=0");
			expect(sample.evidenceRefs).toContain("counts:merge_repeats=1");
		});

		it("collapses a repeat whichever order the rows arrive", async () => {
			const branch = atomEdit("a1", "2026-11-04 09:00:00", { to_content: "Y" });
			const merge = atomEdit("a1", "2026-11-06 09:00:00", { to_content: "Y" });
			expect((await edits([], [merge, branch], "count")).sample.value).toBe(1);
		});

		it("collapses among in-window rows only: a merge whose branch commit predates the window is the edit", async () => {
			// The statement returns only rows dated inside the window, so the older
			// branch commit never arrives and its merge row stands alone.
			const merge = atomEdit("a1", "2026-11-06 09:00:00", { to_content: "Y" });
			const { sample } = await edits([], [merge], "count");
			expect(sample.value).toBe(1);
			expect(sample.evidenceRefs).toContain("counts:merge_repeats=0");
		});

		it("collapses a repeat of a work-item row the same way", async () => {
			const a = itemEdit("task.1", "2026-11-04 09:00:00", { to_summary: "New" });
			const b = itemEdit("task.1", "2026-11-04 12:00:00", { to_summary: "New" });
			const { sample } = await edits([a, b], [], "count");
			expect(sample.value).toBe(1);
		});

		it("never collapses rows whose values differ, or rows of different ids", async () => {
			const rows = [
				atomEdit("a1", "2026-11-04 09:00:00", { to_content: "Y" }),
				atomEdit("a1", "2026-11-05 09:00:00", { from_content: "Y", to_content: "Z" }),
				atomEdit("a2", "2026-11-05 09:30:00", { to_content: "Y" }),
			];
			expect((await edits([], rows, "count")).sample.value).toBe(3);
		});

		it("only collapses adjacent rows: a changed value between two equal ones keeps both", async () => {
			const rows = [
				atomEdit("a1", "2026-11-03 09:00:00", { to_content: "Y" }),
				atomEdit("a1", "2026-11-04 09:00:00", { from_content: "Y", to_content: "Z" }),
				atomEdit("a1", "2026-11-05 09:00:00", { from_content: "Z", to_content: "Y" }),
			];
			expect((await edits([], rows, "count")).sample.value).toBe(3);
		});

		it("collapses a chain of identical repeats into the oldest", async () => {
			const rows = ["2026-11-03", "2026-11-04", "2026-11-05"].map((d) =>
				atomEdit("a1", `${d} 09:00:00`, { to_content: "Y" }),
			);
			expect((await edits([], rows, "count")).sample.value).toBe(1);
		});
	});

	describe("what is an edit", () => {
		it("excludes creation, deletion-shaped rows and changes to other columns", async () => {
			const rows = [
				itemEdit("task.1", IN, { diff_type: "added", from_summary: null, to_summary: "New", from_outcome: null }),
				// Status or label change only: both edit columns equal.
				itemEdit("task.2", IN, { from_summary: "Same", to_summary: "Same" }),
				itemEdit("task.3", IN),
			];
			const { sample } = await edits(rows, [], "count");
			expect(sample.value).toBe(1);
		});

		it("includes the start of the window and excludes its end", async () => {
			const rows = [
				itemEdit("task.1", "2026-11-02 11:59:59.999"),
				itemEdit("task.2", "2026-11-02 12:00:00"),
				itemEdit("task.3", "2026-11-09 11:59:59.999"),
				itemEdit("task.4", "2026-11-09 12:00:00"),
			];
			expect((await edits(rows, [], "count")).sample.value).toBe(2);
		});

		it("reads commit dates in every UTC text form", async () => {
			const rows = [
				itemEdit("task.1", "2026-11-05 10:00:00+00"),
				itemEdit("task.2", "2026-11-05 10:00:00 UTC"),
				itemEdit("task.3", "2026-11-05T10:00:00.000Z"),
			];
			expect((await edits(rows, [], "count")).sample.value).toBe(3);
		});
	});

	describe("append detection", () => {
		it("is an append when the marker-line count of the changed columns grows", async () => {
			const rows = [
				atomEdit("a1", IN, { from_content: "State", to_content: "State\nUpdate: shipped" }),
				atomEdit("a2", IN, { from_content: "a", to_content: "a\n2026-11-01 x\n2026-11-02 y" }),
			];
			const { sample } = await edits([], rows, "count");
			expect(sample.evidenceRefs).toContain("counts:edits=2;appending=2;withReason=0");
		});

		it("is not an append when a marker line is reworded or others are removed", async () => {
			const rows = [
				atomEdit("a1", IN, { from_content: "Update: one", to_content: "Update: two" }),
				atomEdit("a2", IN, { from_content: "Update: one\nRev 3", to_content: "Rev 3" }),
				atomEdit("a3", IN, { from_content: "x", to_content: "y" }),
			];
			const { sample } = await edits([], rows, "count");
			expect(sample.evidenceRefs).toContain("counts:edits=3;appending=0;withReason=0");
		});

		it("reads both changed work-item columns together", async () => {
			const row = itemEdit("task.1", IN, {
				from_summary: "Update: one",
				to_summary: "clean",
				from_outcome: "O",
				to_outcome: "O\nUpdate: two",
			});
			const { sample } = await edits([row], [], "count");
			// One marker line removed, one added: the count did not grow.
			expect(sample.evidenceRefs).toContain("counts:edits=1;appending=0;withReason=0");
		});
	});

	describe("reasons", () => {
		it("counts a work-item commit that carries a Reason line and an atom commit that has a message", async () => {
			const items = [
				itemEdit("task.1", IN, { reason_message: "work-items: patch by actor:abc\nReason: tidy the summary" }),
				itemEdit("task.2", IN, { reason_message: "work-items: patch by actor:abc" }),
				itemEdit("task.3", IN, { reason_message: "Reason: first line is not a reason line" }),
				itemEdit("task.4", IN, { reason_message: "work-items: patch by actor:abc\nReason: " }),
			];
			const atoms = [
				atomEdit("a1", IN, { reason_message: "refine in place" }),
				atomEdit("a2", IN, { reason_message: "  " }),
				atomEdit("a3", IN),
			];
			const { sample } = await edits(items, atoms, "count");
			expect(sample.evidenceRefs).toContain("counts:edits=7;appending=0;withReason=2");
		});
	});

	describe("unknown, never zero", () => {
		it("is insufficient_history under 10 edits for a share", async () => {
			const rows = Array.from({ length: 9 }, (_, i) => itemEdit(`task.${i}`, IN));
			expect((await edits(rows, [])).sample).toMatchObject({ complete: false, reason: "insufficient_history" });
			const ten = Array.from({ length: 10 }, (_, i) => itemEdit(`task.${i}`, IN));
			expect((await edits(ten, [])).sample).toMatchObject({ complete: true, value: 100 });
		});

		it("is zero_denominator with no edits for a share", async () => {
			expect((await edits([], [])).sample).toMatchObject({ complete: false, reason: "zero_denominator" });
		});

		it("reads a statement that sends no row as no edit, with the window read's as_of", async () => {
			const { sql, queries } = fakeSql((text) => (WINDOW(text) ? windowRows([HASH_A]) : []));
			const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: true, value: 0, unit: "edits" });
			expect(queries).toHaveLength(3);
			expect(sample.sourceWatermarks).toEqual([
				{ source: "node.work_items", asOf: new Date(ASOF).toISOString() },
				{ source: "node.knowledge", asOf: new Date(ASOF).toISOString() },
			]);
		});

		it("fails closed on the first row alone that an over-cap statement sends", async () => {
			const { sql } = fakeSql((text) =>
				WINDOW(text)
					? windowRows([HASH_A])
					: [{ as_of: ASOF, n: String(NO_INLINE_HISTORY_MAX_ROWS + 1), bytes: "10", ...itemEdit("task.1", IN) }],
			);
			const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
			expect(sample.evidenceRefs.join()).toContain("cap_hit");
		});

		it("fails closed above the edit cap for either output", async () => {
			const rows = Array.from({ length: NO_INLINE_HISTORY_MAX_EDITS + 1 }, (_, i) => itemEdit(`task.${i}`, IN));
			for (const output of ["share", "count"] as const) {
				const { sample } = await edits(rows, [], output);
				expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
				expect(sample.evidenceRefs).toContain("cap_hit");
			}
			const exact = Array.from({ length: NO_INLINE_HISTORY_MAX_EDITS }, (_, i) => itemEdit(`task.${i}`, IN));
			expect((await edits(exact, [], "count")).sample).toMatchObject({ complete: true, value: NO_INLINE_HISTORY_MAX_EDITS });
		});

		it.each([
			["rows", { n: String(NO_INLINE_HISTORY_MAX_ROWS + 1), bytes: "10" }],
			["bytes", { n: "10", bytes: String(NO_INLINE_HISTORY_MAX_BYTES + 1) }],
		])("fails closed on a statement cap hit on %s and stops at the failing table", async (_cap, capped) => {
			const { sql, queries } = fakeSql((text) =>
				WINDOW(text) ? windowRows([HASH_A]) : [{ as_of: ASOF, id: null, ...capped }],
			);
			const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
			expect(sample.evidenceRefs.join()).toContain("cap_hit");
			expect(queries).toHaveLength(2);
		});

		it.each([
			["rows over the cap", [{ as_of: ASOF, n: String(NO_INLINE_HISTORY_MAX_ROWS + 1), commit_hash: null }]],
			["a row count mismatch", [{ as_of: ASOF, n: "2", commit_hash: HASH_A }]],
			["a malformed hash", [{ as_of: ASOF, n: "1", commit_hash: "x'; DROP TABLE t; --" }]],
			["no result", []],
		])("fails closed when the window commits come back with %s, before any diff is read", async (_why, rows) => {
			const { sql, queries } = fakeSql(() => rows);
			const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
			expect(queries).toHaveLength(1);
		});

		it("reads no diff for a window with no commit and counts no edit", async () => {
			const { sql, queries } = fakeSql((text) => (WINDOW(text) ? windowRows([]) : []));
			const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: true, value: 0 });
			expect(sample.sourceWatermarks).toEqual([
				{ source: "node.work_items", asOf: ASOF },
				{ source: "node.knowledge", asOf: ASOF },
			]);
			expect(queries).toHaveLength(1);
		});

		it("fails closed on an oversize field, a row-count mismatch, a bad date or no result", async () => {
			const good = itemEdit("task.1", IN);
			for (const rows of [
				[{ ...good, oversize: true }],
				[{ ...good }, { ...good, id: "task.2" }].map((r) => ({ ...r, n: "3" })),
				[{ ...good, at: "not a date" }],
			]) {
				const { sample } = await edits(rows, [], "count");
				expect(sample, JSON.stringify(rows)).toMatchObject({
					complete: false,
					reason: "incomplete_or_invalid_source",
				});
			}
			const empty = fakeSql(() => []);
			expect(await readNoInlineHistoryEdits(empty.sql, "count", window, read)).toMatchObject({
				complete: false,
				reason: "incomplete_or_invalid_source",
			});
		});

		it("maps a read error to source_failed and keeps a timeout its own failure", async () => {
			const failing = fakeSql(() => {
				throw new TypeError("table not found: dolt_diff_work_items SECRET-BODY-TEXT");
			});
			const sample = await readNoInlineHistoryEdits(failing.sql, "share", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
			// The error class is observable; its message never is.
			expect(sample.evidenceRefs).toContain("error:TypeError");
			expect(sample.evidenceRefs.join("\n")).not.toContain("SECRET");
			expect(failing.queries).toHaveLength(1);
			// The same map holds when the diff statement, not the window read, fails.
			const diffFails = fakeSql((text) => {
				if (WINDOW(text)) return windowRows([HASH_A]);
				throw new TypeError("table not found: dolt_diff_work_items SECRET-BODY-TEXT");
			});
			const second = await readNoInlineHistoryEdits(diffFails.sql, "share", window, read);
			expect(second).toMatchObject({ complete: false, reason: "source_failed" });
			expect(second.evidenceRefs).toContain("error:TypeError");
			expect(diffFails.queries).toHaveLength(2);
			const controller = new AbortController();
			const slow = fakeSql(async () => {
				controller.abort();
				throw new Error("canceled");
			});
			await expect(
				readNoInlineHistoryEdits(slow.sql, "share", window, (source) => source(controller.signal)),
			).rejects.toThrow();
		});
	});

	it("never puts row text or a commit message in evidence", async () => {
		const secret = "SECRET-BODY-TEXT";
		const { sample } = await edits(
			[],
			[atomEdit("a1", IN, { to_content: `Update: ${secret}`, reason_message: `reason ${secret}` })],
			"count",
		);
		expect(sample.evidenceRefs.join("\n")).not.toContain(secret);
	});

	it("reads the same frozen history as equal", async () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			itemEdit(`task.${i}`, IN, i < 3 ? { to_outcome: "Outcome\nUpdate: x" } : {}),
		);
		const a = (await edits(rows, [atomEdit("a1", IN)])).sample;
		const b = (await edits(rows, [atomEdit("a1", IN)])).sample;
		expect(b).toEqual(a);
	});

	describe("statement", () => {
		const hashes = ["a".repeat(32), "b".repeat(32)];
		it.each(["work-items", "atoms"] as const)("is one read-only %s statement that looks the window's commits up by to_commit, with the caps pushed down", (table) => {
			const text = noInlineHistoryEditsSql(table, hashes);
			expect(text.startsWith("WITH diffs AS")).toBe(true);
			expect(text).toContain(table === "work-items" ? "FROM dolt_diff_work_items d" : "FROM dolt_diff_knowledge d");
			expect(text).toContain("d.to_commit <> 'WORKING'");
			// Dolt pushes a to_commit filter down to an index lookup and never a date filter.
			expect(text).toContain(`(d.to_commit = '${hashes[0]}' OR d.to_commit = '${hashes[1]}')`);
			// Doltgres 0.57.3 cannot plan an IN list on to_commit, and a to_id IS NOT NULL test
			// makes it scan the to_id index instead of looking the commits up (both seen on the real engine).
			expect(text).not.toMatch(/to_commit IN/);
			expect(text).not.toContain("to_id IS NOT NULL");
			expect(text).not.toContain("to_commit_date >=");
			expect(text).not.toContain("to_commit_date <");
			expect(text).toContain("d.diff_type = 'modified'");
			// Doltgres 0.57.3 panics on a bare from_/to_ text comparison inside the CTE.
			expect(text).not.toContain("IS DISTINCT FROM");
			expect(text).toContain(table === "work-items" ? "COALESCE(substr(d.from_outcome, 1, 100000), '') <> COALESCE(substr(d.to_outcome, 1, 100000), '')" : "COALESCE(substr(d.from_content, 1, 100000), '') <> COALESCE(substr(d.to_content, 1, 100000), '')");
			// No wider history: a literal list, no subquery, ordered by id then date, one row past the cap.
			expect(text).not.toMatch(/\bIN \(\s*SELECT/i);
			expect(text.match(/FROM dolt_diff_/g)).toHaveLength(1);
			expect(text).toContain(`ORDER BY d.to_id, d.to_commit_date LIMIT ${NO_INLINE_HISTORY_MAX_ROWS + 1}`);
			// A missing commit row never drops a diff row.
			expect(text).toContain("LEFT JOIN dolt_log l ON l.commit_hash = d.to_commit");
			expect(text).not.toMatch(/(?<!LEFT )JOIN /);
			expect(text).toContain(`t.n <= ${NO_INLINE_HISTORY_MAX_ROWS}`);
			expect(text).toContain(`t.bytes <= ${NO_INLINE_HISTORY_MAX_BYTES}`);
			expect(text).toContain("> 100000 THEN NULL");
			expect(text).toContain("CAST(COALESCE(SUM(");
			// One pass: the totals are window functions over the one reference to the CTE, never a second scan of the diff.
			expect(text.match(/FROM diffs/g)).toHaveLength(1);
			expect(text).toContain("COUNT(*) OVER () AS n");
			expect(text).toContain(") OVER (), 0) AS BIGINT) AS bytes");
			// Over a cap the first row alone carries the totals.
			expect(text).toContain("OR t.rn = 1 ORDER BY t.id, t.at, t.commit_hash");
			expect(text).not.toContain("LEFT JOIN diffs");
			expect(text).not.toContain(";");
			expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
		});

		it("reads only the changed text columns and the fixture scope as of the commit", () => {
			const items = noInlineHistoryEditsSql("work-items", hashes);
			expect(items).toContain("from_summary");
			expect(items).toContain("to_outcome");
			expect(items).not.toContain("d.to_title");
			expect(items).toContain('"test-fixture"');
			expect(items).toContain('"synthetic-fixture"');
			const atoms = noInlineHistoryEditsSql("atoms", hashes);
			expect(atoms).toContain("from_content");
			expect(atoms).not.toContain("d.to_summary");
			expect(atoms).toContain("to_entry_type <> 'html'");
			expect(atoms).toContain("[TEST]");
			expect(atoms).toContain("LEFT JOIN knowledge_contribution_commits c ON c.commit_hash = d.to_commit");
		});

		it("takes only well-formed commit hashes, so a literal list cannot carry SQL", () => {
			expect(() => noInlineHistoryEditsSql("atoms", [])).toThrow(TypeError);
			expect(() => noInlineHistoryEditsSql("atoms", ["x'); DROP TABLE t; --"])).toThrow(TypeError);
		});

		it("selects the window's commits from main's log by UTC commit date, one row past the cap", () => {
			const text = noInlineHistoryWindowCommitsSql(window);
			expect(text.startsWith("WITH w AS")).toBe(true);
			expect(text).toContain("FROM dolt_log l WHERE l.date >= '2026-11-02 12:00:00.000' AND l.date < '2026-11-09 12:00:00.000'");
			// Merge commits stay in the list: a contribution's edit can have its diff row at the merge commit only.
			expect(text).not.toContain("dolt_commit_ancestors");
			expect(text).toContain(`LIMIT ${NO_INLINE_HISTORY_MAX_ROWS + 1}`);
			expect(text).toContain(`t.n <= ${NO_INLINE_HISTORY_MAX_ROWS}`);
			expect(text).not.toContain("dolt_diff");
			expect(text).not.toContain(";");
		});
	});

	describe("the diff read follows the window, not the history", () => {
		// A history of 300 old commits, each with an edit, around 14 commits in the window.
		const day = (n: number) => `2026-10-${String(1 + (n % 28)).padStart(2, "0")} 08:00:00`;
		const hash = (i: number) => `d${String(i).padStart(31, "0")}`;
		const old = Array.from({ length: 300 }, (_, i) => ({
			...itemEdit(`task.${i % 9}`, day(i), { to_summary: `Old ${i}` }),
			commit_hash: hash(i),
		}));
		const inside: Row[] = [
			// Exactly the start is inside; exactly the end is outside.
			{ ...itemEdit("task.1", "2026-11-02 12:00:00", { to_summary: "Edge start" }), commit_hash: hash(1001) },
			{ ...itemEdit("task.1", "2026-11-09 12:00:00", { to_summary: "Edge end" }), commit_hash: hash(1002) },
			// A branch commit and its merge commit repeat one edit; the older is kept.
			{ ...itemEdit("task.2", "2026-11-04 09:00:00", { to_summary: "Appended\nUpdate: x" }), commit_hash: hash(1003) },
			{ ...itemEdit("task.2", "2026-11-06 09:00:00", { to_summary: "Appended\nUpdate: x" }), commit_hash: hash(1004) },
			...Array.from({ length: 10 }, (_, i) => ({
				...itemEdit(`task.${10 + i}`, "2026-11-05 10:00:00"),
				commit_hash: hash(2000 + i),
			})),
		];
		const all = [...old, ...inside];
		const ms = (at: unknown) => Date.parse(`${String(at).replace(" ", "T")}Z`);
		// The rule the date-filtered statement applied: a diff row counts when its own commit date is in [start, end).
		const dated = all.filter((r) => ms(r.at) >= Date.parse(START) && ms(r.at) < Date.parse(END));

		// A history that answers like the engine: the window statement from its commit dates, the diff statement from its to_commit list.
		const engine = () =>
			fakeSql((text) => {
				if (WINDOW(text)) {
					const [, lo, hi] = /l\.date >= '(.*?)' AND l\.date < '(.*?)'/.exec(text) ?? [];
					return windowRows(all.filter((r) => ms(r.at) >= ms(lo) && ms(r.at) < ms(hi)).map((r) => String(r.commit_hash)));
				}
				const listed = new Set([...text.matchAll(/'([a-z0-9]{32})'/g)].map((m) => m[1]));
				return text.includes("dolt_diff_work_items")
					? totals(all.filter((r) => listed.has(String(r.commit_hash))))
					: totals([]);
			});

		it("puts only the window's commits in the diff statement", async () => {
			const { sql, queries } = engine();
			await readNoInlineHistoryEdits(sql, "count", window, read);
			const list = [...queries[1]!.matchAll(/'([a-z0-9]{32})'/g)].map((m) => m[1]);
			expect(list.sort()).toEqual(dated.map((r) => r.commit_hash as string).sort());
			expect(list).toHaveLength(13);
			expect(queries[1]).not.toContain(hash(0));
		});

		it("reads exactly the edits the date-filtered statement read", async () => {
			const { sql } = engine();
			const sample = await readNoInlineHistoryEdits(sql, "share", window, read);
			// 13 in-window diff rows: the merge repeat collapses, leaving 12 edits, 1 appending.
			expect(sample.evidenceRefs).toContain("counts:edits=12;appending=1;withReason=0");
			expect(sample.evidenceRefs).toContain("counts:merge_repeats=1");
			const { sql: reference } = history(dated, []);
			const expected = await readNoInlineHistoryEdits(reference, "share", window, read);
			expect(sample).toEqual(expected);
		});
	});
});

/* ------------------------------------------------------------- service */

const spec = {
	state: { measure: "state", subject: "work-items" },
	atoms: { measure: "state", subject: "atoms" },
	scope: { measure: "scope", subject: "work-items" },
	share: { measure: "edits", output: "share", days: 7 },
	count: { measure: "edits", output: "count", days: 7 },
} as const;
// The service reads the real clock: source times stay a minute behind it and edits a day.
const recent = () => new Date(Date.now() - 86_400_000).toISOString();
const live = (rows: Row[]): Row[] => {
	const asOf = new Date(Date.now() - 60_000).toISOString();
	return rows.map((r) => ("as_of" in r ? { ...r, as_of: asOf } : r));
};
const rowsFor = (text: string): Row[] => {
	if (text.startsWith("WITH scope AS") && text.includes("FROM work_items"))
		return live(joined([itemRow("task.1", `${GOAL}\n${DONE}`), itemRow("task.2", `${GOAL}\n${DONE}\nUpdate: x`)]));
	if (text.startsWith("WITH scope AS")) return live(joined([atomRow("e1")]));
	if (text.includes("COUNT(*) FROM work_items")) return live([{ as_of: ASOF, value: "73" }]);
	if (WINDOW(text)) return live(windowRows([HASH_A]));
	if (text.includes("dolt_diff_work_items"))
		return live(totals(Array.from({ length: 10 }, (_, i) => itemEdit(`task.${i}`, recent()))));
	if (text.includes("dolt_diff_knowledge"))
		return live(totals([atomEdit("a1", recent(), { to_content: "Body\nUpdate: s" })]));
	return [];
};
const noInlineHistoryRows = () => [
	metricRow("work-items-no-inline-history", "no-inline-history@1", spec.state),
	metricRow("atoms-no-inline-history", "no-inline-history@1", spec.atoms),
	metricRow("work-items-in-scope", "no-inline-history@1", spec.scope),
	metricRow("edits-kept-current-7d", "no-inline-history@1", spec.share),
	metricRow("edits-7d", "no-inline-history@1", spec.count),
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

	it("registers after brief.conformance@1 with the designed budget", () => {
		const { reader } = hub([]);
		expect(reader.registry.describe().map((c) => c.id)).toEqual([
			"work.count@1",
			"work.convergence@1",
			"github.stars@1",
			"brief.conformance@1",
			"no-inline-history@1",
		]);
		const calc = reader.registry.get("no-inline-history@1");
		expect(calc.budget).toEqual({
			timeoutMs: 15000,
			maxSourceCalls: 3,
			maxRows: 5000,
			maxResponseBytes: 16_777_216,
		});
		// Readings are of main now; only the edits interval has a width.
		expect(calc.historicalWindows).toBeUndefined();
		const width = (params: unknown) => calc.windowSeconds?.(params);
		expect(width(spec.state)).toBe(0);
		expect(width(spec.scope)).toBe(0);
		expect(width(spec.share)).toBe(7 * 86400);
		const unit = (params: unknown) => calc.unitFor?.(params);
		expect([spec.state, spec.atoms, spec.scope, spec.share, spec.count].map(unit)).toEqual([
			"%",
			"%",
			"items",
			"%",
			"edits",
		]);
		const display = (params: unknown) => calc.displayFor?.(params);
		expect([spec.state, spec.scope, spec.share, spec.count].map(display)).toEqual([
			"progress",
			"volume",
			"progress",
			"volume",
		]);
	});

	it("takes the three designed param shapes and nothing else", () => {
		const schema = hub([]).reader.registry.get("no-inline-history@1").paramsSchema;
		for (const ok of Object.values(spec)) expect(schema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
		for (const bad of [
			{ measure: "state" },
			{ measure: "state", subject: "goals" },
			{ measure: "state", subject: "atoms", extra: 1 },
			{ measure: "scope", subject: "atoms" },
			{ measure: "edits", output: "ratio", days: 7 },
			{ measure: "edits", output: "share", days: 0 },
			{ measure: "edits", output: "share", days: 29 },
			{ measure: "edits", output: "share", days: 7.5 },
			{ measure: "edits", output: "share" },
			{ measure: "other", subject: "atoms" },
			{},
		])
			expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
	});

	it.each([
		["work-items-no-inline-history", 50, "%", "counts:evaluated=2;passing=1", 1],
		["atoms-no-inline-history", 100, "%", "counts:evaluated=1;passing=1", 1],
		["work-items-in-scope", 73, "items", "counts:evaluated=73", 1],
		["edits-kept-current-7d", (100 * 10) / 11, "%", "counts:edits=11;appending=1;withReason=0", 3],
		["edits-7d", 11, "edits", "counts:edits=11;appending=1;withReason=0", 3],
	])("computes %s end to end with one terminal log event and the designed source calls", async (id, value, unit, evidence, calls) => {
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

	it.each([
		["success", "knowledgeDiff", ["ok", 100, "ok", 200, "ok", 300, 1, 10, 1000, 1, 1000]],
		["error", "windowCommits", ["error", 100, "not_started", null, "not_started", null, null, null, null, null, null]],
		["error", "workDiff", ["ok", 100, "error", 200, "not_started", null, 1, null, null, null, null]],
		["error", "knowledgeDiff", ["ok", 100, "ok", 200, "error", 300, 1, 10, 1000, null, null]],
		["timeout", "windowCommits", ["running", 15000, "not_started", null, "not_started", null, null, null, null, null, null]],
		["timeout", "workDiff", ["ok", 100, "running", 14900, "not_started", null, 1, null, null, null, null]],
		["timeout", "knowledgeDiff", ["ok", 100, "ok", 200, "running", 14700, 1, 10, 1000, null, null]],
		["malformed", "windowCommits", ["ok", 100, "not_started", null, "not_started", null, null, null, null, null, null]],
		["malformed", "workDiff", ["ok", 100, "ok", 200, "not_started", null, 1, null, null, null, null]],
		["malformed", "knowledgeDiff", ["ok", 100, "ok", 200, "ok", 300, 1, 10, 1000, null, null]],
	] as const)("records exact %s timing and totals at %s", async (mode, target, expected) => {
		vi.useFakeTimers();
		const epoch = Date.now();
		const monotonic = vi.spyOn(performance, "now").mockImplementation(() => Date.now() - epoch);
		try {
			const definitions = noInlineHistoryRows();
			const delays = { windowCommits: 100, workDiff: 200, knowledgeDiff: 300 };
			const sql = fakeSql((text) => {
				if (text.startsWith("SELECT id,title,metric_spec")) return definitions.filter((row) => text.includes(`id='${row.id}'`));
				const stage = WINDOW(text) ? "windowCommits" : text.includes("dolt_diff_work_items") ? "workDiff" : "knowledgeDiff";
				return new Promise<Row[]>((resolve, reject) => {
					if (stage === target && mode === "timeout") return;
					setTimeout(() => {
						if (stage === target && mode === "error") { reject(new Error("PRIVATE-TEXT")); return; }
						const rows = rowsFor(text);
						resolve(stage === target && mode === "malformed" ? rows.map((row) => ({ ...row, n: "invalid" })) : rows);
					}, delays[stage]);
				});
			}).sql;
			const events: object[] = [];
			const service = createGoalMetrics({ knowledgeSql: sql, observationsSql: memoryObservations(), node: "n", environment: "test", log: (event) => events.push(event) });
			const computation = service.compute("edits-7d", { requestKey: `${mode}-${target}` });
			await vi.advanceTimersByTimeAsync(mode === "timeout" ? 15001 : 1000);
			const result = await computation;
			expect(result.status).toBe(mode === "success" ? "ok" : mode === "timeout" ? "error" : "unavailable");
			if (mode === "success") expect(result.value).toBe(11);
			const terminal = events.filter((event) => (event as { event: string }).event === "metric.compute.completed");
			expect(terminal).toHaveLength(1);
			expect((terminal[0] as { sourceTiming: unknown }).sourceTiming).toEqual({
				windowCommits: { state: expected[0], durationMs: expected[1] },
				workDiff: { state: expected[2], durationMs: expected[3] },
				knowledgeDiff: { state: expected[4], durationMs: expected[5] },
				windowCommitCount: expected[6], workRows: expected[7], workBytes: expected[8], knowledgeRows: expected[9], knowledgeBytes: expected[10],
			});
			expect(JSON.stringify(terminal)).not.toContain("PRIVATE-TEXT");
		} finally { monotonic.mockRestore(); vi.useRealTimers(); }
	});

	it.each([
		["windowCommits", "n", { windowCommits: "ok", workDiff: "not_started", knowledgeDiff: "not_started", counts: [null, null, null, null, null] }],
		["workDiff", "n", { windowCommits: "ok", workDiff: "ok", knowledgeDiff: "ok", counts: [1, null, null, 1, 1000] }],
		["workDiff", "bytes", { windowCommits: "ok", workDiff: "ok", knowledgeDiff: "ok", counts: [1, null, null, 1, 1000] }],
		["knowledgeDiff", "n", { windowCommits: "ok", workDiff: "ok", knowledgeDiff: "ok", counts: [1, 10, 1000, null, null] }],
		["knowledgeDiff", "bytes", { windowCommits: "ok", workDiff: "ok", knowledgeDiff: "ok", counts: [1, 10, 1000, null, null] }],
	] as const)("leaves null %s %s aggregate unknown", async (target, field, expected) => {
		const clock = vi.spyOn(performance, "now").mockReturnValue(7);
		try {
			const { service, events } = hub(noInlineHistoryRows(), (text) => {
				const stage = WINDOW(text) ? "windowCommits" : text.includes("dolt_diff_work_items") ? "workDiff" : "knowledgeDiff";
				const rows = rowsFor(text);
				return stage === target ? rows.map((row) => ({ ...row, [field]: null })) : rows;
			});
			await service.compute("edits-7d", { requestKey: `null-${target}-${field}` });
			const terminal = events.filter((event) => (event as { event: string }).event === "metric.compute.completed");
			expect(terminal).toHaveLength(1);
			expect((terminal[0] as { sourceTiming: unknown }).sourceTiming).toEqual({
				windowCommits: { state: expected.windowCommits, durationMs: 0 },
				workDiff: { state: expected.workDiff, durationMs: expected.workDiff === "not_started" ? null : 0 },
				knowledgeDiff: { state: expected.knowledgeDiff, durationMs: expected.knowledgeDiff === "not_started" ? null : 0 },
				windowCommitCount: expected.counts[0], workRows: expected.counts[1], workBytes: expected.counts[2], knowledgeRows: expected.counts[3], knowledgeBytes: expected.counts[4],
			});
		} finally { clock.mockRestore(); }
	});

	it("reports bounded stage timing on the existing terminal event", async () => {
		const { service, events } = hub(noInlineHistoryRows(), rowsFor);
		await service.compute("edits-7d", { requestKey: "timing" });
		const terminal = events.filter(
			(e) => (e as { event: string }).event === "metric.compute.completed",
		);
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			sourceTiming: {
				windowCommits: { state: "ok", durationMs: expect.any(Number) },
				workDiff: { state: "ok", durationMs: expect.any(Number) },
				knowledgeDiff: { state: "ok", durationMs: expect.any(Number) },
				windowCommitCount: expect.any(Number),
				workRows: expect.any(Number),
				knowledgeRows: expect.any(Number),
			},
		});
	});

	it.each(["windowCommits", "workDiff", "knowledgeDiff"] as const)(
		"reports %s errors without leaking messages",
		async (stage) => {
			const target = {
				windowCommits: "dolt_log l WHERE",
				workDiff: "dolt_diff_work_items",
				knowledgeDiff: "dolt_diff_knowledge",
			}[stage];
			const { service, events } = hub(noInlineHistoryRows(), (text) => {
				if (text.includes(target)) throw new Error("SECRET-ROW-TEXT");
				return rowsFor(text);
			});
			await service.compute("edits-7d", { requestKey: `error-${stage}` });
			const event = events.find(
				(e) => (e as { event: string }).event === "metric.compute.completed",
			);
			expect(event).toMatchObject({
				sourceTiming: { [stage]: { state: "error" } },
			});
			expect(JSON.stringify(event)).not.toContain("SECRET-ROW-TEXT");
		},
	);

	it.each(["windowCommits", "workDiff", "knowledgeDiff"] as const)(
		"freezes %s as running before abort and ignores late settlement",
		async (stage) => {
			vi.useFakeTimers();
			try {
				let resolve!: (rows: Row[]) => void;
				const delayed = new Promise<Row[]>((r) => {
					resolve = r;
				});
				const needles = {
					windowCommits: "dolt_log l WHERE",
					workDiff: "dolt_diff_work_items",
					knowledgeDiff: "dolt_diff_knowledge",
				};
				const rows = noInlineHistoryRows();
				const sql = fakeSql((text) => {
					if (text.startsWith("SELECT id,title,metric_spec"))
						return rows.filter((r) => text.includes(`id='${r.id}'`));
					return text.includes(needles[stage]) ? delayed : rowsFor(text);
				}).sql;
				const events: object[] = [];
				const service = createGoalMetrics({
					knowledgeSql: sql,
					observationsSql: memoryObservations(),
					node: "n",
					environment: "test",
					log: (e) => events.push(e),
				});
				const compute = service.compute("edits-7d", {
					requestKey: `timeout-${stage}`,
				});
				await vi.advanceTimersByTimeAsync(15001);
				const result = await compute;
				expect(result.reason).toBe("source_timeout");
				const event = events.find(
					(e) => (e as { event: string }).event === "metric.compute.completed",
				);
				expect(event).toMatchObject({
					sourceTiming: { [stage]: { state: "running" } },
				});
				const snapshot = JSON.stringify(event);
				resolve(rowsFor(needles[stage]));
				await vi.advanceTimersByTimeAsync(10);
				expect(JSON.stringify(event)).toBe(snapshot);
				expect(
					events.filter(
						(e) =>
							(e as { event: string }).event === "metric.compute.completed",
					),
				).toHaveLength(1);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("freezes the snapshot before abort and late rejection while persistence waits", async () => {
		vi.useFakeTimers();
		try {
			let rejectQuery!: (error: Error) => void;
			const pending = new Promise<Row[]>((_resolve, reject) => { rejectQuery = reject; });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const base = memoryObservations();
			const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) => {
				if (strings.join("?").startsWith("UPDATE metric_observations SET observation="))
					return gate.then(() => base(strings, ...values));
				return base(strings, ...values);
			}) as typeof base;
			Object.assign(wrapped, { begin: (fn: (tx: typeof wrapped) => Promise<unknown>) => fn(wrapped) });
			const rows = noInlineHistoryRows();
			const sql = fakeSql((text) => text.startsWith("SELECT id,title,metric_spec")
				? rows.filter((row) => text.includes(`id='${row.id}'`))
				: text.includes("dolt_diff_work_items") ? pending : rowsFor(text)).sql;
			const events: object[] = [];
			const service = createGoalMetrics({ knowledgeSql: sql, observationsSql: wrapped, node: "n", environment: "test", log: (event) => events.push(event) });
			const result = service.compute("edits-7d", { requestKey: "late-rejection" });
			await vi.advanceTimersByTimeAsync(15001);
			rejectQuery(new Error("SECRET-LATE-ERROR"));
			await vi.advanceTimersByTimeAsync(1);
			release();
			await vi.advanceTimersByTimeAsync(1);
			expect((await result).reason).toBe("source_timeout");
			const terminal = events.filter((e) => (e as { event: string }).event === "metric.compute.completed");
			expect(terminal).toHaveLength(1);
			expect(terminal[0]).toMatchObject({ sourceTiming: { workDiff: { state: "running" }, knowledgeDiff: { state: "not_started" } } });
			expect(JSON.stringify(terminal)).not.toContain("SECRET-LATE-ERROR");
		} finally { vi.useRealTimers(); }
	});

	it("ignores throwing timing callbacks and clocks", async () => {
		const { sql } = fakeSql(rowsFor);
		const sample = await readNoInlineHistoryEdits(
			sql,
			"count",
			window,
			read,
			() => {
				throw new Error("diagnostic");
			},
		);
		expect(sample.complete).toBe(true);
		const clock = vi.spyOn(performance, "now").mockImplementation(() => {
			throw new Error("clock");
		});
		try {
			const { service, events } = hub(noInlineHistoryRows(), rowsFor);
			const saved = await service.compute("edits-7d", {
				requestKey: "bad-clock",
			});
			expect(saved.status).toBe("ok");
			expect(
				events.find(
					(e) => (e as { event: string }).event === "metric.compute.completed",
				),
			).toMatchObject({
				sourceTiming: { windowCommits: { state: "ok", durationMs: null } },
			});
		} finally {
			clock.mockRestore();
		}
	});

	it("measures the edits window as seven UTC days ending at the reading", async () => {
		const { service } = hub(noInlineHistoryRows(), rowsFor);
		const saved = await service.compute("edits-7d", { requestKey: "k-window" });
		const span = Date.parse(saved.window.end) - Date.parse(saved.window.start);
		expect(span).toBe(7 * 86400 * 1000);
		expect(saved.evidenceRefs).toContain(`window:[${saved.window.start},${saved.window.end})`);
	});

	it("refuses a historical evaluation time, since state is read from main now", async () => {
		const { service } = hub(noInlineHistoryRows(), rowsFor);
		await expect(
			service.compute("work-items-no-inline-history", { requestKey: "k-hist", evaluationAt: "2026-11-01T00:00:00.000Z" }),
		).rejects.toMatchObject({ code: "historical_window_not_supported", status: 422 });
	});

	it("records an unknown reading with its reason on the one terminal event", async () => {
		const sparse = (text: string) =>
			text.includes("dolt_diff_work_items")
				? live(totals([itemEdit("task.1", recent())]))
				: text.includes("dolt_diff_knowledge")
					? live(totals([]))
					: rowsFor(text);
		const { service, events } = hub(noInlineHistoryRows(), sparse);
		const saved = await service.compute("edits-kept-current-7d", { requestKey: "k-unknown" });
		expect(saved).toMatchObject({ status: "unavailable", value: null, reason: "insufficient_history" });
		expect(events.filter((e) => (e as { event: string }).event === "metric.compute.completed")).toEqual([
			expect.objectContaining({ status: "unavailable", reason: "insufficient_history" }),
		]);
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
		for (const id of ["brief-conformance-items", "brief-conformance-entries"])
			await expect(reader.read(id)).rejects.toMatchObject({ code: "metric_not_found", status: 404 });
	});

	it("lists nothing when the hub has no metric row", async () => {
		const { reader } = hub([]);
		expect(await reader.list(50)).toMatchObject({ items: [], nextCursor: null });
	});

	it("serves a hub row of a retired built-in id exactly as any other row", async () => {
		const { reader } = hub([count("brief-conformance-items")]);
		const view = await reader.read("brief-conformance-items");
		expect(view.definition.spec.calculatorId).toBe("work.count@1");
		expect(view.definition.revision).toBe("2026-11-01T00:00:00.000Z");
		expect(ids((await reader.list(50)).items)).toEqual(["brief-conformance-items"]);
	});

	it("hides a deprecated hub row and logs nothing, as for any other id", async () => {
		const { reader, events } = hub([count("brief-conformance-items", { status: "deprecated" })]);
		await expect(reader.read("brief-conformance-items")).rejects.toMatchObject({ code: "metric_not_found" });
		expect(await reader.list(50)).toMatchObject({ items: [] });
		expect(events).toEqual([]);
	});

	it("logs and skips an invalid hub row without stopping the rest", async () => {
		const { reader, events } = hub([count("a-bad", { metric_spec: '{"calculatorId":"nope"}' }), count("b-good")]);
		expect(ids((await reader.list(50)).items)).toEqual(["b-good"]);
		expect(events).toContainEqual({ event: "metric.definition_invalid", metricId: "a-bad" });
	});

	it.each([1, 2, 3, 50])("pages hub rows alone, once each, at page size %i", async (limit) => {
		const { reader } = hub([count("a-count"), count("brief-conformance-items"), count("m-count"), count("z-count")]);
		const seen: string[] = [];
		let after: string | undefined;
		for (let page = 0; page < 20; page++) {
			const r = await reader.list(limit, after);
			expect(r.items.length).toBeLessThanOrEqual(limit);
			seen.push(...ids(r.items));
			if (!r.nextCursor) break;
			after = r.nextCursor;
		}
		expect(seen).toEqual(["a-count", "brief-conformance-items", "m-count", "z-count"]);
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
			"edits-7d",
			"edits-kept-current-7d",
			"work-items-in-scope",
			"work-items-no-inline-history",
		]);
		expect(page.catalog.map((c) => c.id)).toContain("no-inline-history@1");
	});
});
