// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Node-owned source readers. Static SQL and fixed provider origin; no user URLs or SQL. */
import type { MetricBudget, MetricSample } from "@cogni-dao/metrics";
import type { Sql } from "postgres";

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
function doltInstant(value: unknown): string | null {
	const text = typeof value === "string" ? value.trim() : "";
	const ms = Date.parse(`${text.replace(" ", "T")}Z`);
	return text && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
const COMMIT = /^[a-z0-9]{32}$/;

export type ConvergenceOutput = "ratio" | "validated" | "created";
type Read = <T>(source: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * Edge commit c(T): latest commit in main's history with date <= T, from
 * dolt_log('main') (dolt.commits also holds branch commits). Validated work is
 * the net row diff dolt_diff(c(start), c(end), 'work_items') whose to_ side is
 * done + deploy_verified and whose from_ side is not (added rows included).
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
	  }
	| { ok: false }
> {
	try {
		const [from, to] = await read(async (signal) => {
			const edge = async (at: string) =>
				(
					await run(
						sql,
						`SELECT commit_hash, CAST(date AS TEXT) AS date FROM dolt_log('main') WHERE date <= '${doltUtc(at)}' ORDER BY date DESC LIMIT 1`,
						signal,
					)
				)[0];
			return [await edge(window.start), await edge(window.end)];
		});
		const fromHash = String(from?.commit_hash ?? "");
		const toHash = String(to?.commit_hash ?? "");
		// No main commit at or before an edge: history does not cover the window.
		if (!COMMIT.test(fromHash) || !COMMIT.test(toHash)) return { ok: false };
		const validated =
			fromHash === toHash
				? 0
				: Number(
						(
							await read((signal) =>
								run(
									sql,
									`SELECT COUNT(*) AS validated FROM dolt_diff('${fromHash}', '${toHash}', 'work_items') WHERE to_status = 'done' AND to_deploy_verified = true AND (from_id IS NULL OR from_status IS DISTINCT FROM 'done' OR from_deploy_verified IS DISTINCT FROM true) AND ${SYNTHETIC_LABELS("to_labels")}`,
									signal,
								),
							)
						)[0]?.validated,
					);
		if (!Number.isInteger(validated) || validated < 0) return { ok: false };
		return {
			ok: true,
			validated,
			from: fromHash,
			to: toHash,
			toAt: doltInstant(to?.date),
		};
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
		return { ok: false };
	}
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
	if (!history.ok) return sample(0, false, "history_unavailable");
	evidenceRefs.push(
		`dolt:main:${history.from}..${history.to}${history.toAt ? `@${history.toAt}` : ""}`,
		"node:work_items:validated:dolt_diff:done+deploy_verified",
		`counts:validated_work=${history.validated}`,
	);
	const validated = history.validated + mergedContributions;
	if (output === "validated") return sample(validated, true);
	if (created === 0) return sample(0, false, "zero_denominator");
	return sample(validated / created, true);
}
