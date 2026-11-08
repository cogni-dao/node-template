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
import type { MetricBudget, MetricSample } from "./contracts.js";

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
