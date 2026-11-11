// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Golden cases for no-inline-history-rules@1: one case per marker and one per false-positive guard. */
import { describe, expect, it } from "vitest";
import {
	appendsHistory,
	approvedLines,
	markerLines,
	passesNoInlineHistory,
	scoreNoInlineHistory,
	summarizeNoInlineHistory,
	NO_INLINE_HISTORY_RULES,
	NO_INLINE_HISTORY_RULES_VERSION,
	noInlineHistoryEvidenceRefs,
} from "../src/no-inline-history.js";

const codes = (text: string) => markerLines(text).flatMap((m) => m.codes);
const lines = (text: string) => markerLines(text).map((m) => m.line);

describe("no-inline-history-rules@1 markers", () => {
	it("is version 1 with six pinned codes in reporting order", () => {
		expect(NO_INLINE_HISTORY_RULES_VERSION).toBe("no-inline-history-rules@1");
		expect(NO_INLINE_HISTORY_RULES).toEqual([
			"dated_line",
			"label_line",
			"revision_tag",
			"caps_marker",
			"review_transcript",
			"strikethrough",
		]);
	});

	describe("dated_line", () => {
		it("matches a line that starts with a date once a field holds two", () => {
			expect(codes("2026-11-01 shipped the route\nPlain line\n2026-11-02 fixed it")).toEqual([
				"dated_line",
				"dated_line",
			]);
		});
		it("matches a short header that ends with a colon and holds a date", () => {
			expect(lines("Shipped on 2026-11-01:\nbody\n2026-11-02 fixed")).toEqual([0, 2]);
		});
		it("lets one deadline or approval date pass", () => {
			expect(codes("Deadline: ship by 2026-11-30.")).toEqual([]);
			expect(codes("2026-11-30 is the deadline")).toEqual([]);
			expect(codes("Approved on 2026-11-01:")).toEqual([]);
		});
		it("does not count a header over 100 characters", () => {
			const long = `${"a".repeat(95)} 2026-11-01:`;
			expect(long.length).toBeGreaterThan(100);
			expect(codes(`${long}\n2026-11-02 fixed`)).toEqual([]);
		});
		it("does not count a date inside a sentence that does not end with a colon", () => {
			expect(codes("We shipped on 2026-11-01 and 2026-11-02 both.\nAnd on 2026-11-03 again.")).toEqual([]);
		});
		it("counts per field, not across fields", () => {
			const score = scoreNoInlineHistory("work-items", {
				title: "T",
				summary: "2026-11-01 one",
				outcome: "2026-11-02 two",
			});
			expect(score.broken).toEqual([]);
			expect(scoreNoInlineHistory("work-items", { outcome: "2026-11-01 a\n2026-11-02 b" }).broken).toEqual(["dated_line"]);
		});
		it("keeps a lone dated line that matches another code", () => {
			expect(codes("2026-11-01 Rev 3 shipped")).toEqual(["revision_tag"]);
			expect(codes("2026-11-01 Rev 3 shipped\n2026-11-02 next")).toEqual(["dated_line", "revision_tag", "dated_line"]);
		});
	});

	describe("label_line", () => {
		it.each(["Update", "Progress", "Changelog", "Revision", "Review", "Pivot", "Log"])(
			"matches %s with a colon, a parenthesis or a digit",
			(label) => {
				expect(codes(`${label}: shipped`)).toContain("label_line");
				expect(codes(`${label}(2 of 3)`)).toContain("label_line");
				expect(codes(`${label} 2 shipped`)).toContain("label_line");
				expect(codes(`${label} : shipped`)).toContain("label_line");
				expect(codes(`${label}  (note) shipped`)).toContain("label_line");
			},
		);
		it("matches a label followed by spaces and a digit, and not one glued to letters or digits", () => {
			expect(codes("Update 3")).toEqual(["label_line"]);
			expect(codes("Progress 40% done")).toEqual(["label_line"]);
			for (const line of ["Log4j is a library", "Update3 shipped", "Logs: x", "Review2", "Updated 3 files"])
				expect(codes(line), line).toEqual([]);
		});
		it("matches through list, quote, heading and bold marks", () => {
			for (const line of [
				"- Update: shipped",
				"* Update: shipped",
				"1. Update: shipped",
				"> Update: shipped",
				"## Update: shipped",
				"**Update:** shipped",
				"**Update**: shipped",
				"- > **Update:** shipped",
				"__Update:__ shipped",
			])
				expect(codes(line), line).toContain("label_line");
		});
		it("never labels Status, State, Due or Owner lines", () => {
			for (const line of [
				"Status: in review",
				"State: blocked on the vendor",
				"Due: 2026-11-30",
				"Owner: Derek",
				"- **Status:** done",
			])
				expect(codes(line), line).toEqual([]);
		});
		it("needs the label first and its punctuation straight after", () => {
			for (const line of [
				"Updates: three",
				"Update the docs",
				"We Update: later",
				"Reviewer: Derek",
				"Login: user",
				"Logging(on)",
			])
				expect(codes(line), line).toEqual([]);
		});
	});

	describe("revision_tag", () => {
		it.each([
			"Rev 3 of the plan",
			"revision 3 of the plan",
			"changed in r7",
			"DESIGN v8 applies",
			"see (r2) for the change",
		])("matches %s", (line) => {
			expect(codes(line)).toEqual(["revision_tag"]);
		});
		it.each([
			"Reverse 3 items",
			"the r7x flag",
			"see /docs/r7",
			"version r2.5 of the spec",
			"Design v8 applies",
			"the revision of the plan",
			"R7 is capital",
		])("does not match %s", (line) => {
			expect(codes(line)).toEqual([]);
		});
	});

	describe("caps_marker", () => {
		it.each(["DESIGN REVIEW notes", "PROPOSED PIVOT to goal", "a PIVOT here", "CHECKPOINT reached"])(
			"matches %s",
			(line) => {
				expect(codes(line)).toEqual(["caps_marker"]);
			},
		);
		it("is case sensitive and word bounded", () => {
			for (const line of ["design review notes", "pivot table", "a Checkpoint", "PIVOTAL moment", "CHECKPOINTS"])
				expect(codes(line), line).toEqual([]);
		});
	});

	describe("review_transcript", () => {
		it.each([
			"Verdict: approve",
			"Verdict. Looks fine",
			"APPROVE: ship it",
			"APPROVE. Done",
			"REQUEST CHANGES: add tests",
			"Independent reviewer found two gaps",
			"Fresh-context reviewer agreed",
			"Third reviewer pass",
			"- **Verdict:** approve",
		])("matches %s", (line) => {
			expect(codes(line)).toEqual(["review_transcript"]);
		});
		it.each([
			"Verdict pending",
			"Approved by the owner",
			"APPROVE the plan later",
			"Independent verification of the build",
		])("does not match %s", (line) => {
			expect(codes(line)).toEqual([]);
		});
		it("needs the reviewer word within 40 characters of an opener", () => {
			expect(codes(`Independent ${"x".repeat(40)} reviewer`)).toEqual([]);
			expect(codes("Fresh start with a reviewer")).toEqual(["review_transcript"]);
		});
	});

	describe("strikethrough", () => {
		it("matches struck text anywhere in a line", () => {
			expect(codes("~~old plan~~ new plan")).toEqual(["strikethrough"]);
			expect(codes("keep ~~this~~ out")).toEqual(["strikethrough"]);
		});
		it("does not match a lone tilde pair or a single tilde", () => {
			expect(codes("a ~~ b")).toEqual([]);
			expect(codes("about ~5 items, ~10 later")).toEqual([]);
			expect(codes("~~~~")).toEqual([]);
		});
	});
});

describe("no-inline-history-rules@1 false-positive guards", () => {
	it("never matches a checklist line", () => {
		for (const line of [
			"- [ ] Update: ship it",
			"- [x] 2026-11-01 done",
			"[ ] Review: the design",
			"[x] Rev 3 applied",
			"* [X] ~~old~~ item",
			"1. [ ] PIVOT the plan",
		])
			expect(codes(line), line).toEqual([]);
		expect(codes("- [ ] 2026-11-01 a\n- [ ] 2026-11-02 b")).toEqual([]);
	});

	it("never matches a link-only line", () => {
		for (const line of [
			"[Update: the route](https://example.com/u)",
			"- [PR #12 Rev 3](https://github.com/x/pull/12)",
			"https://example.com/DESIGN-REVIEW/r7",
			"- <https://example.com/Update:1>",
			"[one](https://a.example) · [two](https://b.example)",
			"> ![Update: image](https://img.example/x.png)",
		])
			expect(codes(line), line).toEqual([]);
	});

	it("matches a line that mixes a link with its own marker text", () => {
		expect(codes("Update: see [the PR](https://example.com/pull/1)")).toEqual(["label_line"]);
		expect(codes("[PR](https://example.com) Rev 3 landed")).toEqual(["revision_tag"]);
	});

	it("never matches inside fenced code", () => {
		const text = "Before\n```\nUpdate: x\n2026-11-01 a\n2026-11-02 b\nRev 3\n```\nAfter";
		expect(codes(text)).toEqual([]);
		const tildes = "~~~sh\nUPDATE: x\nPIVOT\n~~~";
		expect(codes(tildes)).toEqual([]);
	});

	it("reads an unclosed fence as prose", () => {
		expect(codes("```\nUpdate: x")).toEqual(["label_line"]);
	});

	it("passes plain current-state prose", () => {
		const text = [
			"Goal = Work items say what is true now",
			"Done when = Production shows three KPIs, each equal to a recompute.",
			"Status: ready for review",
			"Owner: dev-manager",
			"Due: 2026-11-16",
			"- [ ] Release the package",
			"- [ ] Merge the rows",
			"The calculator reads main through the node's own client.",
		].join("\n");
		expect(codes(text)).toEqual([]);
	});

	it("scores an empty or absent field as clean", () => {
		expect(markerLines("")).toEqual([]);
		expect(markerLines(null)).toEqual([]);
		expect(markerLines(undefined)).toEqual([]);
		expect(markerLines("\n\n   \n")).toEqual([]);
	});
});

describe("scoreNoInlineHistory", () => {
	it("scores the fields of each subject and reports codes in reporting order", () => {
		const items = scoreNoInlineHistory("work-items", {
			title: "A title",
			summary: "~~old~~ summary",
			outcome: "Goal = x\nUpdate: shipped\nRev 3",
			// Not scored for work items.
			content: "Update: ignored",
		});
		expect(items.broken).toEqual(["label_line", "revision_tag", "strikethrough"]);
		expect(items.markerLines).toBe(3);
		expect(passesNoInlineHistory(items)).toBe(false);
		const atoms = scoreNoInlineHistory("atoms", {
			title: "T",
			use_when: "PIVOT",
			content: "body",
			// Not scored for atoms.
			outcome: "Update: ignored",
		});
		expect(atoms.broken).toEqual(["caps_marker"]);
	});

	it("fails a row with a field over the cap, and one the source flagged", () => {
		const big = scoreNoInlineHistory("atoms", { content: "a".repeat(100_001) });
		expect(big).toMatchObject({ broken: [], oversize: true, markerLines: 0 });
		expect(passesNoInlineHistory(big)).toBe(false);
		expect(scoreNoInlineHistory("atoms", { content: "ok", oversize: true }).oversize).toBe(true);
		expect(passesNoInlineHistory(scoreNoInlineHistory("atoms", { content: "a".repeat(100_000) }))).toBe(true);
	});

	it("passes a clean row", () => {
		expect(passesNoInlineHistory(scoreNoInlineHistory("work-items", { title: "T", summary: "S", outcome: "O" }))).toBe(true);
	});
});

describe("approvedLines", () => {
	it("finds the approved Goal and Done when lines outside fences", () => {
		expect(approvedLines("Goal = x\nDone when = y")).toEqual({ goal: true, doneWhen: true });
		expect(approvedLines("Goal = x")).toEqual({ goal: true, doneWhen: false });
		expect(approvedLines("```\nGoal = x\nDone when = y\n```")).toEqual({ goal: false, doneWhen: false });
		expect(approvedLines("Goal =\nDone when =  ")).toEqual({ goal: false, doneWhen: false });
		expect(approvedLines(null)).toEqual({ goal: false, doneWhen: false });
	});
});

describe("appendsHistory", () => {
	it("is an append when the marker-line count grows across the changed columns", () => {
		expect(appendsHistory([{ from: "State", to: "State\nUpdate: shipped" }])).toBe(true);
		expect(appendsHistory([{ from: "a", to: "a\n2026-11-01 x\n2026-11-02 y" }])).toBe(true);
	});
	it("is not an append when a marker line is reworded", () => {
		expect(appendsHistory([{ from: "Update: one", to: "Update: two" }])).toBe(false);
	});
	it("is not an append when marker lines are removed or none exist", () => {
		expect(appendsHistory([{ from: "Update: one\nRev 3", to: "Rev 3" }])).toBe(false);
		expect(appendsHistory([{ from: "a", to: "b" }])).toBe(false);
		expect(appendsHistory([{ from: "Update: one", to: "clean" }])).toBe(false);
	});
	it("nets additions against removals across columns, and skips unchanged columns", () => {
		expect(
			appendsHistory([
				{ from: "Update: one", to: "clean" },
				{ from: "x", to: "x\nUpdate: two" },
			]),
		).toBe(false);
		expect(
			appendsHistory([
				{ from: "Update: one", to: "Update: one" },
				{ from: "x", to: "x\nRev 4" },
			]),
		).toBe(true);
	});
	it("lets a second dated line turn a lone date into history", () => {
		expect(appendsHistory([{ from: "2026-11-01 start", to: "2026-11-01 start\n2026-11-02 next" }])).toBe(true);
	});
	it("treats an absent side as empty", () => {
		expect(appendsHistory([{ from: null, to: "Update: a" }])).toBe(true);
		expect(appendsHistory([{ from: "Update: a", to: null }])).toBe(false);
	});
});

describe("summarizeNoInlineHistory", () => {
	const rows = [
		{ id: "task.1", broken: [] as const, oversize: false, missingGoal: false, missingDoneWhen: true },
		{ id: "task.2", broken: ["label_line", "revision_tag"] as const, oversize: false, missingGoal: true, missingDoneWhen: true },
		{ id: "task.3", broken: ["strikethrough"] as const, oversize: false },
		{ id: "task.4", broken: [] as const, oversize: true },
	];

	it("folds rows into the value and evidence with ids and counts only", () => {
		const summary = summarizeNoInlineHistory("work-items", rows);
		expect(summary).toMatchObject({ evaluated: 4, passing: 1, percent: 25, oversize: 1, missingGoal: 1, missingDoneWhen: 2 });
		expect(noInlineHistoryEvidenceRefs(summary)).toEqual([
			"rules:no-inline-history-rules@1",
			"counts:evaluated=4;passing=1",
			"rule:dated_line=0",
			"rule:label_line=1",
			"rule:revision_tag=1",
			"rule:caps_marker=0",
			"rule:review_transcript=0",
			"rule:strikethrough=1",
			"rule:oversize=1",
			"missing_goal=1;missing_done_when=2",
			"worst:task.2:label_line+revision_tag",
			"worst:task.3:strikethrough",
			"worst:task.4:oversize",
		]);
	});

	it("leaves the missing-line evidence out for atoms and keeps ten worst at most", () => {
		const many = Array.from({ length: 14 }, (_, i) => ({
			id: `a${String(i).padStart(2, "0")}`,
			broken: ["label_line"] as const,
			oversize: false,
		}));
		const refs = noInlineHistoryEvidenceRefs(summarizeNoInlineHistory("atoms", many));
		expect(refs.some((r) => r.startsWith("missing_goal"))).toBe(false);
		expect(refs.filter((r) => r.startsWith("worst:"))).toHaveLength(10);
		expect(refs.filter((r) => r.startsWith("worst:"))[0]).toBe("worst:a00:label_line");
	});

	it("never depends on input order and reports null for no rows", () => {
		expect(summarizeNoInlineHistory("work-items", [...rows].reverse())).toEqual(summarizeNoInlineHistory("work-items", rows));
		expect(summarizeNoInlineHistory("atoms", []).percent).toBeNull();
	});

	it("labels a stored id safely", () => {
		const refs = noInlineHistoryEvidenceRefs(
			summarizeNoInlineHistory("atoms", [{ id: "weird id;\nwith:chars", broken: ["label_line"], oversize: false }]),
		);
		expect(refs.at(-1)).toBe("worst:weird_id__with_chars:label_line");
	});
});
