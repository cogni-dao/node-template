// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node-agnostic goal-metric source readers over an injected node SQL client.
 * Static SQL and a fixed provider origin; no user URLs or SQL. Callers own the
 * client, its credentials and its lifecycle.
 */
import type { Sql } from "postgres";
import {
	type BriefSubject,
	briefEvidenceRefs,
	scoreBrief,
	summarizeBriefs,
} from "./briefs.js";
import type {
	EditsStage,
	EditsTimingUpdate,
	MetricBudget,
	MetricSample,
} from "./contracts.js";
import {
	appendsHistory,
	approvedLines,
	NO_INLINE_HISTORY_MAX_FIELD_CHARS,
	NO_INLINE_HISTORY_RULES_VERSION,
	type NoInlineHistorySubject,
	noInlineHistoryEvidenceRefs,
	scoreNoInlineHistory,
	summarizeNoInlineHistory,
} from "./no-inline-history.js";

export async function readWorkCount(
	sql: Sql,
	mode: "open" | "validated",
	signal: AbortSignal,
): Promise<MetricSample> {
	signal.throwIfAborted();
	const where =
		mode === "open"
			? "status NOT IN ('done','cancelled')"
			: "status = 'done' AND deploy_verified = true";
	const query = sql.unsafe(
		`SELECT NOW() AS as_of, (SELECT COUNT(*) FROM work_items WHERE ${where} AND (labels IS NULL OR (CAST(labels AS TEXT) NOT LIKE '%"test-fixture"%' AND CAST(labels AS TEXT) NOT LIKE '%"synthetic"%' AND CAST(labels AS TEXT) NOT LIKE '%"synthetic-fixture"%'))) AS value`,
	);
	const abort = () => {
		void query.cancel();
	};
	signal.addEventListener("abort", abort, { once: true });
	let rows: Awaited<typeof query>;
	try {
		rows = await query;
	} finally {
		signal.removeEventListener("abort", abort);
	}
	signal.throwIfAborted();
	return {
		value: Number(rows[0]?.value),
		unit: "items",
		complete: rows.length === 1,
		sourceWatermarks: [
			{
				source: "node.work_items",
				asOf: rows[0]?.as_of
					? new Date(rows[0].as_of as string).toISOString()
					: null,
			},
		],
		evidenceRefs: [`node:work_items:count:${mode}:excludes-synthetic`],
	};
}

/** Response bytes are bounded during streaming, not after allocating the body. */
export async function readGithubStars(
	owner: string,
	repo: string,
	signal: AbortSignal,
	budget: Readonly<MetricBudget>,
): Promise<MetricSample> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
		{
			signal,
			redirect: "error",
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Cogni-node-metrics",
			},
			cache: "no-store",
		},
	);
	if (!response.ok || !response.body) throw new Error("provider_unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > budget.maxResponseBytes)
				throw new Error("provider_response_budget");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const body = JSON.parse(new TextDecoder().decode(bytes));
	// Provider HTTP Date is the response snapshot watermark, not repository.updated_at.
	const sourceDate = response.headers.get("date");
	return {
		value: body.stargazers_count,
		unit: "stars",
		complete: typeof body.stargazers_count === "number",
		sourceWatermarks: [
			{
				source: "github.public",
				asOf: sourceDate ? new Date(sourceDate).toISOString() : null,
			},
		],
		evidenceRefs: [`https://github.com/${owner}/${repo}`],
	};
}

const SYNTHETIC_LABELS = (column: string) =>
	`(${column} IS NULL OR (CAST(${column} AS TEXT) NOT LIKE '%"test-fixture"%' AND CAST(${column} AS TEXT) NOT LIKE '%"synthetic"%' AND CAST(${column} AS TEXT) NOT LIKE '%"synthetic-fixture"%'))`;

async function run(
	sql: Sql,
	text: string,
	signal: AbortSignal,
): Promise<ReadonlyArray<Record<string, unknown>>> {
	signal.throwIfAborted();
	const query = sql.unsafe(text);
	const abort = () => {
		void query.cancel();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		return (await query) as ReadonlyArray<Record<string, unknown>>;
	} finally {
		signal.removeEventListener("abort", abort);
		signal.throwIfAborted();
	}
}

/** dolt_log.date is timestamp without time zone holding UTC wall time. */
function doltUtc(iso: string): string {
	return new Date(Date.parse(iso))
		.toISOString()
		.replace("T", " ")
		.replace("Z", "");
}
/** Dolt commit dates are UTC; accept zone-less, Z, +00, +0000, +00:00 and " UTC" forms. */
export function doltInstant(value: unknown): string | null {
	const text =
		value instanceof Date
			? value.toISOString()
			: typeof value === "string"
				? value.trim()
				: "";
	if (!text) return null;
	const iso = text
		.replace(" ", "T")
		.replace(/\s*UTC$/i, "Z")
		.replace(/\s+(?=[+-]\d{2})/, "")
		.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
		.replace(/([+-]\d{2})$/, "$1:00");
	const zoned = /(Z|[+-]\d{2}:\d{2})$/i.test(iso);
	const ms = Date.parse(zoned ? iso : `${iso}Z`);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
const COMMIT = /^[a-z0-9]{32}$/;

export type ConvergenceOutput = "ratio" | "validated" | "created";
type Read = <T>(source: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** Bounded first-parent walk; a window older than this many main commits is unbounded. */
export const FIRST_PARENT_WALK_CAP = 5000;

/** A recorded head stands in for main at T only when it was read in [T - this, T]. */
export const RECORDED_HEAD_MAX_GAP_SECONDS = 2 * 3600;

/** Evidence prefix for main's head as read by a convergence compute: `dolt:head:<hash>@<iso>`. */
export const MAIN_HEAD_EVIDENCE_PREFIX = "dolt:head:";

/**
 * Most recent main head recorded by an earlier stored convergence reading at a
 * time in [at - maxGapSeconds, at]; null when none. Nodes back it with their
 * observation store (`PostgresMetricObservations.recordedMainHead`).
 */
export type RecordedMainHeads = (
	at: string,
	maxGapSeconds: number,
	signal: AbortSignal,
) => Promise<{ hash: string; at: string } | null>;

type Edge = { hash: string; at: string | null; via: string };

/** Timeouts and budget exhaustion keep their own failure; every other read error is a miss. */
function rethrowBudget(error: unknown) {
	if (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.name === "MetricError" ||
			error.name === "TimeoutError")
	)
		throw error;
}

/**
 * Edge commit c(T) = what main pointed to at T. Each edge tries three sources
 * in order, and the first that covers T wins:
 * 1. main's reflog (dolt_reflog('main')): every move of the main ref with its
 *    own timestamp. Exact and immune to backdated branch commits, but it does
 *    not reach back past a server restart or GC.
 * 2. Recorded heads: every convergence reading stores main's head at its own
 *    compute time as `dolt:head:<hash>@<iso>` evidence. The most recent stored
 *    ok reading recorded in [T - RECORDED_HEAD_MAX_GAP_SECONDS, T] supplies
 *    c(T). Durable across restarts; absent when `heads` is not injected.
 * 3. The bounded first-parent walk from dolt_hashof('main'): the first commit
 *    on main's FIRST-PARENT chain with date <= T, at most FIRST_PARENT_WALK_CAP
 *    commits deep. dolt_log('main') is not used: it includes commits merged in
 *    from contribution branches with their authoring dates, so a stale branch
 *    commit could become an edge (task.0024 probe dolt-first-parent-probe.json).
 * When no source covers the start, the walk decides: insufficient_history when
 * it reached main's root (young history), history_unavailable walk_cap when it
 * hit the cap. Never a guess. Validated work is the net row diff
 * dolt_diff(c(start), c(end), 'work_items') whose to_ side is done +
 * deploy_verified and whose from_ side is not (added rows included).
 * dolt_diff_summary.data_change is not trusted (work-items adapter, bug.5358).
 */
export async function readWorkValidatedHistory(
	sql: Sql,
	window: { start: string; end: string },
	read: Read,
	heads?: RecordedMainHeads,
): Promise<
	| {
			ok: true;
			validated: number;
			from: string;
			to: string;
			toAt: string | null;
			/** "reflog", "recorded-head" or "first-parent:<depth>"; "<start>+<end>" when the edges differ. */
			via: string;
	  }
	| {
			ok: false;
			reason: "insufficient_history" | "history_unavailable";
			/** Which history step failed; safe to publish (no data, no DSN). */
			step: string;
	  }
> {
	try {
		const recorded = async (iso: string): Promise<Edge | null> => {
			if (!heads) return null;
			try {
				const head = await read((signal) =>
					heads(iso, RECORDED_HEAD_MAX_GAP_SECONDS, signal),
				);
				// Re-check the gap here so an injected store cannot widen it.
				const t = Date.parse(head?.at ?? "");
				const x = Date.parse(iso);
				return head &&
					COMMIT.test(head.hash) &&
					t <= x &&
					t >= x - RECORDED_HEAD_MAX_GAP_SECONDS * 1000
					? {
							hash: head.hash,
							at: new Date(t).toISOString(),
							via: "recorded-head",
						}
					: null;
			} catch (error) {
				rethrowBudget(error);
				return null;
			}
		};
		const edgeAt = async (iso: string) =>
			(await mainFromReflog(sql, iso, read)) ?? (await recorded(iso));
		// The walk also covers the end, so an uncovered start skips the end lookups.
		const from = await edgeAt(window.start);
		const to = from ? await edgeAt(window.end) : null;
		if (from && to) return await diffValidated(sql, edges(from, to), read);
		// Walk back only as far as the earliest edge still missing.
		const target = from ? window.end : window.start;
		const walk = await read((signal) =>
			run(
				sql,
				`WITH RECURSIVE chain(commit_hash, depth, date) AS (
				SELECT c.commit_hash, 0, c.date FROM dolt.commits c WHERE c.commit_hash = dolt_hashof('main')
				UNION ALL
				SELECT p.commit_hash, chain.depth + 1, p.date FROM chain
				JOIN dolt.commit_ancestors a ON a.commit_hash = chain.commit_hash AND a.parent_index = 0
				JOIN dolt.commits p ON p.commit_hash = a.parent_hash
				WHERE chain.depth < ${FIRST_PARENT_WALK_CAP} AND chain.date > '${doltUtc(target)}'
			) SELECT commit_hash, depth, CAST(date AS TEXT) AS date FROM chain ORDER BY depth`,
				signal,
			),
		);
		const chain = walk.map((r) => ({
			hash: String(r.commit_hash ?? ""),
			at: Date.parse(doltInstant(r.date) ?? ""),
		}));
		if (!chain.length)
			return { ok: false, reason: "history_unavailable", step: "walk_empty" };
		if (chain.some((c) => !Number.isFinite(c.at)))
			return {
				ok: false,
				reason: "history_unavailable",
				step: "walk_bad_date",
			};
		const walked = (iso: string): Edge | null => {
			const c = chain.find((c) => c.at <= Date.parse(iso));
			return c
				? {
						hash: c.hash,
						at: new Date(c.at).toISOString(),
						via: `first-parent:${chain.length - 1}`,
					}
				: null;
		};
		const fromEdge = from ?? walked(window.start);
		const toEdge = walked(window.end);
		if (!fromEdge) {
			// The walk stopped at the cap: unbounded, not young.
			if (chain.length > FIRST_PARENT_WALK_CAP)
				return { ok: false, reason: "history_unavailable", step: "walk_cap" };
			// Reached the root first: main history starts inside the window.
			return {
				ok: false,
				reason: "insufficient_history",
				step: `root_at_depth_${chain.length - 1}`,
			};
		}
		if (!toEdge)
			return { ok: false, reason: "insufficient_history", step: "no_end_edge" };
		return await diffValidated(sql, edges(fromEdge, toEdge), read);
	} catch (error) {
		// Timeouts and budget exhaustion keep their own failure; other history
		// read failures are an unknown sample, never zero.
		rethrowBudget(error);
		// Publish only the SQLSTATE / error class, never the message (may echo SQL).
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code: unknown }).code).replace(
						/[^A-Za-z0-9_]/g,
						"",
					)
				: "";
		const name =
			error instanceof Error
				? error.name.replace(/[^A-Za-z0-9_]/g, "")
				: "unknown";
		return {
			ok: false,
			reason: "history_unavailable",
			step: `query_failed:${code || name}`.slice(0, 64),
		};
	}
}

type Edges = { from: string; to: string; toAt: string | null; via: string };

function edges(from: Edge, to: Edge): Edges {
	return {
		from: from.hash,
		to: to.hash,
		toAt: to.at,
		via: from.via === to.via ? from.via : `${from.via}+${to.via}`,
	};
}

/** main at T from the reflog; null when the reflog is unsupported or does not reach back to T. */
async function mainFromReflog(
	sql: Sql,
	iso: string,
	read: Read,
): Promise<Edge | null> {
	try {
		const rows = await read((signal) =>
			run(
				sql,
				`SELECT commit_hash, CAST(ref_timestamp AS TEXT) AS at FROM dolt_reflog('main') WHERE ref_timestamp <= '${doltUtc(iso)}' ORDER BY ref_timestamp DESC LIMIT 1`,
				signal,
			),
		);
		const row = rows[0];
		const hash = String(row?.commit_hash ?? "");
		return COMMIT.test(hash)
			? { hash, at: doltInstant(row?.at), via: "reflog" }
			: null;
	} catch (error) {
		rethrowBudget(error);
		return null;
	}
}

/** main's head now, with the server's own clock; null when unreadable. */
async function readMainHead(
	sql: Sql,
	read: Read,
): Promise<{ hash: string; at: string } | null> {
	try {
		const rows = await read((signal) =>
			run(
				sql,
				`SELECT dolt_hashof('main') AS head, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS head_at`,
				signal,
			),
		);
		const hash = String(rows[0]?.head ?? "");
		const ms = Date.parse(String(rows[0]?.head_at ?? ""));
		return COMMIT.test(hash) && Number.isFinite(ms)
			? { hash, at: new Date(ms).toISOString() }
			: null;
	} catch (error) {
		rethrowBudget(error);
		return null;
	}
}

/** Net work items that became done + deploy_verified between two main commits. */
async function diffValidated(
	sql: Sql,
	edges: Edges,
	read: Read,
): Promise<
	| {
			ok: true;
			validated: number;
			from: string;
			to: string;
			toAt: string | null;
			via: string;
	  }
	| { ok: false; reason: "history_unavailable"; step: string }
> {
	if (!COMMIT.test(edges.from) || !COMMIT.test(edges.to))
		return {
			ok: false,
			reason: "history_unavailable",
			step: "bad_commit_hash",
		};
	const validated =
		edges.from === edges.to
			? 0
			: Number(
					(
						await read((signal) =>
							run(
								sql,
								`SELECT COUNT(*) AS validated FROM dolt_diff('${edges.from}', '${edges.to}', 'work_items') WHERE to_status = 'done' AND to_deploy_verified = true AND (from_id IS NULL OR from_status IS DISTINCT FROM 'done' OR from_deploy_verified IS DISTINCT FROM true) AND ${SYNTHETIC_LABELS("to_labels")}`,
								signal,
							),
						)
					)[0]?.validated,
				);
	if (!Number.isInteger(validated) || validated < 0)
		return { ok: false, reason: "history_unavailable", step: "bad_diff_count" };
	return { ok: true, validated, ...edges };
}

/**
 * Seven-day convergence: validated units / created units in [start, end).
 * Every output, created included, records main's head at compute time as
 * `dolt:head:<hash>@<iso>` so later readings can take window edges from it.
 */
export async function readWorkConvergence(
	sql: Sql,
	output: ConvergenceOutput,
	window: { start: string; end: string },
	read: Read,
	heads?: RecordedMainHeads,
): Promise<MetricSample> {
	const start = new Date(Date.parse(window.start)).toISOString();
	const end = new Date(Date.parse(window.end)).toISOString();
	const counts = await read((signal) =>
		run(
			sql,
			`SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
			(SELECT COUNT(*) FROM work_items WHERE created_at >= '${start}' AND created_at < '${end}' AND ${SYNTHETIC_LABELS("labels")}) AS created_work,
			(SELECT COUNT(*) FROM knowledge_contributions WHERE created_at >= '${start}' AND created_at < '${end}') AS created_contributions,
			(SELECT COUNT(*) FROM knowledge_contributions WHERE state = 'merged' AND resolved_at >= '${start}' AND resolved_at < '${end}') AS merged_contributions`,
			signal,
		),
	);
	const row = counts[0] ?? {};
	const asOfMs = Date.parse(String(row.as_of ?? ""));
	const asOf = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null;
	const createdWork = Number(row.created_work);
	const createdContributions = Number(row.created_contributions);
	const mergedContributions = Number(row.merged_contributions);
	const unit = output === "ratio" ? "ratio" : "items";
	const evidenceRefs = [
		`window:[${start},${end})`,
		"node:work_items:created_at:excludes-synthetic",
		"contributions:fixture-exclusion:none",
	];
	const sample = (
		value: number,
		complete: boolean,
		reason?: MetricSample["reason"],
	): MetricSample => ({
		value,
		unit,
		complete:
			complete &&
			counts.length === 1 &&
			[createdWork, createdContributions, mergedContributions].every(
				(n) => Number.isInteger(n) && n >= 0,
			),
		sourceWatermarks: [{ source: "node.doltgres.main", asOf }],
		evidenceRefs,
		...(reason ? { reason } : {}),
	});
	const created = createdWork + createdContributions;
	evidenceRefs.push(
		`counts:created_work=${createdWork};created_contributions=${createdContributions};merged_contributions=${mergedContributions}`,
	);
	const head = await readMainHead(sql, read);
	if (head)
		evidenceRefs.push(`${MAIN_HEAD_EVIDENCE_PREFIX}${head.hash}@${head.at}`);
	if (output === "created") return sample(created, true);
	const history = await readWorkValidatedHistory(
		sql,
		{ start, end },
		read,
		heads,
	);
	if (!history.ok) {
		evidenceRefs.push(`dolt:history:${history.step}`);
		return sample(0, false, history.reason);
	}
	evidenceRefs.push(
		`dolt:main:${history.from}..${history.to}${history.toAt ? `@${history.toAt}` : ""}`,
		"node:work_items:validated:dolt_diff:done+deploy_verified",
		`dolt:edge:${history.via};walk-cap=${FIRST_PARENT_WALK_CAP}`,
		`counts:validated_work=${history.validated}`,
	);
	const validated = history.validated + mergedContributions;
	if (output === "validated") return sample(validated, true);
	if (created === 0) return sample(0, false, "zero_denominator");
	return sample(validated / created, true);
}

/** Most rows one brief-conformance compute scores. */
export const BRIEF_MAX_ROWS = 5000;
/** Most bytes of scored text one brief-conformance compute reads (16 MiB). */
export const BRIEF_MAX_BYTES = 16_777_216;
/** A scored field longer than this many characters is sent absent and flagged. */
const BRIEF_FIELD_CHARS = 100_000;

/**
 * One statement per subject. It counts the scope's rows (`n`) and the bytes of
 * its capped scored fields, and joins the rows in only while `n` and the bytes
 * are inside the caps; otherwise it returns the totals row alone, so the
 * database never sends a result over a cap. A field over the character cap is
 * sent as NULL and flagged `oversize`.
 */
export function briefConformanceSql(subject: BriefSubject): string {
	const capped = (column: string) =>
		`CASE WHEN char_length(${column}) > ${BRIEF_FIELD_CHARS} THEN NULL ELSE ${column} END AS ${column}`;
	const over = (column: string) =>
		`COALESCE(char_length(${column}), 0) > ${BRIEF_FIELD_CHARS}`;
	const fields =
		subject === "items"
			? ["title", "summary", "outcome"]
			: ["title", "use_when", "content"];
	const from =
		subject === "items"
			? `work_items WHERE status NOT IN ('done','cancelled') AND ${SYNTHETIC_LABELS("labels")}`
			: `knowledge WHERE status <> 'deprecated' AND entry_type <> 'html' AND (tags IS NULL OR CAST(tags AS TEXT) NOT LIKE '%"test-fixture"%') AND title NOT LIKE '%[TEST]%'`;
	// Doltgres 0.57.3 panics on octet_length over a stored long text unless the
	// text is first materialized by substr, and compares a bare SUM as text, so
	// the total is cast to BIGINT. The character cap makes the substr safe.
	const size = (column: string) =>
		`COALESCE(CASE WHEN char_length(${column}) > ${BRIEF_FIELD_CHARS} THEN 0 ELSE octet_length(substr(${column}, 1, ${BRIEF_FIELD_CHARS})) END, 0) AS ${column}_bytes`;
	const bytes = fields.map((f) => `${f}_bytes`).join(" + ");
	return `WITH scope AS (SELECT id, ${fields.map(capped).join(", ")}, ${fields.map(size).join(", ")}, (${fields.map(over).join(" OR ")}) AS oversize FROM ${from}), totals AS (SELECT COUNT(*) AS n, CAST(COALESCE(SUM(${bytes}), 0) AS BIGINT) AS bytes FROM scope) SELECT NOW() AS as_of, t.n, t.bytes, s.id, ${fields.map((f) => `s.${f}`).join(", ")}, s.oversize FROM totals t LEFT JOIN scope s ON t.n <= ${BRIEF_MAX_ROWS} AND t.bytes <= ${BRIEF_MAX_BYTES} ORDER BY s.id`;
}

/**
 * Brief conformance of one subject: the percent of open work items or live
 * hub entries that pass every agent-fixable `brief-rules@1` rule. One
 * statement, one source call. A cap hit, an empty scope and a failed read are
 * unknown, never zero.
 */
export async function readBriefConformance(
	sql: Sql,
	subject: BriefSubject,
	maxLongShare: number,
	signal: AbortSignal,
): Promise<MetricSample> {
	const source = subject === "items" ? "node.work_items" : "node.knowledge";
	const unknown = (
		reason: NonNullable<MetricSample["reason"]>,
		asOf: string | null,
		evidenceRefs: string[] = [],
	): MetricSample => ({
		value: 0,
		unit: "%",
		complete: false,
		sourceWatermarks: [{ source, asOf }],
		evidenceRefs,
		reason,
	});
	let rows: ReadonlyArray<Record<string, unknown>>;
	try {
		rows = await run(sql, briefConformanceSql(subject), signal);
	} catch (error) {
		// A timeout keeps its own failure; every other read error is source_failed.
		if (signal.aborted) throw error;
		return unknown("source_failed", null);
	}
	const first = rows[0];
	if (!first) return unknown("incomplete_or_invalid_source", null);
	const asOf = first.as_of
		? new Date(first.as_of as string).toISOString()
		: null;
	const n = Number(first.n);
	const bytes = Number(first.bytes);
	if (!Number.isFinite(n) || !Number.isFinite(bytes))
		return unknown("incomplete_or_invalid_source", asOf);
	if (n === 0) return unknown("zero_denominator", asOf, ["counts:evaluated=0"]);
	// Over a cap the statement sends the totals row alone.
	if (
		n > BRIEF_MAX_ROWS ||
		bytes > BRIEF_MAX_BYTES ||
		rows.length !== n ||
		rows.some((r) => r.id == null)
	)
		return unknown("incomplete_or_invalid_source", asOf, [
			`counts:evaluated=${n};bytes=${bytes};cap_hit`,
		]);
	const text = (value: unknown) => (value == null ? null : String(value));
	const scored = rows.map((row) => ({
		id: String(row.id),
		broken: scoreBrief(
			subject,
			{
				title: text(row.title),
				summary: text(row.summary),
				outcome: text(row.outcome),
				use_when: text(row.use_when),
				content: text(row.content),
				oversize: row.oversize === true || row.oversize === "t",
			},
			maxLongShare,
		).broken,
	}));
	const summary = summarizeBriefs(subject, scored);
	return {
		value: summary.percent ?? 0,
		unit: "%",
		complete: summary.percent !== null,
		sourceWatermarks: [{ source, asOf }],
		evidenceRefs: briefEvidenceRefs(summary),
	};
}

/** Most rows one no-inline-history statement reads. */
export const NO_INLINE_HISTORY_MAX_ROWS = 5000;
/** Most bytes of text one no-inline-history statement sends (16 MiB). */
export const NO_INLINE_HISTORY_MAX_BYTES = 16_777_216;
/** Most edits one no-inline-history edits compute classifies; more fails closed. */
export const NO_INLINE_HISTORY_MAX_EDITS = 2000;
/** Fewer edits than this in the window is `insufficient_history`, never a share. */
export const NO_INLINE_HISTORY_MIN_EDITS = 10;

const NO_INLINE_HISTORY_SOURCE = {
	"work-items": "node.work_items",
	atoms: "node.knowledge",
} as const;

/**
 * One statement per subject: the scope's rows with their scored text, joined
 * in only while the row and byte caps hold (the same statement the brief
 * calculator sends, so both read one scope).
 */
export function noInlineHistoryStateSql(
	subject: NoInlineHistorySubject,
): string {
	return briefConformanceSql(subject === "work-items" ? "items" : "entries");
}

/**
 * State of one subject: the percent of open work items or live atoms with no
 * `no-inline-history-rules@1` marker line. A cap hit, an empty scope and a failed read
 * are unknown, never zero.
 */
export async function readNoInlineHistoryState(
	sql: Sql,
	subject: NoInlineHistorySubject,
	signal: AbortSignal,
): Promise<MetricSample> {
	const source = NO_INLINE_HISTORY_SOURCE[subject];
	const unknown = (
		reason: NonNullable<MetricSample["reason"]>,
		asOf: string | null,
		evidenceRefs: string[] = [],
	): MetricSample => ({
		value: 0,
		unit: "%",
		complete: false,
		sourceWatermarks: [{ source, asOf }],
		evidenceRefs,
		reason,
	});
	let rows: ReadonlyArray<Record<string, unknown>>;
	try {
		rows = await run(sql, noInlineHistoryStateSql(subject), signal);
	} catch (error) {
		// A timeout keeps its own failure; every other read error is source_failed,
		// recorded by class only.
		if (signal.aborted) throw error;
		return unknown("source_failed", null, [errorClass(error)]);
	}
	const first = rows[0];
	if (!first) return unknown("incomplete_or_invalid_source", null);
	const asOf = first.as_of
		? new Date(first.as_of as string).toISOString()
		: null;
	const n = Number(first.n);
	const bytes = Number(first.bytes);
	if (!Number.isFinite(n) || !Number.isFinite(bytes))
		return unknown("incomplete_or_invalid_source", asOf);
	if (n === 0) return unknown("zero_denominator", asOf, ["counts:evaluated=0"]);
	// Over a cap the statement sends the totals row alone.
	if (
		n > NO_INLINE_HISTORY_MAX_ROWS ||
		bytes > NO_INLINE_HISTORY_MAX_BYTES ||
		rows.length !== n ||
		rows.some((r) => r.id == null)
	)
		return unknown("incomplete_or_invalid_source", asOf, [
			`counts:evaluated=${n};bytes=${bytes};cap_hit`,
		]);
	const text = (value: unknown) => (value == null ? null : String(value));
	const summary = summarizeNoInlineHistory(
		subject,
		rows.map((row) => {
			const score = scoreNoInlineHistory(subject, {
				title: text(row.title),
				summary: text(row.summary),
				outcome: text(row.outcome),
				use_when: text(row.use_when),
				content: text(row.content),
				oversize: row.oversize === true || row.oversize === "t",
			});
			const approved =
				subject === "work-items" ? approvedLines(text(row.outcome)) : null;
			return {
				id: String(row.id),
				broken: score.broken,
				oversize: score.oversize,
				...(approved
					? { missingGoal: !approved.goal, missingDoneWhen: !approved.doneWhen }
					: {}),
			};
		}),
	);
	return {
		value: summary.percent ?? 0,
		unit: "%",
		complete: summary.percent !== null,
		sourceWatermarks: [{ source, asOf }],
		evidenceRefs: noInlineHistoryEvidenceRefs(summary),
	};
}

/** Open work items in scope: the guardrail beside the work-item state KPI. */
export async function readNoInlineHistoryScope(
	sql: Sql,
	signal: AbortSignal,
): Promise<MetricSample> {
	const counted = await readWorkCount(sql, "open", signal);
	const valid = Number.isInteger(counted.value) && counted.value >= 0;
	return {
		...counted,
		complete: counted.complete && valid,
		evidenceRefs: [
			`rules:${NO_INLINE_HISTORY_RULES_VERSION}`,
			...counted.evidenceRefs,
			...(valid ? [`counts:evaluated=${counted.value}`] : []),
		],
	};
}

type EditTable = "work-items" | "atoms";
/** Text columns an edit may change, per table; a change to any other column is not an edit. */
const EDIT_COLUMNS = {
	"work-items": ["summary", "outcome"],
	atoms: ["content"],
} as const;

/**
 * The window's commits: the hashes in main's history (`dolt_log`) whose commit
 * date is in [start, end), oldest first. Dolt turns a filter on a diff table's
 * `to_commit` into an index lookup but never pushes a date filter down, so the
 * diff statement below takes these hashes as a literal list of `to_commit`
 * tests and its cost follows the window, not the whole history. Like the other statements it
 * counts rows (`n`) and joins the hashes in only while `n` is inside the row
 * cap; the inner LIMIT reads one row past it.
 */
export function noInlineHistoryWindowCommitsSql(window: {
	start: string;
	end: string;
}): string {
	return `WITH w AS (SELECT l.commit_hash FROM dolt_log l WHERE l.date >= '${doltUtc(window.start)}' AND l.date < '${doltUtc(window.end)}' ORDER BY l.date, l.commit_hash LIMIT ${NO_INLINE_HISTORY_MAX_ROWS + 1}), totals AS (SELECT COUNT(*) AS n FROM w) SELECT NOW() AS as_of, t.n, w.commit_hash FROM totals t LEFT JOIN w ON t.n <= ${NO_INLINE_HISTORY_MAX_ROWS} ORDER BY w.commit_hash`;
}

/**
 * One statement per table: the diff rows (`dolt_diff_<table>`, one per commit
 * and row id) whose commit is one of the window's `commits` and whose edit
 * column changed, ordered by row id then commit date, with the changed text and
 * the commit's reason message. The commits are a chain of `to_commit = '<hash>'`
 * tests joined by OR, which Doltgres 0.57.3 plans as index lookups on
 * `to_commit`; an `IN` list fails to plan there ("plan is not resolved") and a
 * cast list or a join scans every diff. A `to_id IS NOT NULL` test is left out
 * on purpose: `diff_type = 'modified'` already means both sides hold the row,
 * and with the test the planner scans the `to_id` index instead of looking the
 * commits up. A diff row carries its own `from_` and `to_` text, so no wider
 * history is read. A contribution's edit may have a diff row at its merge
 * commit only (Doltgres 0.57.3 can omit the row of the branch commit itself),
 * so merge commits stay in the list: an edit is dated by the commit whose diff
 * row carries it, a contribution merged inside the window counts at the merge
 * date even when authored earlier, and a merge repeating its branch commit's
 * row collapses with it in the caller. Scope and fixture exclusions
 * read the row as of that commit. The log joins are LEFT joins, so a missing
 * commit row never drops a diff row. The inner LIMIT reads one row past the row
 * cap; it counts rows (`n`) and the bytes of its capped text in the same pass
 * as the rows (window totals; a second reference to the CTE made Doltgres
 * 0.57.3 evaluate the whole diff twice, about 2x the cost) and sends the rows
 * only while both are inside the caps. Over a cap it sends the first row alone,
 * so the totals still arrive and the database never sends a result over a cap.
 * No diff row at all sends no row: `n` is then 0.
 */
export function noInlineHistoryEditsSql(
	table: EditTable,
	commits: readonly string[],
): string {
	if (commits.length === 0 || !commits.every((h) => COMMIT.test(h)))
		throw new TypeError("commits must be a non-empty list of commit hashes");
	const columns = EDIT_COLUMNS[table];
	const diff =
		table === "work-items" ? "dolt_diff_work_items" : "dolt_diff_knowledge";
	const text = columns.flatMap((c) => [`from_${c}`, `to_${c}`]);
	const capped = (c: string) =>
		`CASE WHEN char_length(d.${c}) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS} THEN NULL ELSE d.${c} END AS ${c}`;
	const over = (c: string) =>
		`COALESCE(char_length(d.${c}), 0) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS}`;
	// Doltgres 0.57.3 panics on octet_length over a stored long text unless the
	// text is first materialized by substr, and compares a bare SUM as text.
	const size = (c: string) =>
		`COALESCE(CASE WHEN char_length(d.${c}) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS} THEN 0 ELSE octet_length(substr(d.${c}, 1, ${NO_INLINE_HISTORY_MAX_FIELD_CHARS})) END, 0) AS ${c}_bytes`;
	const scope =
		table === "work-items"
			? SYNTHETIC_LABELS("d.to_labels")
			: `d.to_entry_type <> 'html' AND (d.to_tags IS NULL OR CAST(d.to_tags AS TEXT) NOT LIKE '%"test-fixture"%') AND d.to_title NOT LIKE '%[TEST]%'`;
	// Doltgres 0.57.3 panics (nil pointer) when a CTE filter compares a from_ and
	// a to_ text column, through IS DISTINCT FROM, <>, md5, lower or a cast. Only
	// COALESCE over substr materializes both sides safely (bug: edits KPI
	// source_failed on production, 2026-11-11). NULL and '' read as the same text;
	// the caller compares the full values again.
	const changed = columns
		.map(
			(c) =>
				`COALESCE(substr(d.from_${c}, 1, ${NO_INLINE_HISTORY_MAX_FIELD_CHARS}), '') <> COALESCE(substr(d.to_${c}, 1, ${NO_INLINE_HISTORY_MAX_FIELD_CHARS}), '')`,
		)
		.join(" OR ");
	const reason =
		table === "work-items"
			? "l.message AS reason_message"
			: "c.message AS reason_message";
	const join =
		table === "work-items"
			? "LEFT JOIN dolt_log l ON l.commit_hash = d.to_commit"
			: "LEFT JOIN dolt_log l ON l.commit_hash = d.to_commit LEFT JOIN knowledge_contribution_commits c ON c.commit_hash = d.to_commit";
	const bytes = text.map((c) => `${c}_bytes`).join(" + ");
	return `WITH diffs AS (SELECT d.to_id AS id, d.to_commit AS commit_hash, CAST(d.to_commit_date AS TEXT) AS at, d.diff_type, ${reason}, ${text.map(capped).join(", ")}, ${text.map(size).join(", ")}, (${text.map(over).join(" OR ")}) AS oversize FROM ${diff} d ${join} WHERE d.to_commit <> 'WORKING' AND d.diff_type = 'modified' AND (${commits.map((h) => `d.to_commit = '${h}'`).join(" OR ")}) AND (${changed}) AND ${scope} ORDER BY d.to_id, d.to_commit_date LIMIT ${NO_INLINE_HISTORY_MAX_ROWS + 1}), t AS (SELECT s.*, ROW_NUMBER() OVER (ORDER BY s.id, s.at, s.commit_hash) AS rn, COUNT(*) OVER () AS n, CAST(COALESCE(SUM(${bytes}) OVER (), 0) AS BIGINT) AS bytes FROM diffs s) SELECT NOW() AS as_of, t.n, t.bytes, t.id, t.commit_hash, t.at, t.diff_type, t.reason_message, ${text.map((c) => `t.${c}`).join(", ")}, t.oversize FROM t WHERE (t.n <= ${NO_INLINE_HISTORY_MAX_ROWS} AND t.bytes <= ${NO_INLINE_HISTORY_MAX_BYTES}) OR t.rn = 1 ORDER BY t.id, t.at, t.commit_hash`;
}

/** The class of a thrown value, safe to publish: never its message or any row content. */
function errorClass(error: unknown): string {
	const name =
		error instanceof Error
			? error.name.replace(/[^A-Za-z0-9_]/g, "")
			: typeof error;
	return `error:${(name || "unknown").slice(0, 64)}`;
}

/** One classified edit, from its kept (older) diff row. */
interface Edit {
	appends: boolean;
	withReason: boolean;
}

type EditRead =
	| { ok: true; edits: Edit[]; mergeRepeats: number; asOf: string | null }
	| {
			ok: false;
			reason: NonNullable<MetricSample["reason"]>;
			asOf: string | null;
			evidence: string[];
	  };

const sameText = (a: unknown, b: unknown) =>
	(a == null ? null : String(a)) === (b == null ? null : String(b));

/** A work-item commit message holds a one-line `Reason: <text>` after its first line. */
function workItemReason(message: unknown): boolean {
	return String(message ?? "")
		.split("\n")
		.slice(1)
		.some((line) => line.startsWith("Reason: ") && line.length > 8);
}

type WindowCommitsRead =
	| { ok: true; commits: string[]; asOf: string | null }
	| Extract<EditRead, { ok: false }>;

/** One statement read through the budget: its rows, or the error class (a timeout is rethrown). */
async function readRows(
	sql: Sql,
	text: string,
	read: Read,
	stage: EditsStage,
	timing?: (update: EditsTimingUpdate) => void,
): Promise<
	| { rows: ReadonlyArray<Record<string, unknown>>; error?: undefined }
	| { error: string }
> {
	const report = (update: EditsTimingUpdate) => {
		try {
			timing?.(update);
		} catch {
			/* diagnostics are optional */
		}
	};
	report({ stage, phase: "start" });
	try {
		const result = await read(async (signal) => {
			try {
				return { rows: await run(sql, text, signal) };
			} catch (error) {
				// A timeout keeps its own failure; every other read error is
				// source_failed, recorded by class only.
				if (signal.aborted) throw error;
				return { error: errorClass(error) };
			}
		});
		report({ stage, phase: result.error === undefined ? "ok" : "error" });
		return result;
	} catch (error) {
		report({ stage, phase: "error" });
		throw error;
	}
}

/** The window's commit hashes, one source call shared by both tables. */
async function readWindowCommits(
	sql: Sql,
	window: { start: string; end: string },
	read: Read,
	timing?: (update: EditsTimingUpdate) => void,
): Promise<WindowCommitsRead> {
	const failed = (
		reason: NonNullable<MetricSample["reason"]>,
		asOf: string | null,
		evidence: string[] = [],
	): WindowCommitsRead => ({ ok: false, reason, asOf, evidence });
	const result = await readRows(
		sql,
		noInlineHistoryWindowCommitsSql(window),
		read,
		"windowCommits",
		timing,
	);
	if (result.error !== undefined)
		return failed("source_failed", null, [result.error]);
	const rows = result.rows;
	const first = rows[0];
	if (!first) return failed("incomplete_or_invalid_source", null);
	const asOf = first.as_of
		? new Date(first.as_of as string).toISOString()
		: null;
	const n = Number(first.n);
	if (!Number.isFinite(n)) return failed("incomplete_or_invalid_source", asOf);
	if (
		first.n != null &&
		String(first.n).trim() !== "" &&
		Number.isSafeInteger(n) &&
		n >= 0
	) {
		try {
			timing?.({ stage: "windowCommits", phase: "counts", rows: n });
		} catch {}
	}
	if (n === 0) return { ok: true, commits: [], asOf };
	// Over the cap the statement sends the totals row alone.
	if (
		n > NO_INLINE_HISTORY_MAX_ROWS ||
		rows.length !== n ||
		rows.some((r) => !COMMIT.test(String(r.commit_hash ?? "")))
	)
		return failed("incomplete_or_invalid_source", asOf, [
			`counts:window_commits=${n};cap_hit`,
		]);
	return {
		ok: true,
		commits: rows.map((r) => String(r.commit_hash)),
		asOf,
	};
}

async function readEditsOf(
	sql: Sql,
	table: EditTable,
	window: { start: string; end: string },
	commits: string[],
	windowAsOf: string | null,
	read: Read,
	timing?: (update: EditsTimingUpdate) => void,
): Promise<EditRead> {
	const failed = (
		reason: NonNullable<MetricSample["reason"]>,
		asOf: string | null,
		evidence: string[] = [],
	): EditRead => ({ ok: false, reason, asOf, evidence });
	const result = await readRows(
		sql,
		noInlineHistoryEditsSql(table, commits),
		read,
		table === "work-items" ? "workDiff" : "knowledgeDiff",
		timing,
	);
	if (result.error !== undefined)
		return failed("source_failed", null, [result.error]);
	const rows = result.rows;
	const first = rows[0];
	// The statement sends no row when no diff row qualifies: no edit in this
	// table. The window read's own `as_of` stands in for the missing row's.
	if (!first) {
		try {
			timing?.({
				stage: table === "work-items" ? "workDiff" : "knowledgeDiff",
				phase: "counts",
				rows: 0,
				bytes: 0,
			});
		} catch {}
		return { ok: true, edits: [], mergeRepeats: 0, asOf: windowAsOf };
	}
	const asOf = first.as_of
		? new Date(first.as_of as string).toISOString()
		: null;
	const n = Number(first.n);
	const bytes = Number(first.bytes);
	if (!Number.isFinite(n) || !Number.isFinite(bytes))
		return failed("incomplete_or_invalid_source", asOf);
	if (
		first.n != null &&
		String(first.n).trim() !== "" &&
		first.bytes != null &&
		String(first.bytes).trim() !== "" &&
		Number.isSafeInteger(n) &&
		n >= 0 &&
		Number.isSafeInteger(bytes) &&
		bytes >= 0
	) {
		try {
			timing?.({
				stage: table === "work-items" ? "workDiff" : "knowledgeDiff",
				phase: "counts",
				rows: n,
				bytes,
			});
		} catch {}
	}
	if (n === 0) return { ok: true, edits: [], mergeRepeats: 0, asOf };
	// Over a cap the statement sends its first row alone, carrying the totals.
	if (
		n > NO_INLINE_HISTORY_MAX_ROWS ||
		bytes > NO_INLINE_HISTORY_MAX_BYTES ||
		rows.length !== n ||
		rows.some((r) => r.id == null) ||
		rows.some((r) => r.oversize === true || r.oversize === "t")
	)
		return failed("incomplete_or_invalid_source", asOf, [
			`counts:${table}_rows=${n};bytes=${bytes};cap_hit`,
		]);
	const dated = rows.map((row) => ({
		row,
		ms: Date.parse(doltInstant(row.at) ?? ""),
	}));
	if (dated.some((d) => !Number.isFinite(d.ms)))
		return failed("incomplete_or_invalid_source", asOf, [
			`counts:${table}_rows=${n};bad_commit_date`,
		]);
	const order = (a: unknown, b: unknown) =>
		String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
	// Oldest first within one row id; the commit hash breaks a date tie.
	dated.sort(
		(a, b) =>
			order(a.row.id, b.row.id) ||
			a.ms - b.ms ||
			order(a.row.commit_hash, b.row.commit_hash),
	);
	const columns = EDIT_COLUMNS[table];
	const start = Date.parse(window.start);
	const end = Date.parse(window.end);
	const edits: Edit[] = [];
	let mergeRepeats = 0;
	let previous: (typeof dated)[number] | undefined;
	const seen = new Set<string>();
	for (const d of dated) {
		const { row } = d;
		const prev = previous;
		previous = d;
		// A merge commit repeats its branch commit's row: adjacent diff rows of one
		// row id with the same value in every read `to_` column are one edit, and
		// the older (the branch commit) is the one kept.
		if (
			prev &&
			sameText(prev.row.id, row.id) &&
			columns.every((c) => sameText(prev.row[`to_${c}`], row[`to_${c}`]))
		) {
			mergeRepeats++;
			continue;
		}
		const key = `${row.commit_hash}:${row.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (row.diff_type !== "modified" || d.ms < start || d.ms >= end) continue;
		const pairs = columns.map((c) => ({
			from: row[`from_${c}`] == null ? null : String(row[`from_${c}`]),
			to: row[`to_${c}`] == null ? null : String(row[`to_${c}`]),
		}));
		// Only a change to an edit column is an edit.
		if (pairs.every((p) => sameText(p.from, p.to))) continue;
		edits.push({
			appends: appendsHistory(pairs),
			withReason:
				table === "work-items"
					? workItemReason(row.reason_message)
					: String(row.reason_message ?? "").trim() !== "",
		});
	}
	return { ok: true, edits, mergeRepeats, asOf };
}

/**
 * Edits in [start, end): the window's commits, then work items, then atoms,
 * three source calls (two when the window holds no commit). An edit is
 * one (commit, row id) pair on main that changed a work item's summary or
 * outcome or an atom's content; creation, deletion and fixtures are not edits.
 * An edit is dated by the commit whose diff row carries it, so a contribution
 * merged inside the window counts at the merge date.
 * `share` is the percent of edits that did not append history (the count of
 * marker lines did not grow); `count` is the raw number of edits. Under
 * `NO_INLINE_HISTORY_MIN_EDITS` a share is `insufficient_history`; over
 * `NO_INLINE_HISTORY_MAX_EDITS` either output fails closed.
 */
export async function readNoInlineHistoryEdits(
	sql: Sql,
	output: "share" | "count",
	window: { start: string; end: string },
	read: Read,
	timing?: (update: EditsTimingUpdate) => void,
): Promise<MetricSample> {
	const unit = output === "share" ? "%" : "edits";
	const start = new Date(Date.parse(window.start)).toISOString();
	const end = new Date(Date.parse(window.end)).toISOString();
	const watermarks: MetricSample["sourceWatermarks"] = [];
	const evidenceRefs = [
		`rules:${NO_INLINE_HISTORY_RULES_VERSION}`,
		`window:[${start},${end})`,
	];
	const unknown = (
		reason: NonNullable<MetricSample["reason"]>,
	): MetricSample => ({
		value: 0,
		unit,
		complete: false,
		sourceWatermarks: watermarks,
		evidenceRefs,
		reason,
	});
	const edits: Edit[] = [];
	let mergeRepeats = 0;
	// One read of the window's commits serves both tables. No commit in the
	// window means no edit, so the diff statements are not run.
	const inWindow = await readWindowCommits(sql, { start, end }, read, timing);
	if (!inWindow.ok) {
		evidenceRefs.push(...inWindow.evidence);
		return unknown(inWindow.reason);
	}
	for (const table of ["work-items", "atoms"] as const) {
		const part: EditRead = inWindow.commits.length
			? await readEditsOf(
					sql,
					table,
					{ start, end },
					inWindow.commits,
					inWindow.asOf,
					read,
					timing,
				)
			: { ok: true, edits: [], mergeRepeats: 0, asOf: inWindow.asOf };
		watermarks.push({
			source: NO_INLINE_HISTORY_SOURCE[table],
			asOf: part.asOf,
		});
		if (!part.ok) {
			evidenceRefs.push(...part.evidence);
			return unknown(part.reason);
		}
		edits.push(...part.edits);
		mergeRepeats += part.mergeRepeats;
	}
	const appending = edits.filter((e) => e.appends).length;
	const withReason = edits.filter((e) => e.withReason).length;
	evidenceRefs.push(
		`counts:edits=${edits.length};appending=${appending};withReason=${withReason}`,
		`counts:merge_repeats=${mergeRepeats}`,
	);
	if (edits.length > NO_INLINE_HISTORY_MAX_EDITS) {
		evidenceRefs.push("cap_hit");
		return unknown("incomplete_or_invalid_source");
	}
	const sample = (value: number): MetricSample => ({
		value,
		unit,
		complete: true,
		sourceWatermarks: watermarks,
		evidenceRefs,
	});
	if (output === "count") return sample(edits.length);
	if (edits.length === 0) return unknown("zero_denominator");
	if (edits.length < NO_INLINE_HISTORY_MIN_EDITS)
		return unknown("insufficient_history");
	return sample((100 * (edits.length - appending)) / edits.length);
}
