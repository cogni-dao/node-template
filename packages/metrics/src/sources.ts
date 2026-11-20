// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node-agnostic goal-metric source readers over an injected node SQL client.
 * Static SQL and a fixed provider origin; no user URLs or SQL. Callers own the
 * client, its credentials and its lifecycle.
 */
import type { Sql } from "postgres";
import type { MetricBudget, MetricSample } from "./contracts.js";
import {
	approvedLines,
	NO_INLINE_HISTORY_FIELDS,
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

/**
 * One unauthenticated GET against the fixed provider origin, parsed as JSON.
 * Response bytes are bounded during streaming, not after allocating the body.
 * The provider HTTP `Date` is the response snapshot watermark, not a body field.
 */
async function fetchProviderJson(
	url: string,
	signal: AbortSignal,
	maxResponseBytes: number,
): Promise<{ body: any; date: string | null }> {
	const response = await fetch(url, {
		signal,
		redirect: "error",
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "Cogni-node-metrics",
		},
		cache: "no-store",
	});
	if (!response.ok) {
		// 403 and 429 are the provider's quota answers; a 200 that spent the last request is still data.
		if (
			response.status === 429 ||
			response.status === 403 ||
			response.headers.get("x-ratelimit-remaining") === "0"
		) {
			await response.body?.cancel();
			throw new ProviderRateLimited("provider_rate_limited");
		}
		throw new Error("provider_unavailable");
	}
	if (!response.body) throw new Error("provider_unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxResponseBytes) throw new Error("provider_response_budget");
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
	const sourceDate = response.headers.get("date");
	return {
		body: JSON.parse(new TextDecoder().decode(bytes)),
		date: sourceDate ? new Date(sourceDate).toISOString() : null,
	};
}

export async function readGithubStars(
	owner: string,
	repo: string,
	signal: AbortSignal,
	budget: Readonly<MetricBudget>,
): Promise<MetricSample> {
	const { body, date } = await fetchProviderJson(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
		signal,
		budget.maxResponseBytes,
	);
	return {
		value: body.stargazers_count,
		unit: "stars",
		complete: typeof body.stargazers_count === "number",
		sourceWatermarks: [{ source: "github.public", asOf: date }],
		evidenceRefs: [`https://github.com/${owner}/${repo}`],
	};
}

/** Most runs one workflow-runs page returns; the API's own cap. */
export const GITHUB_ACTIONS_PAGE_SIZE = 100;
/** Pages one reading may read: more runs than this is incomplete, never truncated. */
export const GITHUB_ACTIONS_MAX_PAGES = 10;
/** A full runs page is about 1.4 MB (100 runs, ~14 KB each, measured); 3 MiB bounds each page. */
export const GITHUB_ACTIONS_MAX_PAGE_BYTES = 3_145_728;

export interface GithubActionsParams {
	owner: string;
	repo: string;
	workflow: string;
	event?: "pull_request" | "merge_group" | "push" | undefined;
	output: "duration" | "failure_rate" | "flake_rate";
	/** Nearest-rank quantile for `duration`; default 0.95. */
	quantile?: number | undefined;
}

/** Fields every run needs to be counted at all; the rest are read only for the runs that give a verdict. */
interface WorkflowRun {
	id: number;
	head_sha: string;
	conclusion: string | null;
	run_attempt: number;
	created_at: string;
	run_started_at: string;
	updated_at: string;
}

const isRunEntry = (r: any): boolean =>
	!!r &&
	Number.isSafeInteger(r.id) &&
	(r.conclusion === null || typeof r.conclusion === "string");

const runFailed = (r: WorkflowRun) =>
	r.conclusion === "failure" ||
	r.conclusion === "startup_failure" ||
	r.conclusion === "timed_out";

const givesVerdict = (r: WorkflowRun) =>
	r.conclusion === "success" || runFailed(r);

/** Fields the rates need from a run that gives a verdict. */
const hasVerdictFields = (r: WorkflowRun) =>
	typeof r.head_sha === "string" &&
	Number.isInteger(r.run_attempt) &&
	Number.isFinite(Date.parse(r.created_at));

/** The provider refused the read for quota (403/429): a wait, not a fault. */
class ProviderRateLimited extends Error {}

/** One page read for a window and the verdict on whether it covers the window. */
type LoadedRuns =
	| { kind: "ok"; runs: WorkflowRun[]; asOf: string | null }
	| { kind: "incomplete"; counts: string; asOf: string | null }
	| { kind: "rate_limited"; asOf: string | null };

/** Runs one shared page read; `key` names the read, `fn` performs it with its own signal. */
export type SharedRead = <T>(
	key: string,
	fn: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal,
) => Promise<T>;
const unshared: SharedRead = (_key, fn, signal) => fn(signal);

async function loadWorkflowRuns(
	url: (page: number) => string,
	signal: AbortSignal,
	maxResponseBytes: number,
): Promise<LoadedRuns> {
	const cap = GITHUB_ACTIONS_MAX_PAGES * GITHUB_ACTIONS_PAGE_SIZE;
	const runs = new Map<number, WorkflowRun>();
	let asOf: string | null = null;
	let total = Number.POSITIVE_INFINITY;
	try {
		for (
			let page = 1;
			page <= GITHUB_ACTIONS_MAX_PAGES && runs.size < total;
			page++
		) {
			const got = await fetchProviderJson(url(page), signal, maxResponseBytes);
			asOf ??= got.date;
			const pageRuns = got.body?.workflow_runs;
			if (
				!Array.isArray(pageRuns) ||
				!Number.isSafeInteger(got.body.total_count) ||
				!pageRuns.every(isRunEntry)
			)
				return { kind: "incomplete", counts: `malformed-page=${page}`, asOf };
			total = got.body.total_count;
			if (total > cap)
				return { kind: "incomplete", counts: `total=${total},cap=${cap}`, asOf };
			for (const run of pageRuns) runs.set(run.id, run);
			if (pageRuns.length === 0) break;
		}
	} catch (error) {
		if (error instanceof ProviderRateLimited)
			return { kind: "rate_limited", asOf };
		throw error;
	}
	if (runs.size < total)
		return {
			kind: "incomplete",
			counts: `read=${runs.size},total=${total}`,
			asOf,
		};
	return { kind: "ok", runs: [...runs.values()], asOf };
}

/**
 * CI health of one workflow over the half-open window [start, end), read from
 * the provider's Actions REST API without credentials. The population is
 * completed runs that succeeded or failed (`startup_failure` and `timed_out`
 * count as failure); cancelled, skipped, neutral, stale and action_required
 * runs are no verdict on the code and are left out, whatever their fields hold.
 * A flaky head SHA has a passing retry (`run_attempt > 1`) or both a failed and
 * a passing run. More runs than `GITHUB_ACTIONS_MAX_PAGES` pages hold, a
 * malformed page or an empty population is unknown, never a partial value or a
 * 0; a quota refusal is unknown with the existing `source_failed` reason and a `rate-limited` evidence marker. `read` is the
 * budgeted source call (the whole page read is one call). `share` lets
 * calculators that read the same workflow list inside one tick pay for it once;
 * the list is requested from the minute the window starts and trimmed to the
 * exact window here, so every reading sees the same runs.
 */
export async function readGithubActions(
	p: GithubActionsParams,
	window: { start: string; end: string },
	read: <T>(
		source: (signal: AbortSignal, budget: Readonly<MetricBudget>) => Promise<T>,
	) => Promise<T>,
	share: SharedRead = unshared,
): Promise<MetricSample> {
	const start = Date.parse(window.start);
	const end = Date.parse(window.end);
	const unit = p.output === "duration" ? "min" : "%";
	const workflowUrl = `https://github.com/${p.owner}/${p.repo}/actions/workflows/${p.workflow}`;
	const created = new Date(Math.floor(start / 60000) * 60000)
		.toISOString()
		.replace(/\.\d+Z$/, "Z");
	const query =
		`created=${encodeURIComponent(`>=${created}`)}` +
		`&status=completed&per_page=${GITHUB_ACTIONS_PAGE_SIZE}&exclude_pull_requests=true` +
		(p.event ? `&event=${p.event}` : "");
	const url = (page: number) =>
		`https://api.github.com/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/actions/workflows/${encodeURIComponent(p.workflow)}/runs?${query}&page=${page}`;
	const loaded = await read((signal, budget) =>
		share(
			url(1),
			(sharedSignal) =>
				loadWorkflowRuns(url, sharedSignal, budget.maxResponseBytes),
			signal,
		),
	);
	const sample = (
		value: number,
		complete: boolean,
		counts: string,
		reason?:
			| "incomplete_or_invalid_source"
			| "zero_denominator"
			| "source_failed",
	): MetricSample => ({
		value,
		unit,
		complete,
		...(reason ? { reason } : {}),
		sourceWatermarks: [{ source: "github.actions", asOf: loaded.asOf }],
		evidenceRefs: [
			workflowUrl,
			`github:actions:${p.repo}/${p.workflow}:${counts}`,
		],
	});
	if (loaded.kind === "rate_limited")
		return sample(0, false, "rate-limited", "source_failed");
	if (loaded.kind === "incomplete")
		return sample(0, false, loaded.counts, "incomplete_or_invalid_source");

	const inWindow = loaded.runs.filter((r) => {
		const at = Date.parse(r.created_at);
		return givesVerdict(r) && !(at < start || at >= end);
	});
	if (!inWindow.every(hasVerdictFields))
		return sample(0, false, "malformed-run", "incomplete_or_invalid_source");
	const population = inWindow;
	const bySha = new Map<string, WorkflowRun[]>();
	for (const r of population) {
		const group = bySha.get(r.head_sha);
		if (group) group.push(r);
		else bySha.set(r.head_sha, [r]);
	}
	const flakyShas = [...bySha.values()].filter(
		(group) =>
			group.some((r) => r.run_attempt > 1 && r.conclusion === "success") ||
			(group.some(runFailed) && group.some((r) => r.conclusion === "success")),
	).length;
	const failures = population.filter(runFailed).length;
	const counts = `runs=${population.length},failures=${failures},shas=${bySha.size},flakyShas=${flakyShas}`;
	if (population.length === 0)
		return sample(0, false, counts, "zero_denominator");

	if (p.output === "failure_rate")
		return sample((failures / population.length) * 100, true, counts);
	if (p.output === "flake_rate")
		return sample((flakyShas / bySha.size) * 100, true, counts);
	// A run whose timings are missing or run backwards has no duration; it is skipped, not a reason to void the reading.
	const minutes = population
		.map(
			(r) => (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60000,
		)
		.filter((m) => Number.isFinite(m) && m >= 0)
		.sort((a, b) => a - b);
	if (minutes.length === 0)
		return sample(0, false, counts, "incomplete_or_invalid_source");
	// Nearest rank in integer basis points, so 0.55 x 100 ranks 55, not 56.
	const rank = Math.ceil(
		(Math.round((p.quantile ?? 0.95) * 10000) * minutes.length) / 10000,
	);
	return sample(minutes[Math.max(0, rank - 1)] as number, true, counts);
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

/**
 * One statement: open, non-synthetic work items (`total`) and those whose
 * `moves` names at least one metric (`linked`). `moves` is NULL when never
 * declared and `[]` when cleared; a real entry always carries a `metricId`
 * key, so a text match on the key counts entries and neither empty form.
 * Two scalar COUNTs, the shape `readWorkCount` already runs on Doltgres.
 */
export const WORK_KPI_LINKED_SQL = `SELECT NOW() AS as_of, (SELECT COUNT(*) FROM work_items WHERE status NOT IN ('done','cancelled') AND ${SYNTHETIC_LABELS("labels")}) AS total, (SELECT COUNT(*) FROM work_items WHERE status NOT IN ('done','cancelled') AND ${SYNTHETIC_LABELS("labels")} AND moves IS NOT NULL AND CAST(moves AS TEXT) LIKE '%"metricId"%') AS linked`;

/** Open work past design: the stages after an approved design review (story.0069). */
const PAST_DESIGN = `status IN ('needs_implement','needs_implementation_review','needs_validation','needs_merge','needs_closeout')`;

/**
 * One statement: open, non-synthetic work items past design (`total`) and those
 * whose `spec_refs` names a `design` atom on main as `knowledge:<id>` (`linked`).
 * `spec_refs` is a JSON array of strings, so a quoted text match on one whole
 * element finds the link; an untyped entry or a non-design atom never counts.
 * Scalar subqueries in the `kpi-linked` shape, joined to `knowledge` on main.
 */
export const WORK_DESIGN_LINKED_SQL = `SELECT NOW() AS as_of, (SELECT COUNT(*) FROM work_items WHERE ${PAST_DESIGN} AND ${SYNTHETIC_LABELS("labels")}) AS total, (SELECT COUNT(*) FROM work_items w WHERE w.${PAST_DESIGN} AND ${SYNTHETIC_LABELS("w.labels")} AND w.spec_refs IS NOT NULL AND EXISTS (SELECT 1 FROM knowledge k WHERE k.entry_type = 'design' AND CAST(w.spec_refs AS TEXT) LIKE CONCAT('%"knowledge:', k.id, '"%'))) AS linked`;

/**
 * The percent of open, non-synthetic work items that name at least one
 * metric in `moves`. An empty scope is `zero_denominator` and a malformed
 * result is `incomplete_or_invalid_source`, never zero.
 */
export function readWorkKpiLinked(
	sql: Sql,
	signal: AbortSignal,
): Promise<MetricSample> {
	return readWorkLinkedShare(sql, WORK_KPI_LINKED_SQL, "kpi-linked", signal);
}

/**
 * The percent of open, non-synthetic work items past design that link a merged
 * design atom in `specRefs`, read in the same shape as `kpi-linked`.
 */
export function readWorkDesignLinked(
	sql: Sql,
	signal: AbortSignal,
): Promise<MetricSample> {
	return readWorkLinkedShare(sql, WORK_DESIGN_LINKED_SQL, "design-linked", signal);
}

/** One `total`/`linked` row as a percent; the evidence names the counted mode and both counts. */
async function readWorkLinkedShare(
	sql: Sql,
	text: string,
	mode: "kpi-linked" | "design-linked",
	signal: AbortSignal,
): Promise<MetricSample> {
	const rows = await run(sql, text, signal);
	const first = rows[0];
	const asOf = first?.as_of
		? new Date(first.as_of as string).toISOString()
		: null;
	const total = Number(first?.total);
	const linked = Number(first?.linked);
	const valid =
		rows.length === 1 &&
		Number.isInteger(total) &&
		Number.isInteger(linked) &&
		linked >= 0 &&
		linked <= total;
	const common = {
		unit: "%",
		sourceWatermarks: [{ source: "node.work_items", asOf }],
	};
	if (!valid)
		return {
			...common,
			value: 0,
			complete: false,
			evidenceRefs: [],
			reason: "incomplete_or_invalid_source",
		};
	const evidenceRefs = [
		`node:work_items:count:${mode}:excludes-synthetic`,
		`counts:evaluated=${total};linked=${linked}`,
	];
	if (total === 0)
		return {
			...common,
			value: 0,
			complete: false,
			evidenceRefs,
			reason: "zero_denominator",
		};
	return {
		...common,
		value: (100 * linked) / total,
		complete: true,
		evidenceRefs,
	};
}

/**
 * One statement: knowledge contributions merged in [start, end) (`merged`),
 * those whose resolver is not the author (`reviewed`) and those with no
 * resolver (`unresolved`). Static text with the window inside it, so every
 * output of `knowledge.merge-review@1` shares one read per refresh tick.
 * Scalar subqueries, as `work.convergence` uses: Doltgres runs with
 * only_full_group_by and refuses NOW() beside a bare aggregate.
 */
function knowledgeMergesSql(start: string, end: string): string {
	const merged = `FROM knowledge_contributions WHERE state = 'merged' AND resolved_at >= '${start}' AND resolved_at < '${end}'`;
	return `SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of, (SELECT COUNT(*) ${merged}) AS merged, (SELECT COUNT(*) ${merged} AND resolved_by <> principal_id) AS reviewed, (SELECT COUNT(*) ${merged} AND resolved_by IS NULL) AS unresolved`;
}

/**
 * Merges in [start, end) and, for `share`, the fraction resolved by someone
 * other than the author. No merges is `zero_denominator`; a merge with no
 * resolver (neither proves nor disproves review) or inconsistent counts is
 * `incomplete_or_invalid_source`; the raw `merged` count stays readable then.
 */
export async function readKnowledgeMerges(
	sql: Sql,
	output: "share" | "merged",
	window: { start: string; end: string },
	signal: AbortSignal,
): Promise<MetricSample> {
	const start = doltInstant(window.start);
	const end = doltInstant(window.end);
	if (!start || !end) throw new Error("invalid_window");
	const rows = await run(sql, knowledgeMergesSql(start, end), signal);
	const first = rows[0];
	const merged = Number(first?.merged);
	const reviewed = Number(first?.reviewed);
	const unresolved = Number(first?.unresolved);
	const counted =
		rows.length === 1 &&
		[merged, reviewed, unresolved].every(
			(n) => Number.isInteger(n) && n >= 0,
		) &&
		reviewed + unresolved <= merged;
	const common = {
		unit: output === "share" ? "ratio" : "items",
		sourceWatermarks: [
			{ source: "node.doltgres.main", asOf: doltInstant(first?.as_of) },
		],
		evidenceRefs: [
			`node:knowledge_contributions:window-resolved_at:${start}..${end}`,
			`counts:merged=${merged};reviewed=${reviewed};unresolved=${unresolved}`,
		],
	};
	const unknown = (reason: MetricSample["reason"]): MetricSample => ({
		...common,
		value: 0,
		complete: false,
		reason,
	});
	if (!counted) return unknown("incomplete_or_invalid_source");
	if (output === "merged") return { ...common, value: merged, complete: true };
	if (unresolved > 0) return unknown("incomplete_or_invalid_source");
	if (merged === 0) return unknown("zero_denominator");
	return { ...common, value: reviewed / merged, complete: true };
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

/** Most rows one no-inline-history statement reads. */
export const NO_INLINE_HISTORY_MAX_ROWS = 5000;
/** Most bytes of text one no-inline-history statement sends (16 MiB). */
export const NO_INLINE_HISTORY_MAX_BYTES = 16_777_216;

const NO_INLINE_HISTORY_SOURCE = {
	"work-items": "node.work_items",
	atoms: "node.knowledge",
} as const;

/**
 * One statement per subject. It counts the scope's rows (`n`) and the bytes of
 * its capped scored fields, and joins the rows in only while `n` and the bytes
 * are inside the caps; otherwise it returns the totals row alone, so the
 * database never sends a result over a cap. A field over the character cap is
 * sent as NULL and flagged `oversize`.
 */
export function noInlineHistoryStateSql(
	subject: NoInlineHistorySubject,
): string {
	const capped = (column: string) =>
		`CASE WHEN char_length(${column}) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS} THEN NULL ELSE ${column} END AS ${column}`;
	const over = (column: string) =>
		`COALESCE(char_length(${column}), 0) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS}`;
	const fields = NO_INLINE_HISTORY_FIELDS[subject];
	const from =
		subject === "work-items"
			? `work_items WHERE status NOT IN ('done','cancelled') AND ${SYNTHETIC_LABELS("labels")}`
			: `knowledge WHERE status <> 'deprecated' AND entry_type <> 'html' AND (tags IS NULL OR CAST(tags AS TEXT) NOT LIKE '%"test-fixture"%') AND title NOT LIKE '%[TEST]%'`;
	// Doltgres 0.57.3 panics on octet_length over a stored long text unless the
	// text is first materialized by substr, and compares a bare SUM as text, so
	// the total is cast to BIGINT. The character cap makes the substr safe.
	const size = (column: string) =>
		`COALESCE(CASE WHEN char_length(${column}) > ${NO_INLINE_HISTORY_MAX_FIELD_CHARS} THEN 0 ELSE octet_length(substr(${column}, 1, ${NO_INLINE_HISTORY_MAX_FIELD_CHARS})) END, 0) AS ${column}_bytes`;
	const bytes = fields.map((f) => `${f}_bytes`).join(" + ");
	return `WITH scope AS (SELECT id, ${fields.map(capped).join(", ")}, ${fields.map(size).join(", ")}, (${fields.map(over).join(" OR ")}) AS oversize FROM ${from}), totals AS (SELECT COUNT(*) AS n, CAST(COALESCE(SUM(${bytes}), 0) AS BIGINT) AS bytes FROM scope) SELECT NOW() AS as_of, t.n, t.bytes, s.id, ${fields.map((f) => `s.${f}`).join(", ")}, s.oversize FROM totals t LEFT JOIN scope s ON t.n <= ${NO_INLINE_HISTORY_MAX_ROWS} AND t.bytes <= ${NO_INLINE_HISTORY_MAX_BYTES} ORDER BY s.id`;
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

/** The class of a thrown value, safe to publish: never its message or any row content. */
function errorClass(error: unknown): string {
	const name =
		error instanceof Error
			? error.name.replace(/[^A-Za-z0-9_]/g, "")
			: typeof error;
	return `error:${(name || "unknown").slice(0, 64)}`;
}
export * from "./fleet-sources.js";
