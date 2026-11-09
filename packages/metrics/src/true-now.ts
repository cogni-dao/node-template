// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `true-now-rules@1`: a pure, deterministic marker scorer. A work item or a
 * knowledge atom says what is true now; the story of how we got here lives in
 * history. A line that carries inline history is a marker line. It reads text
 * only; no SQL, no clock, no NLP library. A change to any marker, list or limit
 * here is a version bump of the rule set and of the `true-now@1` calculator.
 *
 * Fenced code, checklist lines and link-only lines never match. A `dated_line`
 * counts only when one field holds two or more, so one deadline or approval
 * date passes. `Status`, `State`, `Due` and `Owner` are never labels.
 */
import { toLines } from "./briefs.js";

export const TRUE_NOW_RULES_VERSION = "true-now-rules@1";
export type TrueNowSubject = "work-items" | "atoms";

/** Marker codes in reporting order. */
export const TRUE_NOW_RULES = [
	"dated_line",
	"label_line",
	"revision_tag",
	"caps_marker",
	"review_transcript",
	"strikethrough",
] as const;
export type TrueNowRule = (typeof TRUE_NOW_RULES)[number];

/** Scored fields of each subject. */
export const TRUE_NOW_FIELDS = {
	"work-items": ["title", "summary", "outcome"],
	atoms: ["title", "use_when", "content"],
} as const;

/** A scored field longer than this many characters fails its row. */
export const TRUE_NOW_MAX_FIELD_CHARS = 100_000;
/** A line of 100 characters or fewer that ends with `:` and holds a date is a dated line. */
const DATED_HEADER_MAX_CHARS = 100;

const DATE = /\d{4}-\d{2}-\d{2}/;
/** A label is a whole word, then optional spaces, then `:`, `(` or a digit: `Update 3` yes, `Log4j` no. */
const LABEL =
	/^(?:Update|Progress|Changelog|Revision|Review|Pivot|Log)\b *(?::|\(|\d)/;
const REVISION_WORD = /\brev(?:ision)?\s+\d+\b/i;
/** A bare `r7`: never part of a path, an identifier or a decimal. */
const REVISION_BARE = /(?<![\w/.#:@-])r\d{1,3}(?![\w/-]|\.\d)/;
const DESIGN_VERSION = /\bDESIGN v\d+\b/;
const CAPS = /\b(?:DESIGN REVIEW|PROPOSED PIVOT|PIVOT|CHECKPOINT)\b/;
const VERDICT = /^(?:Verdict|APPROVE|REQUEST CHANGES)[.:]/;
const REVIEWER_OPENER = /^(?:Independent|Fresh|Third)\b/;
const STRIKE = /~~[^~\n]+?~~/;
const CHECKLIST = /^\[[ xX]\](?:\s|$)/;
const LINK = /!?\[[^\]]*\]\([^)]*\)|<?https?:\/\/[^\s>)]+>?/g;
const LINK_LEFTOVER = /^[\s,;:.·|•()[\]–—-]*$/;

/**
 * The text of one line after its list, quote, heading and bold marks, or null
 * when the line can never match: a checklist line or a link-only line.
 */
function bodyOf(text: string): string | null {
	let body = text.trimStart();
	for (let pass = 0; pass < 6; pass++) {
		const next = body
			.replace(/^(?:>\s?|#{1,6}\s+)/, "")
			.replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "")
			.trimStart();
		if (next === body) break;
		body = next;
	}
	if (CHECKLIST.test(body)) return null;
	const links = body.match(LINK);
	if (links && LINK_LEFTOVER.test(body.replace(LINK, ""))) return null;
	return body
		.replace(/\*+/g, "")
		// Paired `__bold__` at word boundaries only; `__init__` stays whole.
		.replace(/(?<!\w)__(?=\S)([^_]*\s[^_]*?)(?<=\S)__(?!\w)/g, "$1")
		// A line that opens with bold underscores around a single word.
		.replace(/^__+(?=\S)/, "")
		.trim();
}

/** Codes one line matches before the dated-line count is applied. */
function codesOf(body: string): TrueNowRule[] {
	const codes: TrueNowRule[] = [];
	if (/^\d{4}-\d{2}-\d{2}/.test(body)) codes.push("dated_line");
	else if (
		body.length <= DATED_HEADER_MAX_CHARS &&
		body.endsWith(":") &&
		DATE.test(body)
	)
		codes.push("dated_line");
	if (LABEL.test(body)) codes.push("label_line");
	if (
		REVISION_WORD.test(body) ||
		REVISION_BARE.test(body) ||
		DESIGN_VERSION.test(body)
	)
		codes.push("revision_tag");
	if (CAPS.test(body)) codes.push("caps_marker");
	if (
		VERDICT.test(body) ||
		(REVIEWER_OPENER.test(body) && /reviewer/i.test(body.slice(0, 40)))
	)
		codes.push("review_transcript");
	if (STRIKE.test(body)) codes.push("strikethrough");
	return codes;
}

/** One marker line of a field: its position and the codes it matches. */
export interface MarkerLine {
	/** Zero-based line index in the field. */
	line: number;
	codes: TrueNowRule[];
}

/** Every marker line of one field. A lone dated line is a date, not a marker. */
export function markerLines(text: string | null | undefined): MarkerLine[] {
	const found: MarkerLine[] = [];
	const lines = toLines(text ?? "");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || line.fenced) continue;
		const body = bodyOf(line.text);
		if (body === null || body === "") continue;
		const codes = codesOf(body);
		if (codes.length) found.push({ line: i, codes });
	}
	const dated = found.filter((m) => m.codes.includes("dated_line")).length;
	if (dated >= 2) return found;
	return found
		.map((m) => ({ ...m, codes: m.codes.filter((c) => c !== "dated_line") }))
		.filter((m) => m.codes.length > 0);
}

/** Scored text of one row. Absent fields are null or undefined. */
export interface TrueNowFields {
	title?: string | null | undefined;
	/** Work items only. */
	summary?: string | null | undefined;
	/** Work items only. */
	outcome?: string | null | undefined;
	/** Atoms only. */
	use_when?: string | null | undefined;
	/** Atoms only. */
	content?: string | null | undefined;
	/** A source flagged a field over the cap and sent it absent. */
	oversize?: boolean | undefined;
}
export interface TrueNowScore {
	/** Every marker code the row holds, in reporting order. */
	broken: TrueNowRule[];
	/** The row holds a field over the cap, which fails it. */
	oversize: boolean;
	/** Marker lines across every scored field. */
	markerLines: number;
}

/** Score one row: it passes when it has no marker line and no oversize field. */
export function scoreTrueNow(
	subject: TrueNowSubject,
	fields: TrueNowFields,
): TrueNowScore {
	const held = new Set<TrueNowRule>();
	let lines = 0;
	let oversize = fields.oversize === true;
	for (const name of TRUE_NOW_FIELDS[subject]) {
		const value = fields[name] ?? "";
		if (value.length > TRUE_NOW_MAX_FIELD_CHARS) {
			oversize = true;
			continue;
		}
		const found = markerLines(value);
		lines += found.length;
		for (const m of found) for (const c of m.codes) held.add(c);
	}
	return {
		broken: TRUE_NOW_RULES.filter((r) => held.has(r)),
		oversize,
		markerLines: lines,
	};
}

/** True when the row has no marker line and no oversize field. */
export function passesTrueNow(score: TrueNowScore): boolean {
	return score.broken.length === 0 && !score.oversize;
}

const APPROVED = /^(Goal|Done when) = (?=\S)/;
/** Whether an outcome holds an approved `Goal =` line and a `Done when =` line. Evidence only. */
export function approvedLines(outcome: string | null | undefined): {
	goal: boolean;
	doneWhen: boolean;
} {
	let goal = false;
	let doneWhen = false;
	for (const line of toLines(outcome ?? "")) {
		if (line.fenced) continue;
		const m = APPROVED.exec(line.text);
		if (m?.[1] === "Goal") goal = true;
		else if (m) doneWhen = true;
	}
	return { goal, doneWhen };
}

/**
 * Marker lines the changed columns of one edit held before and after it. An
 * edit appends history when the count grows; rewording a marker line, or
 * removing others, is not an append. A column over the cap counts as zero on
 * both sides.
 */
export function appendsHistory(
	columns: ReadonlyArray<{ from: string | null; to: string | null }>,
): boolean {
	let before = 0;
	let after = 0;
	for (const c of columns) {
		if ((c.from ?? "") === (c.to ?? "")) continue;
		before += markerLines(c.from).length;
		after += markerLines(c.to).length;
	}
	return after > before;
}

/** A scored row as the summary reads it. */
export interface TrueNowRow {
	id: string;
	broken: readonly TrueNowRule[];
	oversize: boolean;
	missingGoal?: boolean;
	missingDoneWhen?: boolean;
}
export interface TrueNowSummary {
	subject: TrueNowSubject;
	evaluated: number;
	passing: number;
	/** Rows holding each marker code. */
	ruleCounts: Array<{ rule: TrueNowRule; rows: number }>;
	oversize: number;
	/** Work items only; evidence, never part of the value. */
	missingGoal: number;
	missingDoneWhen: number;
	/** Up to 10 worst rows: most codes held, then id. */
	worst: Array<{ id: string; codes: string[] }>;
	/** 100 x passing / evaluated; null when nothing was evaluated. */
	percent: number | null;
}

/** Fold scored rows into the KPI value and its evidence. Input order never matters. */
export function summarizeTrueNow(
	subject: TrueNowSubject,
	rows: ReadonlyArray<TrueNowRow>,
): TrueNowSummary {
	const ruleCounts = TRUE_NOW_RULES.map((rule) => ({ rule, rows: 0 }));
	let passing = 0;
	let oversize = 0;
	let missingGoal = 0;
	let missingDoneWhen = 0;
	const failing: Array<{ id: string; codes: string[] }> = [];
	for (const row of rows) {
		for (const entry of ruleCounts)
			if (row.broken.includes(entry.rule)) entry.rows++;
		if (row.oversize) oversize++;
		if (row.missingGoal) missingGoal++;
		if (row.missingDoneWhen) missingDoneWhen++;
		const codes: string[] = TRUE_NOW_RULES.filter((r) => row.broken.includes(r));
		if (row.oversize) codes.push("oversize");
		if (codes.length === 0) passing++;
		else failing.push({ id: row.id, codes });
	}
	failing.sort(
		(a, b) =>
			b.codes.length - a.codes.length ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	return {
		subject,
		evaluated: rows.length,
		passing,
		ruleCounts,
		oversize,
		missingGoal,
		missingDoneWhen,
		worst: failing.slice(0, 10),
		percent: rows.length === 0 ? null : (100 * passing) / rows.length,
	};
}

/** An id is a label here; keep the line format stable for any stored value. */
export function evidenceLabel(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

/** Evidence strings of one summary. They carry ids and counts, never row text. */
export function trueNowEvidenceRefs(summary: TrueNowSummary): string[] {
	return [
		`rules:${TRUE_NOW_RULES_VERSION}`,
		`counts:evaluated=${summary.evaluated};passing=${summary.passing}`,
		...summary.ruleCounts.map((r) => `rule:${r.rule}=${r.rows}`),
		`rule:oversize=${summary.oversize}`,
		...(summary.subject === "work-items"
			? [
					`missing_goal=${summary.missingGoal};missing_done_when=${summary.missingDoneWhen}`,
				]
			: []),
		...summary.worst.map(
			(w) => `worst:${evidenceLabel(w.id)}:${w.codes.join("+")}`,
		),
	];
}
