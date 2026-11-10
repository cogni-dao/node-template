// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * diary-free@1: the state, scope and edits source reads with their caps and
 * failure map, the (commit, row) merge-repeat collapse, append detection, the
 * calculator in the goal-metric service, and the removal of package-served
 * definitions (definitions are hub rows only).
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
	readDiaryFreeEdits,
	readDiaryFreeScope,
	readDiaryFreeState,
	DIARY_FREE_MAX_BYTES,
	DIARY_FREE_MAX_EDITS,
	DIARY_FREE_MAX_ROWS,
	diaryFreeEditsSql,
	diaryFreeStateSql,
} from "../src/sources.js";
import { fakeSql, hub, metricRow, noObservations, type Row } from "./fakes.js";

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

describe("diary-free@1 state read", () => {
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
		const sample = await readDiaryFreeState(sql, "work-items", signal);
		expect(queries).toHaveLength(1);
		expect(sample).toMatchObject({ value: 60, unit: "%", complete: true });
		expect(sample.sourceWatermarks).toEqual([{ source: "node.work_items", asOf: ASOF }]);
		expect(sample.evidenceRefs).toEqual([
			"rules:diary-free-rules@1",
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
		const sample = await readDiaryFreeState(sql, "atoms", signal);
		expect(sample).toMatchObject({ value: 50, unit: "%", complete: true });
		expect(sample.sourceWatermarks[0]?.source).toBe("node.knowledge");
		expect(sample.evidenceRefs).toContain("counts:evaluated=4;passing=2");
		expect(sample.evidenceRefs).toContain("rule:dated_line=1");
		expect(sample.evidenceRefs.some((r) => r.startsWith("missing_goal"))).toBe(false);
	});

	it("never puts row text in evidence and reads frozen rows as equal", async () => {
		const secret = "SECRET-BODY-TEXT";
		const { sql } = fakeSql(() => joined([atomRow("e1", { content: `Update: ${secret}` }), atomRow("e2")]));
		const a = await readDiaryFreeState(sql, "atoms", signal);
		const b = await readDiaryFreeState(sql, "atoms", signal);
		expect(b).toEqual(a);
		expect(a.evidenceRefs.join("\n")).not.toContain(secret);
	});

	it("maps an empty scope to zero_denominator, never 0", async () => {
		const { sql } = fakeSql(() => [{ as_of: ASOF, n: "0", bytes: "0", id: null }]);
		expect(await readDiaryFreeState(sql, "work-items", signal)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
		expect(await readDiaryFreeState(fakeSql(() => []).sql, "atoms", signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it.each([
		["rows", { n: String(DIARY_FREE_MAX_ROWS + 1), bytes: "10" }],
		["bytes", { n: "10", bytes: String(DIARY_FREE_MAX_BYTES + 1) }],
	])("fails closed on a cap hit on %s without scoring", async (_cap, totals) => {
		const { sql } = fakeSql(() => [{ as_of: ASOF, id: null, ...totals }]);
		const sample = await readDiaryFreeState(sql, "atoms", signal);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs.join()).toContain("cap_hit");
	});

	it("fails closed when the rows disagree with their own count", async () => {
		const { sql } = fakeSql(() => joined([atomRow("e1")]).map((r) => ({ ...r, n: "2" })));
		expect(await readDiaryFreeState(sql, "atoms", signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it("fails a row whose field the statement sent absent as oversize", async () => {
		const { sql } = fakeSql(() => joined([atomRow("e1", { content: null, oversize: true }), atomRow("e2")]));
		const sample = await readDiaryFreeState(sql, "atoms", signal);
		expect(sample).toMatchObject({ value: 50, complete: true });
		expect(sample.evidenceRefs).toContain("rule:oversize=1");
		expect(sample.evidenceRefs).toContain("worst:e1:oversize");
	});

	it("maps a read error to source_failed and keeps a timeout its own failure", async () => {
		const failing = fakeSql(() => {
			throw new RangeError("relation does not exist SECRET-BODY-TEXT");
		});
		const sample = await readDiaryFreeState(failing.sql, "work-items", signal);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		// The error class is observable; its message never is.
		expect(sample.evidenceRefs).toEqual(["error:RangeError"]);
		const controller = new AbortController();
		const slow = fakeSql(async () => {
			controller.abort();
			throw new Error("canceled");
		});
		await expect(readDiaryFreeState(slow.sql, "work-items", controller.signal)).rejects.toThrow();
	});

	it("sends the scope and caps to the database in one read-only statement", () => {
		const items = diaryFreeStateSql("work-items");
		expect(items).toContain("status NOT IN ('done','cancelled')");
		for (const label of ['"test-fixture"', '"synthetic"', '"synthetic-fixture"']) expect(items).toContain(label);
		expect(items).toContain("s.title, s.summary, s.outcome");
		const atoms = diaryFreeStateSql("atoms");
		expect(atoms).toContain("status <> 'deprecated'");
		expect(atoms).toContain("entry_type <> 'html'");
		expect(atoms).toContain("[TEST]");
		expect(atoms).toContain("s.title, s.use_when, s.content");
		for (const text of [items, atoms]) {
			expect(text).toContain(`t.n <= ${DIARY_FREE_MAX_ROWS}`);
			expect(text).toContain(`t.bytes <= ${DIARY_FREE_MAX_BYTES}`);
			expect(text).toContain("> 100000 THEN NULL");
			expect(text).not.toContain(";");
			expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
		}
	});
});

describe("diary-free@1 scope read", () => {
	it("counts open work items outside fixtures in one statement", async () => {
		const { sql, queries } = fakeSql(() => [{ as_of: ASOF, value: "73" }]);
		const sample = await readDiaryFreeScope(sql, signal);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("status NOT IN ('done','cancelled')");
		expect(sample).toMatchObject({ value: 73, unit: "items", complete: true });
		expect(sample.sourceWatermarks).toEqual([{ source: "node.work_items", asOf: ASOF }]);
		expect(sample.evidenceRefs).toContain("counts:evaluated=73");
	});

	it("keeps a real zero but never a missing count", async () => {
		expect(await readDiaryFreeScope(fakeSql(() => [{ as_of: ASOF, value: "0" }]).sql, signal)).toMatchObject({
			value: 0,
			complete: true,
		});
		expect(await readDiaryFreeScope(fakeSql(() => []).sql, signal)).toMatchObject({ complete: false });
	});
});

/* ---------------------------------------------------------------- edits */

let seq = 0;
/** One dolt_diff row of a work item: the kept commit and its before and after text. */
const itemEdit = (id: string, at: string, over: Row = {}): Row => ({
	id,
	commit_hash: `c${String(++seq).padStart(4, "0")}`,
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
	commit_hash: `c${String(++seq).padStart(4, "0")}`,
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
	rows.length === 0
		? [{ as_of: ASOF, n: "0", bytes: "0", id: null }]
		: rows.map((r) => ({ as_of: ASOF, n: String(rows.length), bytes: String(bytes), ...r }));

/** A fake hub answering the two edits statements from per-table row lists. */
function history(items: Row[], atoms: Row[]) {
	return fakeSql((text) => (text.includes("dolt_diff_work_items") ? totals(items) : totals(atoms)));
}
const edits = async (items: Row[], atoms: Row[], output: "share" | "count" = "share") => {
	const { sql, queries } = history(items, atoms);
	return { sample: await readDiaryFreeEdits(sql, output, window, read), queries };
};

describe("diary-free@1 edits read", () => {
	it("reads work items then atoms in two statements and scores the share that did not append", async () => {
		const clean = Array.from({ length: 8 }, (_, i) => itemEdit(`task.${i}`, IN));
		const appending = [
			itemEdit("task.8", IN, { from_outcome: "Outcome", to_outcome: "Outcome\nUpdate: shipped" }),
			itemEdit("task.9", IN, { from_summary: "S", to_summary: "S\nRev 3" }),
		];
		const atoms = [atomEdit("a1", IN), atomEdit("a2", IN)];
		const { sample, queries } = await edits([...clean, ...appending], atoms);
		expect(queries).toHaveLength(2);
		expect(queries[0]).toContain("dolt_diff_work_items");
		expect(queries[1]).toContain("dolt_diff_knowledge");
		expect(sample).toMatchObject({ unit: "%", complete: true });
		expect(sample.value).toBeCloseTo((100 * 10) / 12, 10);
		expect(sample.sourceWatermarks).toEqual([
			{ source: "node.work_items", asOf: ASOF },
			{ source: "node.knowledge", asOf: ASOF },
		]);
		expect(sample.evidenceRefs).toEqual([
			"rules:diary-free-rules@1",
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

		it("fails closed above the edit cap for either output", async () => {
			const rows = Array.from({ length: DIARY_FREE_MAX_EDITS + 1 }, (_, i) => itemEdit(`task.${i}`, IN));
			for (const output of ["share", "count"] as const) {
				const { sample } = await edits(rows, [], output);
				expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
				expect(sample.evidenceRefs).toContain("cap_hit");
			}
			const exact = Array.from({ length: DIARY_FREE_MAX_EDITS }, (_, i) => itemEdit(`task.${i}`, IN));
			expect((await edits(exact, [], "count")).sample).toMatchObject({ complete: true, value: DIARY_FREE_MAX_EDITS });
		});

		it.each([
			["rows", { n: String(DIARY_FREE_MAX_ROWS + 1), bytes: "10" }],
			["bytes", { n: "10", bytes: String(DIARY_FREE_MAX_BYTES + 1) }],
		])("fails closed on a statement cap hit on %s and stops at the failing table", async (_cap, capped) => {
			const { sql, queries } = fakeSql(() => [{ as_of: ASOF, id: null, ...capped }]);
			const sample = await readDiaryFreeEdits(sql, "count", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
			expect(sample.evidenceRefs.join()).toContain("cap_hit");
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
			expect(await readDiaryFreeEdits(empty.sql, "count", window, read)).toMatchObject({
				complete: false,
				reason: "incomplete_or_invalid_source",
			});
		});

		it("maps a read error to source_failed and keeps a timeout its own failure", async () => {
			const failing = fakeSql(() => {
				throw new TypeError("table not found: dolt_diff_work_items SECRET-BODY-TEXT");
			});
			const sample = await readDiaryFreeEdits(failing.sql, "share", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
			// The error class is observable; its message never is.
			expect(sample.evidenceRefs).toContain("error:TypeError");
			expect(sample.evidenceRefs.join("\n")).not.toContain("SECRET");
			expect(failing.queries).toHaveLength(1);
			const controller = new AbortController();
			const slow = fakeSql(async () => {
				controller.abort();
				throw new Error("canceled");
			});
			await expect(
				readDiaryFreeEdits(slow.sql, "share", window, (source) => source(controller.signal)),
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
		it.each(["work-items", "atoms"] as const)("is one read-only %s statement with UTC window bounds and the caps pushed down", (table) => {
			const text = diaryFreeEditsSql(table, window);
			expect(text.startsWith("WITH diffs AS")).toBe(true);
			expect(text).toContain(table === "work-items" ? "FROM dolt_diff_work_items d" : "FROM dolt_diff_knowledge d");
			expect(text).toContain("d.to_commit <> 'WORKING'");
			expect(text).toContain("d.to_commit_date >= '2026-11-02 12:00:00.000'");
			expect(text).toContain("d.to_commit_date < '2026-11-09 12:00:00.000'");
			expect(text).toContain("d.diff_type = 'modified'");
			expect(text).toContain("IS DISTINCT FROM");
			// No wider history: no subquery, ordered by id then date, one row past the cap.
			expect(text).not.toMatch(/\bIN \(\s*SELECT/i);
			expect(text.match(/FROM dolt_diff_/g)).toHaveLength(1);
			expect(text).toContain(`ORDER BY d.to_id, d.to_commit_date LIMIT ${DIARY_FREE_MAX_ROWS + 1}`);
			// A missing commit row never drops a diff row.
			expect(text).toContain("LEFT JOIN dolt_log l ON l.commit_hash = d.to_commit");
			expect(text).not.toMatch(/(?<!LEFT )JOIN /);
			expect(text).toContain(`t.n <= ${DIARY_FREE_MAX_ROWS}`);
			expect(text).toContain(`t.bytes <= ${DIARY_FREE_MAX_BYTES}`);
			expect(text).toContain("> 100000 THEN NULL");
			expect(text).toContain("CAST(COALESCE(SUM(");
			expect(text).toContain("ORDER BY s.id, s.at, s.commit_hash");
			expect(text).not.toContain(";");
			expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
		});

		it("reads only the changed text columns and the fixture scope as of the commit", () => {
			const items = diaryFreeEditsSql("work-items", window);
			expect(items).toContain("from_summary");
			expect(items).toContain("to_outcome");
			expect(items).not.toContain("d.to_title");
			expect(items).toContain('"test-fixture"');
			expect(items).toContain('"synthetic-fixture"');
			const atoms = diaryFreeEditsSql("atoms", window);
			expect(atoms).toContain("from_content");
			expect(atoms).not.toContain("d.to_summary");
			expect(atoms).toContain("to_entry_type <> 'html'");
			expect(atoms).toContain("[TEST]");
			expect(atoms).toContain("LEFT JOIN knowledge_contribution_commits c ON c.commit_hash = d.to_commit");
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
	if (text.includes("dolt_diff_work_items"))
		return live(totals(Array.from({ length: 10 }, (_, i) => itemEdit(`task.${i}`, recent()))));
	if (text.includes("dolt_diff_knowledge"))
		return live(totals([atomEdit("a1", recent(), { to_content: "Body\nUpdate: s" })]));
	return [];
};
const diaryFreeRows = () => [
	metricRow("work-items-diary-free", "diary-free@1", spec.state),
	metricRow("atoms-diary-free", "diary-free@1", spec.atoms),
	metricRow("work-items-in-scope", "diary-free@1", spec.scope),
	metricRow("edits-kept-current-7d", "diary-free@1", spec.share),
	metricRow("edits-7d", "diary-free@1", spec.count),
];

describe("diary-free@1 in the goal-metric service", () => {
	it("is a published calculator whose family no node calculator may take", () => {
		expect(PACKAGE_CALCULATOR_IDS).toContain("diary-free@1");
		expect(calculatorFamily("diary-free@1")).toBe("diary-free");
		expect(RESERVED_CALCULATOR_FAMILIES.has("diary-free")).toBe(true);
		const { reader } = hub([]);
		const node = {
			id: "diary-free@2",
			unit: "%",
			paramsSchema: reader.registry.get("diary-free@1").paramsSchema,
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
			"diary-free@1",
		]);
		const calc = reader.registry.get("diary-free@1");
		expect(calc.budget).toEqual({
			timeoutMs: 15000,
			maxSourceCalls: 2,
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
		const schema = hub([]).reader.registry.get("diary-free@1").paramsSchema;
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
		["work-items-diary-free", 50, "%", "counts:evaluated=2;passing=1", 1],
		["atoms-diary-free", 100, "%", "counts:evaluated=1;passing=1", 1],
		["work-items-in-scope", 73, "items", "counts:evaluated=73", 1],
		["edits-kept-current-7d", (100 * 10) / 11, "%", "counts:edits=11;appending=1;withReason=0", 2],
		["edits-7d", 11, "edits", "counts:edits=11;appending=1;withReason=0", 2],
	])("computes %s end to end with one terminal log event and the designed source calls", async (id, value, unit, evidence, calls) => {
		const { service, events, queries } = hub(diaryFreeRows(), rowsFor);
		const saved = await service.compute(id, { requestKey: `k-${id}` });
		expect(saved).toMatchObject({ status: "ok", unit, reason: null, calculatorVersion: "diary-free@1" });
		expect(saved.value).toBeCloseTo(value as number, 10);
		expect(saved.evidenceRefs).toContain(evidence);
		const source = queries.filter((q) => !q.startsWith("SELECT id,title,metric_spec"));
		expect(source).toHaveLength(calls as number);
		const terminal = events.filter((e) => (e as { event: string }).event === "metric.compute.completed");
		expect(terminal).toEqual([expect.objectContaining({ metricId: id, status: "ok", reason: null })]);
	});

	it("measures the edits window as seven UTC days ending at the reading", async () => {
		const { service } = hub(diaryFreeRows(), rowsFor);
		const saved = await service.compute("edits-7d", { requestKey: "k-window" });
		const span = Date.parse(saved.window.end) - Date.parse(saved.window.start);
		expect(span).toBe(7 * 86400 * 1000);
		expect(saved.evidenceRefs).toContain(`window:[${saved.window.start},${saved.window.end})`);
	});

	it("refuses a historical evaluation time, since state is read from main now", async () => {
		const { service } = hub(diaryFreeRows(), rowsFor);
		await expect(
			service.compute("work-items-diary-free", { requestKey: "k-hist", evaluationAt: "2026-11-01T00:00:00.000Z" }),
		).rejects.toMatchObject({ code: "historical_window_not_supported", status: 422 });
	});

	it("records an unknown reading with its reason on the one terminal event", async () => {
		const sparse = (text: string) =>
			text.includes("dolt_diff_work_items")
				? live(totals([itemEdit("task.1", recent())]))
				: text.includes("dolt_diff_knowledge")
					? live(totals([]))
					: rowsFor(text);
		const { service, events } = hub(diaryFreeRows(), sparse);
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

	it("still lists the diary-free rows through the registry catalog", async () => {
		const { reader } = hub(diaryFreeRows());
		const page = await reader.list(50);
		expect(ids(page.items).sort()).toEqual([
			"atoms-diary-free",
			"edits-7d",
			"edits-kept-current-7d",
			"work-items-diary-free",
			"work-items-in-scope",
		]);
		expect(page.catalog.map((c) => c.id)).toContain("diary-free@1");
	});
});
