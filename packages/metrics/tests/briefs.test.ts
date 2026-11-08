// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Golden cases for brief-rules@1: one case per Goodhart move and per sentence-unit rule. */
import { describe, expect, it } from "vitest";
import {
	BRIEF_RULES_VERSION,
	briefEvidenceRefs,
	fieldSentences,
	scoreBrief,
	sentenceLimit,
	summarizeBriefs,
} from "../src/briefs";

/** n plain words, none a listed verb. */
const words = (n: number, w = "alpha") => Array(n).fill(w).join(" ");
const GOAL = "Goal = Measure briefs weekly";
const DONE = "Done when = A reading appears on candidate";
const item = (outcome: string, extra: Record<string, string> = {}) =>
	scoreBrief("items", { title: "A title", outcome, ...extra }, 0.1);
const entry = (content: string, useWhen = "choosing a metric", title = "T") =>
	scoreBrief("entries", { title, use_when: useWhen, content }, 0.1);

describe("brief-rules@1 sentence units", () => {
	it("is versioned", () => expect(BRIEF_RULES_VERSION).toBe("brief-rules@1"));

	it("splits after . ! ? when a space and a capital, digit, quote or bracket follow", () => {
		const s = (t: string) => fieldSentences(t).map((x) => x.text);
		expect(s("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
		expect(s("One. 2 items. (Note) here. \"Quoted\" end.")).toEqual([
			"One.",
			"2 items.",
			"(Note) here.",
			"\"Quoted\" end.",
		]);
		// A lower-case word after the space is not a boundary.
		expect(s("One. two stays")).toEqual(["One. two stays"]);
		// No space after the terminator: a version or a host name stays whole.
		expect(s("See v1.2 and example.com today")).toHaveLength(1);
	});

	it("never splits after e.g. i.e. etc. vs. cf., or on an ellipsis", () => {
		for (const abbr of ["e.g.", "i.e.", "etc.", "vs.", "cf.", "E.G."])
			expect(fieldSentences(`Pick one ${abbr} Another thing`)).toHaveLength(1);
		expect(fieldSentences("Wait... Then go")).toHaveLength(1);
	});

	it("never splits on a semicolon, colon or dash, so they cannot hide a long sentence", () => {
		const long = `${words(12)}; ${words(12)}: ${words(12)} - ${words(12)}`;
		expect(fieldSentences(long)).toHaveLength(1);
		expect(entry(long).broken).toContain("long_sentences");
	});

	it("counts a markdown link by its text, a bare URL as one word and inline code by its words", () => {
		const [link] = fieldSentences("See [two words](https://example.com/a/very/long/path) now");
		expect(link?.words).toBe(4);
		const [bare] = fieldSentences("Read https://example.com/a/b/c?x=1&y=2 today");
		expect(bare?.words).toBe(3);
		const [code] = fieldSentences("Run `pnpm test --filter x` now");
		expect(code?.words).toBe(6);
	});

	it("splits a sentence that a bold lead-in closes", () => {
		expect(
			fieldSentences("**An existing package reaches a node.** Automation may propose it."),
		).toHaveLength(2);
	});

	it("limits a sentence to 20 words after a listed verb and 25 otherwise, ignoring case", () => {
		expect(sentenceLimit("Run the gates")).toBe(20);
		expect(sentenceLimit("RUN the gates")).toBe(20);
		expect(sentenceLimit("The gates run")).toBe(25);
		const at = (first: string, n: number) => `${first} ${words(n - 1)}.`;
		expect(fieldSentences(at("Run", 21))[0]).toMatchObject({ words: 21, limit: 20 });
		expect(entry(at("Run", 21)).broken).toContain("long_sentences");
		expect(entry(at("Run", 20)).broken).not.toContain("long_sentences");
		expect(entry(at("The", 25)).broken).not.toContain("long_sentences");
		expect(entry(at("The", 26)).broken).toContain("long_sentences");
	});

	it("treats a list item with its continuation lines as one unit", () => {
		const text = `- ${words(15)}\n  ${words(15)}\n- short item`;
		expect(fieldSentences(text).map((s) => s.words)).toEqual([30, 2]);
	});

	it("reads every checkbox line as its own unit, with or without a bullet", () => {
		const text = `[x] ${words(3)}\n[ ] ${words(4)}\n- [X] ${words(5)}`;
		expect(fieldSentences(text).map((s) => s.words)).toEqual([3, 4, 5]);
	});

	it("strips bullets, numbers with . or ), and heading marks", () => {
		const text = `# Head ${words(1)}\n1. first\n2) second\n* third`;
		expect(fieldSentences(text).map((s) => s.text)).toEqual([
			"Head alpha",
			"first",
			"second",
			"third",
		]);
	});

	it("counts a table cell as one unit and ignores the separator row", () => {
		const text = `| a | b |\n| --- | :---: |\n| ${words(30)} | short |`;
		expect(fieldSentences(text).map((s) => s.words)).toEqual([1, 1, 30, 1]);
		expect(entry(`| h |\n| --- |\n| ${words(30)} |`).broken).toContain("long_sentences");
	});

	it("joins the lines of one paragraph and starts a new one at a blank line", () => {
		expect(fieldSentences(`${words(14)}\n${words(14)}`)[0]?.words).toBe(28);
		expect(fieldSentences(`${words(14)}\n\n${words(14)}`)).toHaveLength(2);
	});

	it("treats CRLF and lone CR like LF", () => {
		const lf = entry(`${words(3)}\n\n${words(30)}`);
		expect(entry(`${words(3)}\r\n\r\n${words(30)}`)).toEqual(lf);
		expect(entry(`${words(3)}\r\r${words(30)}`)).toEqual(lf);
	});

	it("gives a row with no sentences a share of 0", () => {
		expect(entry("").broken).not.toContain("long_sentences");
		expect(scoreBrief("entries", {}, 0)).toMatchObject({
			sentences: 0,
			longSentences: 0,
		});
	});
});

describe("brief-rules@1 fences (Goodhart: hiding long prose)", () => {
	const long = words(40);
	it("does not score a closed backtick fence", () => {
		expect(entry(`Short.\n\n\`\`\`\n${long}\n\`\`\``).broken).toEqual([]);
	});
	it("does not score a closed tilde fence", () => {
		expect(entry(`Short.\n\n~~~\n${long}\n~~~`).broken).toEqual([]);
	});
	it("lets a longer closing fence close a shorter opening one", () => {
		expect(entry(`Short.\n\n\`\`\`\n${long}\n\`\`\`\`\`\n\nAfter.`).broken).toEqual([]);
	});
	it("keeps a shorter or different fence from closing", () => {
		// ```` opened, only ``` and ~~~ follow: unclosed, so the prose is scored.
		expect(entry(`Short.\n\n\`\`\`\`\n${long}\n\`\`\`\n~~~`).broken).toContain("long_sentences");
	});
	it("does not treat an unclosed fence as a fence", () => {
		expect(entry(`Short.\n\n\`\`\`\n${long}`).broken).toContain("long_sentences");
		expect(entry(`Short.\n\n~~~ js\n${long}`).broken).toContain("long_sentences");
	});
	it("reads a line with 4 or more leading spaces as prose, not a fence", () => {
		expect(entry(`Short.\n\n    \`\`\`\n${long}\n    \`\`\``).broken).toContain("long_sentences");
		expect(entry(`Short.\n\n   \`\`\`\n${long}\n   \`\`\``).broken).toEqual([]);
	});
	it("keeps a fence opened by an inline span of backticks from hiding prose", () => {
		expect(entry(`\`\`\`inline\`\`\` ${long}\n\n\`\`\``).broken).toContain("long_sentences");
	});
	it("skips fenced lines for the line rules too", () => {
		expect(entry("Short.\n\n```\n2026-11-07 shipped\nUpdate: x\n```").broken).toEqual([]);
		expect(item(`${GOAL}\n${DONE}\n\`\`\`\n2026-11-07 shipped\n\`\`\``).broken).toEqual([]);
		// An approved line inside a fence does not count.
		expect(item(`\`\`\`\n${GOAL}\n${DONE}\n\`\`\``).broken).toEqual(["no_goal", "no_done_when"]);
	});
	it("resets fence state per field", () => {
		const s = scoreBrief("items", { title: "```", summary: long, outcome: `${GOAL}\n${DONE}` }, 0.1);
		expect(s.broken).toContain("long_sentences");
	});
});

describe("brief-rules@1 long-sentence share", () => {
	const sentences = (long: number, short: number) =>
		[...Array(long).fill(`Alpha ${words(29, "beta")}.`), ...Array(short).fill("Short one.")].join(" ");
	it("fails only above maxLongShare", () => {
		expect(entry(sentences(1, 9)).broken).toEqual([]);
		expect(entry(sentences(2, 9)).broken).toEqual(["long_sentences"]);
		expect(scoreBrief("entries", { title: "T", use_when: "u", content: sentences(1, 9) }, 0.05).broken).toEqual(["long_sentences"]);
	});
	it("pools the sentences of every scored field", () => {
		const s = scoreBrief("items", { title: "Short", summary: `${words(30)}.`, outcome: `${GOAL}\n${DONE}` }, 0.4);
		expect(s).toMatchObject({ sentences: 2, longSentences: 1 });
		expect(s.broken).toEqual(["long_sentences"]);
	});
	it("scores a long title", () => {
		expect(entry("Short.", "u", words(30)).broken).toEqual(["long_sentences"]);
	});
});

describe("brief-rules@1 approved lines (human-gated)", () => {
	it("passes agent-fixable rules when only the human-gated lines are missing", () => {
		expect(item("plain text").broken).toEqual(["no_goal", "no_done_when"]);
	});
	it("needs non-space text after Goal = and Done when = at the start of a line", () => {
		expect(item("Goal =\nDone when = ").broken).toEqual(["no_goal", "no_done_when"]);
		expect(item("Goal=x\nDone when=y").broken).toEqual(["no_goal", "no_done_when"]);
		expect(item(" Goal = x\n- Done when = y").broken).toEqual(["no_goal", "no_done_when"]);
		expect(item(`${GOAL}\n${DONE}`).broken).toEqual([]);
	});
	it("exempts the two lines from sentence scoring but flags long ones as human-gated", () => {
		const longGoal = `Goal = ${words(13)}`;
		const longDone = `Done when = ${words(26)}`;
		expect(item(`${GOAL}\n${longDone}`).broken).toEqual(["approved_line_long"]);
		expect(item(`${longGoal}\n${DONE}`).broken).toEqual(["approved_line_long"]);
		expect(item(`Goal = ${words(12)}\nDone when = ${words(25)}`).broken).toEqual([]);
		// The long approved lines never become long sentences.
		expect(item(`${longGoal}\n${longDone}`).longSentences).toBe(0);
	});
	it("does not exempt the same text in another field or after other prose", () => {
		const s = scoreBrief("items", { title: "T", summary: `Goal = ${words(40)}`, outcome: `${GOAL}\n${DONE}` }, 0.1);
		expect(s.broken).toEqual(["long_sentences"]);
	});
});

describe("brief-rules@1 log blocks", () => {
	const logged = (text: string) => item(`${GOAL}\n${DONE}\n${text}`).broken.includes("log_block");
	it("flags a dated line, after an optional marker, bold or bracket", () => {
		for (const line of [
			"2026-11-07 shipped",
			"- 2026-11-07 shipped",
			"1. 2026-11-07 shipped",
			"**2026-11-07** shipped",
			"[2026-11-07] shipped",
			"- [x] 2026-11-07 shipped",
			"Nov 7 shipped",
			"- **November 7**: shipped",
			"Sept. 9 shipped",
		])
			expect(logged(line), line).toBe(true);
	});
	it("does not flag prose that merely mentions a date or month", () => {
		for (const line of [
			"Shipped on 2026-11-07",
			"Ships in November",
			"The May 7 release",
			"Nov",
		])
			expect(logged(line), line).toBe(false);
	});
	it("flags a log label followed by a colon, a parenthesis or an ISO date within 40 characters", () => {
		for (const line of [
			"Update: fixed",
			"Update (PR #4) merged",
			"Progress 2026-11-07 done",
			"- Changelog: x",
			"**Review verdict**: APPROVE",
			"Review transcript: x",
			"Pivot: new goal",
			"Superseded by story.1 (see link)",
		])
			expect(logged(line), line).toBe(true);
		expect(logged(`Update ${words(10)}: late`)).toBe(false);
		expect(logged("Update the claim before you start")).toBe(false);
		expect(logged("Progressive rollout is safe")).toBe(false);
	});
	it("applies to entries and to every scored field", () => {
		expect(entry("Update: fixed").broken).toEqual(["log_block"]);
		expect(scoreBrief("items", { title: "Update: x", outcome: `${GOAL}\n${DONE}` }, 0.1).broken).toEqual(["log_block"]);
		expect(scoreBrief("entries", { title: "T", use_when: "2026-11-07 x", content: "ok." }, 0.1).broken).toEqual(["log_block"]);
	});
});

describe("brief-rules@1 use_when and size", () => {
	it("needs a use_when of 1 to 320 characters on entries only", () => {
		expect(entry("ok.", "").broken).toEqual(["use_when"]);
		expect(entry("ok.", "   ").broken).toEqual(["use_when"]);
		expect(scoreBrief("entries", { title: "T", content: "ok." }, 0.1).broken).toEqual(["use_when"]);
		expect(entry("ok.", "x".repeat(320)).broken).toEqual([]);
		expect(entry("ok.", "x".repeat(321)).broken).toEqual(["use_when"]);
		expect(scoreBrief("items", { title: "T", outcome: `${GOAL}\n${DONE}` }, 0.1).broken).toEqual([]);
	});
	it("flags a scored field over 100000 characters as unbounded", () => {
		expect(entry("x".repeat(100_000)).broken).not.toContain("unbounded_text");
		expect(entry("x".repeat(100_001)).broken).toContain("unbounded_text");
		expect(item(`${GOAL}\n${DONE}`, { summary: "x".repeat(100_001) }).broken).toEqual(["unbounded_text"]);
	});
	it("flags a field the source sent absent because it was over the cap", () => {
		expect(scoreBrief("entries", { title: "T", use_when: "u", content: null, oversize: true }, 0.1).broken).toEqual(["unbounded_text"]);
		// An oversize use_when arrives absent, so it breaks use_when as well.
		expect(scoreBrief("entries", { title: "T", use_when: null, content: "ok.", oversize: true }, 0.1).broken).toEqual(["use_when", "unbounded_text"]);
	});
	it("reports broken rules in reporting order", () => {
		const s = scoreBrief("items", { title: "Update: x", summary: words(40), outcome: "x".repeat(100_001) }, 0.1);
		expect(s.broken).toEqual(["no_goal", "no_done_when", "log_block", "long_sentences", "unbounded_text"]);
	});
});

describe("brief-rules@1 summary", () => {
	const rows = [
		{ id: "b", broken: ["long_sentences", "log_block"] as const },
		{ id: "a", broken: ["long_sentences", "log_block"] as const },
		{ id: "c", broken: ["no_goal"] as const },
		{ id: "d", broken: [] as const },
		{ id: "e", broken: ["log_block"] as const },
	];
	it("keeps rows that break only human-gated rules in the denominator and passing", () => {
		const s = summarizeBriefs("items", rows);
		expect(s).toMatchObject({ evaluated: 5, passing: 2, humanGatedFailing: 1, percent: 40 });
	});
	it("ranks worst rows by most agent-fixable rules, then id, whatever the input order", () => {
		const forward = summarizeBriefs("items", rows);
		const backward = summarizeBriefs("items", [...rows].reverse());
		expect(forward.worst.map((w) => w.id)).toEqual(["a", "b", "e"]);
		expect(backward).toEqual(forward);
	});
	it("lists at most 10 worst rows and an empty scope has no percent", () => {
		const many = Array.from({ length: 25 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}`, broken: ["log_block"] as const }));
		expect(summarizeBriefs("entries", many).worst).toHaveLength(10);
		expect(summarizeBriefs("entries", [])).toMatchObject({ evaluated: 0, percent: null });
	});
	it("writes evidence without row text", () => {
		const refs = briefEvidenceRefs(summarizeBriefs("items", rows));
		expect(refs).toEqual([
			"counts:evaluated=5;passing=2",
			"rule:no_goal=1",
			"rule:no_done_when=0",
			"rule:approved_line_long=0",
			"rule:log_block=3",
			"rule:long_sentences=2",
			"rule:unbounded_text=0",
			"human_gated_failing=1",
			"worst:a:log_block+long_sentences",
			"worst:b:log_block+long_sentences",
			"worst:e:log_block",
		]);
		const odd = briefEvidenceRefs(summarizeBriefs("entries", [{ id: "x y\nz", broken: ["log_block"] }]));
		expect(odd).toContain("worst:x_y_z:log_block");
	});
});
