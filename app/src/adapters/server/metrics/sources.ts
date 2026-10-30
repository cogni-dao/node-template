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
