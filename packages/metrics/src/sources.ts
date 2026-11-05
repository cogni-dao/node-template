// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Node-agnostic goal-metric source readers over an injected node SQL client.
 * Static SQL and a fixed provider origin; no user URLs or SQL. Callers own the
 * client, its credentials and its lifecycle.
 */
import type { Sql } from "postgres";
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

/**
 * Edge commit c(T) = what main pointed to at T. Preferred source: main's reflog
 * (dolt_reflog('main')), which records every move of the main ref with its own
 * timestamp: O(1) per edge and immune to backdated branch commits. When the
 * reflog does not reach back to T (fresh server, GC), fall back to the bounded
 * first-parent walk below. Fallback: the first commit on main's FIRST-PARENT chain (walking back
 * from dolt_hashof('main')) with date <= T. dolt_log('main') is not used: it
 * includes commits merged in from contribution branches with their authoring
 * dates, so a stale branch commit could become an edge (task.0024 probe
 * dolt-first-parent-probe.json). Validated work is the net row diff
 * dolt_diff(c(start), c(end), 'work_items') whose to_ side is done +
 * deploy_verified and whose from_ side is not (added rows included).
 * dolt_diff_summary.data_change is not trusted (work-items adapter, bug.5358).
 */
export async function readWorkValidatedHistory(
	sql: Sql,
	window: { start: string; end: string },
	read: Read,
): Promise<
	| {
			ok: true;
			validated: number;
			from: string;
			to: string;
			toAt: string | null;
			/** "reflog" or "first-parent:<depth>". */
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
		const reflog = await mainFromReflog(sql, window, read);
		if (reflog) return await diffValidated(sql, reflog, read);
		const walk = await read((signal) =>
			run(
				sql,
				`WITH RECURSIVE chain(commit_hash, depth, date) AS (
				SELECT c.commit_hash, 0, c.date FROM dolt.commits c WHERE c.commit_hash = dolt_hashof('main')
				UNION ALL
				SELECT p.commit_hash, chain.depth + 1, p.date FROM chain
				JOIN dolt.commit_ancestors a ON a.commit_hash = chain.commit_hash AND a.parent_index = 0
				JOIN dolt.commits p ON p.commit_hash = a.parent_hash
				WHERE chain.depth < ${FIRST_PARENT_WALK_CAP} AND chain.date > '${doltUtc(window.start)}'
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
		const edge = (iso: string) =>
			chain.find((c) => c.at <= Date.parse(iso)) ?? null;
		const fromEdge = edge(window.start);
		const toEdge = edge(window.end);
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
		return await diffValidated(
			sql,
			{
				from: fromEdge.hash,
				to: toEdge.hash,
				toAt: new Date(toEdge.at).toISOString(),
				via: `first-parent:${chain.length - 1}`,
			},
			read,
		);
	} catch (error) {
		// Timeouts and budget exhaustion keep their own failure; other history
		// read failures are an unknown sample, never zero.
		if (
			error instanceof Error &&
			(error.name === "AbortError" ||
				error.name === "MetricError" ||
				error.name === "TimeoutError")
		)
			throw error;
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

/** main at T from the reflog; null when the reflog is unsupported or does not reach back to the window start. */
async function mainFromReflog(
	sql: Sql,
	window: { start: string; end: string },
	read: Read,
): Promise<Edges | null> {
	const at = async (iso: string) => {
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
			return COMMIT.test(hash) ? { hash, at: doltInstant(row?.at) } : null;
		} catch (error) {
			if (
				error instanceof Error &&
				(error.name === "AbortError" ||
					error.name === "MetricError" ||
					error.name === "TimeoutError")
			)
				throw error;
			return null;
		}
	};
	const from = await at(window.start);
	if (!from) return null;
	const to = await at(window.end);
	if (!to) return null;
	return { from: from.hash, to: to.hash, toAt: to.at, via: "reflog" };
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

/** Seven-day convergence: validated units / created units in [start, end). */
export async function readWorkConvergence(
	sql: Sql,
	output: ConvergenceOutput,
	window: { start: string; end: string },
	read: Read,
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
	if (output === "created") return sample(created, true);
	const history = await readWorkValidatedHistory(sql, { start, end }, read);
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
