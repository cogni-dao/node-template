// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `brief-rules@1`: a pure, deterministic scorer for work-item and knowledge
 * briefs. It reads text only; no SQL, no clock, no NLP library. A change to any
 * rule, list or limit here is a version bump of the rule set and of the
 * `brief.conformance@1` calculator that applies it.
 *
 * The first three rules are human-gated: only a human-approved alignment writes
 * `Goal =` and `Done when =`, so a row that breaks only those still passes.
 */

export const BRIEF_RULES_VERSION = "brief-rules@1";
export type BriefSubject = "items" | "entries";

/** Rules a human must satisfy; they never fail a row's agent-fixable pass. */
export const HUMAN_GATED_RULES = [
	"no_goal",
	"no_done_when",
	"approved_line_long",
] as const;
/** Rules an agent can fix by editing the text. A row passes when it breaks none. */
export const AGENT_FIXABLE_RULES = [
	"log_block",
	"use_when",
	"long_sentences",
	"unbounded_text",
] as const;
export type HumanGatedRule = (typeof HUMAN_GATED_RULES)[number];
export type AgentFixableRule = (typeof AGENT_FIXABLE_RULES)[number];
export type BriefRule = HumanGatedRule | AgentFixableRule;

/** Rules that apply to each subject, in reporting order. */
export const RULES_BY_SUBJECT: Readonly<Record<BriefSubject, readonly BriefRule[]>> =
	{
		items: [
			"no_goal",
			"no_done_when",
			"approved_line_long",
			"log_block",
			"long_sentences",
			"unbounded_text",
		],
		entries: ["log_block", "use_when", "long_sentences", "unbounded_text"],
	};

export const MAX_FIELD_CHARS = 100_000;
export const MAX_USE_WHEN_CHARS = 320;
export const MAX_GOAL_WORDS = 12;
export const MAX_DONE_WHEN_WORDS = 25;
export const DEFAULT_SENTENCE_WORDS = 25;
export const VERB_SENTENCE_WORDS = 20;
/** Sentences that open with one of these verbs get the shorter limit. */
export const VERB_STARTERS: ReadonlySet<string> = new Set(
	`use read write keep run add make check put link persist reconcile never do
avoid choose pick prefer create file claim ship watch verify prove record
state name call set show list find open close move replace remove refine
cite follow start stop wait send get post patch merge flight validate`.split(
		/\s+/,
	),
);

/** Scored text of one row. Absent fields are null or undefined. */
export interface BriefFields {
	title?: string | null | undefined;
	/** Items only. */
	summary?: string | null | undefined;
	/** Items only. */
	outcome?: string | null | undefined;
	/** Entries only. */
	use_when?: string | null | undefined;
	/** Entries only. */
	content?: string | null | undefined;
	/** A source flagged a field over the cap and sent it absent. */
	oversize?: boolean | undefined;
}
export interface BriefScore {
	/** Every rule the row breaks, in reporting order. */
	broken: BriefRule[];
	sentences: number;
	longSentences: number;
}

const FIELDS_BY_SUBJECT = {
	items: ["title", "summary", "outcome"],
	entries: ["title", "use_when", "content"],
} as const;

const LINE_BREAKS = /\r\n?/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_START = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+|(?=\[[ xX]\]\s))/;
const CHECKBOX = /^\[[ xX]\]\s+/;
const HEADING = /^ {0,3}#{1,6}\s+/;
const TABLE_ROW = /^ {0,3}\|/;
const TABLE_SEPARATOR = /^[\s|:-]+$/;
const APPROVED_LINE = /^(Goal|Done when) = (?=\S)/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const MONTH_DAY =
	/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? \d{1,2}(?!\d)/i;
const LOG_LABEL =
	/^(?:Update|Progress|Changelog|Review verdict|Review transcript|Pivot|Superseded)(?:s|d)?(?![A-Za-z])/i;
/** `e.g.`, `i.e.`, `etc.`, `vs.` and `cf.` never end a sentence. */
const ABBREVIATION = /(?:^|[\s("'\[])(?:e\.g|i\.e|etc|vs|cf)\.$/i;

/** One line of a field, with whether a fence covers it. */
export interface Line {
	text: string;
	fenced: boolean;
}

/** Split a field into lines and mark the ones a closed code fence covers. */
export function toLines(text: string): Line[] {
	const raw = text.replace(LINE_BREAKS, "\n").split("\n");
	const lines: Line[] = raw.map((t) => ({ text: t, fenced: false }));
	for (let i = 0; i < raw.length; i++) {
		const open = FENCE_OPEN.exec(raw[i] ?? "");
		if (!open) continue;
		const marks = open[1] ?? "";
		const info = open[2] ?? "";
		// A backtick fence never carries a backtick in its info string.
		if (marks[0] === "`" && info.includes("`")) continue;
		const closer = new RegExp(`^ {0,3}\\${marks[0]}{${marks.length},}\\s*$`);
		let close = -1;
		for (let j = i + 1; j < raw.length; j++)
			if (closer.test(raw[j] ?? "")) {
				close = j;
				break;
			}
		// An unclosed fence is not a fence; its opening line stays prose.
		if (close < 0) continue;
		for (let k = i; k <= close; k++) (lines[k] as Line).fenced = true;
		i = close;
	}
	return lines;
}

/** Strip the structure marks of one unit, leaving words. */
function clean(text: string): string {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`+/g, "")
		.replace(/\*+/g, "")
		// Paired `__emphasis__` at word boundaries only; `__init__` stays whole.
		.replace(/(?<!\w)__(?=\S)([^_]*\s[^_]*?)(?<=\S)__(?!\w)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** Table cells split on an unescaped pipe; the empty edge cells are dropped. */
function tableCells(line: string): string[] {
	return line
		.trim()
		.split(/(?<!\\)\|/)
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/**
 * The scoring units of one field: paragraphs, list items, headings and table
 * cells, with fenced lines and (when asked) approved `Goal =` lines left out.
 */
function unitsOf(text: string, skipApproved: boolean): string[] {
	const units: string[] = [];
	let block: string[] = [];
	const flush = () => {
		if (block.length) units.push(block.join(" "));
		block = [];
	};
	for (const line of toLines(text)) {
		const t = line.text;
		if (line.fenced || t.trim() === "") {
			flush();
			continue;
		}
		if (skipApproved && APPROVED_LINE.test(t)) {
			flush();
			continue;
		}
		if (HEADING.test(t)) {
			flush();
			units.push(t.replace(HEADING, "").replace(/\s+#+\s*$/, ""));
			continue;
		}
		if (TABLE_ROW.test(t)) {
			flush();
			if (!TABLE_SEPARATOR.test(t)) units.push(...tableCells(t));
			continue;
		}
		if (LIST_START.test(t)) {
			flush();
			block.push(t.replace(LIST_START, "").replace(CHECKBOX, ""));
			continue;
		}
		// Continuation of the open list item, or a line of the open paragraph.
		block.push(t.trim());
	}
	flush();
	return units;
}

/** Split one unit after `.`, `!` or `?` that a space and an opener follow. */
function sentencesOf(unit: string): string[] {
	const text = clean(unit);
	const out: string[] = [];
	let start = 0;
	const boundary = /(?<=[.!?])\s+(?=[\p{Lu}\d"'“‘(\[{])/gu;
	for (const m of text.matchAll(boundary)) {
		const head = text.slice(start, m.index);
		const before = text.slice(0, m.index);
		// An ellipsis is not a terminator; known abbreviations never end one.
		if (before.endsWith("..") || ABBREVIATION.test(before)) continue;
		if (head.trim()) out.push(head.trim());
		start = (m.index ?? 0) + m[0].length;
	}
	const tail = text.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

function wordCount(text: string): number {
	const t = text.trim();
	return t === "" ? 0 : t.split(/\s+/).length;
}

/** Word limit of one sentence: 20 when it opens with a listed verb, else 25. */
export function sentenceLimit(sentence: string): number {
	const first = (sentence.trim().split(/\s+/)[0] ?? "")
		.toLowerCase()
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
	return VERB_STARTERS.has(first) ? VERB_SENTENCE_WORDS : DEFAULT_SENTENCE_WORDS;
}

/** Every sentence of a field, counted in words, with fenced text left out. */
export function fieldSentences(
	text: string,
	options: { skipApproved?: boolean } = {},
): Array<{ text: string; words: number; limit: number }> {
	return unitsOf(text, options.skipApproved ?? false)
		.flatMap(sentencesOf)
		.map((s) => ({ text: s, words: wordCount(s), limit: sentenceLimit(s) }))
		.filter((s) => s.words > 0);
}

function hasLogLine(text: string): boolean {
	for (const line of toLines(text)) {
		if (line.fenced) continue;
		// Heading marks, blockquote marks, a list marker, a checkbox, a bold mark or
		// a bracket may come first, in any nesting.
		let body = line.text.trimStart();
		for (let pass = 0; pass < 6; pass++) {
			const next = body
				.replace(/^(?:>\s?|#{1,6}\s+)/, "")
				.replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "")
				.replace(CHECKBOX, "")
				.trimStart();
			if (next === body) break;
			body = next;
		}
		body = body.replace(/^(?:\*\*|__|\*|_)?[[(]?/, "");
		if (/^\d{4}-\d{2}-\d{2}/.test(body)) return true;
		if (MONTH_DAY.test(body)) return true;
		const label = LOG_LABEL.exec(body);
		if (label) {
			const near = body.slice(label[0].length, label[0].length + 40);
			if (/[:(]/.test(near) || ISO_DATE.test(near)) return true;
		}
	}
	return false;
}

/** Approved lines of an outcome: first text after each `Goal = ` and `Done when = `. */
function approvedTexts(outcome: string): { goal: string[]; done: string[] } {
	const goal: string[] = [];
	const done: string[] = [];
	for (const line of toLines(outcome)) {
		if (line.fenced) continue;
		const m = APPROVED_LINE.exec(line.text);
		if (!m) continue;
		(m[1] === "Goal" ? goal : done).push(line.text.slice(m[0].length));
	}
	return { goal, done };
}

/**
 * Score one row. `maxLongShare` is the largest share of pooled sentences that
 * may exceed their word limit (0 to 0.5).
 */
export function scoreBrief(
	subject: BriefSubject,
	fields: BriefFields,
	maxLongShare: number,
): BriefScore {
	const names = FIELDS_BY_SUBJECT[subject];
	const text = (name: string): string =>
		(fields as Record<string, string | null | undefined>)[name] ?? "";
	const broken = new Set<BriefRule>();

	if (subject === "items") {
		const approved = approvedTexts(text("outcome"));
		if (approved.goal.length === 0) broken.add("no_goal");
		if (approved.done.length === 0) broken.add("no_done_when");
		if (
			approved.goal.some((t) => wordCount(t) > MAX_GOAL_WORDS) ||
			approved.done.some((t) => wordCount(t) > MAX_DONE_WHEN_WORDS)
		)
			broken.add("approved_line_long");
	} else {
		const useWhen = text("use_when").trim();
		// An oversize use_when arrives absent, so it reads empty and breaks the rule.
		if (useWhen === "" || useWhen.length > MAX_USE_WHEN_CHARS)
			broken.add("use_when");
	}

	let sentences = 0;
	let longSentences = 0;
	for (const name of names) {
		const value = text(name);
		if (hasLogLine(value)) broken.add("log_block");
		if (value.length > MAX_FIELD_CHARS) broken.add("unbounded_text");
		for (const s of fieldSentences(value, {
			skipApproved: subject === "items" && name === "outcome",
		})) {
			sentences++;
			if (s.words > s.limit) longSentences++;
		}
	}
	if (fields.oversize) broken.add("unbounded_text");
	if (sentences > 0 && longSentences / sentences > maxLongShare)
		broken.add("long_sentences");

	return {
		broken: RULES_BY_SUBJECT[subject].filter((r) => broken.has(r)),
		sentences,
		longSentences,
	};
}

export function isAgentFixable(rule: BriefRule): rule is AgentFixableRule {
	return (AGENT_FIXABLE_RULES as readonly string[]).includes(rule);
}

export interface BriefSummary {
	evaluated: number;
	passing: number;
	/** Rows that break at least one human-gated rule; they stay in the value. */
	humanGatedFailing: number;
	/** Rows breaking each rule that applies to the subject. */
	ruleCounts: Array<{ rule: BriefRule; rows: number }>;
	/** Up to 10 worst rows: most agent-fixable rules broken, then id. */
	worst: Array<{ id: string; rules: AgentFixableRule[] }>;
	/** 100 x passing / evaluated; null when nothing was evaluated. */
	percent: number | null;
}

/** Fold scored rows into the KPI value and its evidence. Input order never matters. */
export function summarizeBriefs(
	subject: BriefSubject,
	rows: ReadonlyArray<{ id: string; broken: readonly BriefRule[] }>,
): BriefSummary {
	const ruleCounts = RULES_BY_SUBJECT[subject].map((rule) => ({
		rule,
		rows: 0,
	}));
	let passing = 0;
	let humanGatedFailing = 0;
	const failing: Array<{ id: string; rules: AgentFixableRule[] }> = [];
	for (const row of rows) {
		for (const entry of ruleCounts)
			if (row.broken.includes(entry.rule)) entry.rows++;
		if (row.broken.some((r) => !isAgentFixable(r))) humanGatedFailing++;
		// Reporting order, whatever order the caller listed the rules in.
		const fixable = AGENT_FIXABLE_RULES.filter((r) => row.broken.includes(r));
		if (fixable.length === 0) passing++;
		else failing.push({ id: row.id, rules: fixable });
	}
	failing.sort(
		(a, b) =>
			b.rules.length - a.rules.length ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	return {
		evaluated: rows.length,
		passing,
		humanGatedFailing,
		ruleCounts,
		worst: failing.slice(0, 10),
		percent: rows.length === 0 ? null : (100 * passing) / rows.length,
	};
}

/** Evidence strings of one summary. They carry ids and counts, never row text. */
export function briefEvidenceRefs(summary: BriefSummary): string[] {
	// An id is a label here; keep the line format stable for any stored value.
	const label = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	return [
		`counts:evaluated=${summary.evaluated};passing=${summary.passing}`,
		...summary.ruleCounts.map((r) => `rule:${r.rule}=${r.rows}`),
		`human_gated_failing=${summary.humanGatedFailing}`,
		...summary.worst.map((w) => `worst:${label(w.id)}:${w.rules.join("+")}`),
	];
}
