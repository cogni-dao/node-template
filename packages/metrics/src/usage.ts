// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Module: `@cogni-dao/metrics/usage`
 * Purpose: Agent knowledge-usage measurement every node shares (story.0061): write-time read counters, write-time
 *   cite pairs, and the `knowledge.usage@1` calculator that reads them as the read-miss KPI.
 * Scope: Writers and the source read over a node's own Postgres (`postgres` client, service role). Node product stays
 *   in the node: which routes count, which principal is an agent, container wiring, migrations and log routing.
 * Invariants:
 * - KEYS_NOT_TRAFFIC: rows grow with distinct (day, atom, principal, class) keys and (atom, item) pairs, never with
 *   reads or patches. A missed id is caller-chosen, so ids outside CITE_ID_PATTERN fold into `*invalid*` and past 100
 *   distinct misses per (day, principal) per process into `*overflow*`.
 * - NEVER_BLOCKS: `count()` and `record()` are synchronous and never throw; a write failure never reaches the caller.
 * - ONE_FLUSH_IN_FLIGHT, SORTED_UPSERT: one upsert at a time, rows in key order so concurrent pods cannot deadlock.
 * - LOWER_BOUND: a failed flush merges back; only reads past the 5,000-key cap are lost, and every loss is logged.
 * - LAST_FULL_DAY: the calculator reads the last full UTC day before the window end and names it in evidence;
 *   sentinels count as units but are never ranked; an empty day is unknown, never 0%.
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 */
import type { Sql } from "postgres";
import { z } from "zod";
import type { MetricCalculator, MetricSample } from "./contracts";

/** Mirrors the `knowledge_read_daily` CHECK constraint. */
export type KnowledgeReaderClass = "internal_run" | "external_agent";

export interface KnowledgeRead {
	readonly atomId: string;
	/** `fail` only when the id does not exist (a 404 or a null get). */
	readonly outcome: "ok" | "fail";
	readonly principalId: string;
	readonly principalClass: KnowledgeReaderClass;
}

/** One usage log event; the node routes it to its registered logger with a system reqId. */
export type UsageLogEvent =
	| { event: "knowledge.read_counts_flushed"; reqId: string; keys: number; reads: number; byClass: Record<string, { ok: number; fail: number }> }
	| { event: "knowledge.read_count_write_failed"; reqId: string; reason: "flush_failed" | "map_full"; reads: number; keys?: number; errorClass?: string }
	| { event: "knowledge.cite_pairs_write_failed"; reqId: string; reason: "in_flight_cap" | "insert_failed"; pairs: number; errorClass?: string };

/** Same shape the work-items cite contract accepts; kept local so this package has no work-items dependency. */
const CITE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,255}$/;

export const READ_COUNT_FLUSH_INTERVAL_MS = 60_000;
export const READ_COUNT_MAX_KEYS = 5_000;
export const MISSED_IDS_PER_PRINCIPAL_DAY = 100;
export const INVALID_ATOM_KEY = "*invalid*";
export const OVERFLOW_ATOM_KEY = "*overflow*";
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '2s'";

interface CounterRow {
	day: string;
	atomId: string;
	principalId: string;
	principalClass: KnowledgeReaderClass;
	okCount: number;
	failCount: number;
}

const keyOf = (r: Pick<CounterRow, "day" | "atomId" | "principalId" | "principalClass">) =>
	`${r.day}\u0000${r.atomId}\u0000${r.principalId}\u0000${r.principalClass}`;

const errorClass = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** Batched write-time counters for agent atom reads in `knowledge_read_daily`. */
export class KnowledgeReadCounter {
	private pending = new Map<string, CounterRow>();
	private missed = new Map<string, Set<string>>();
	private missedDay = "";
	private flushing = false;
	private dropped = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly sql: Sql,
		private readonly log: (event: UsageLogEvent) => void,
		private readonly now: () => Date = () => new Date(),
	) {}

	count(read: KnowledgeRead): void {
		try {
			const day = this.now().toISOString().slice(0, 10);
			const atomId = read.outcome === "ok" ? read.atomId : this.missKey(day, read);
			const key = keyOf({ day, atomId, principalId: read.principalId, principalClass: read.principalClass });
			let row = this.pending.get(key);
			if (!row) {
				if (this.pending.size >= READ_COUNT_MAX_KEYS) {
					this.dropped += 1;
					return;
				}
				row = { day, atomId, principalId: read.principalId, principalClass: read.principalClass, okCount: 0, failCount: 0 };
				this.pending.set(key, row);
			}
			if (read.outcome === "ok") row.okCount += 1;
			else row.failCount += 1;
			this.ensureTimer();
		} catch {
			// NEVER_BLOCKS
		}
	}

	/** Upserts the pending counts in one statement. Called by the timer and on shutdown; safe to call concurrently. */
	async flush(): Promise<void> {
		this.reportDropped();
		if (this.flushing || this.pending.size === 0) return;
		this.flushing = true;
		const rows = [...this.pending.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
		this.pending = new Map();
		const reads = rows.reduce((sum, r) => sum + r.okCount + r.failCount, 0);
		const byClass: Record<string, { ok: number; fail: number }> = {};
		for (const r of rows) {
			const c = (byClass[r.principalClass] ??= { ok: 0, fail: 0 });
			c.ok += r.okCount;
			c.fail += r.failCount;
		}
		const reqId = `read-count-flush-${globalThis.crypto.randomUUID()}`;
		const params: Array<string | number> = [];
		const values = rows
			.map((r) => {
				const i = params.length;
				params.push(r.day, r.atomId, r.principalId, r.principalClass, r.okCount, r.failCount);
				return `($${i + 1}::date, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}::int, $${i + 6}::int)`;
			})
			.join(", ");
		try {
			await this.sql.begin(async (tx) => {
				await tx.unsafe(STATEMENT_TIMEOUT);
				await tx.unsafe(
					`INSERT INTO knowledge_read_daily (day, atom_id, principal_id, principal_class, ok_count, fail_count)
VALUES ${values}
ON CONFLICT (day, atom_id, principal_id, principal_class) DO UPDATE SET
  ok_count = knowledge_read_daily.ok_count + excluded.ok_count,
  fail_count = knowledge_read_daily.fail_count + excluded.fail_count,
  updated_at = now()`,
					params,
				);
			});
			this.safeLog({ event: "knowledge.read_counts_flushed", reqId, keys: rows.length, reads, byClass });
		} catch (error) {
			this.restore(rows);
			this.safeLog({
				event: "knowledge.read_count_write_failed",
				reqId,
				reason: "flush_failed",
				keys: rows.length,
				reads,
				errorClass: errorClass(error),
			});
		} finally {
			this.flushing = false;
		}
	}

	private missKey(day: string, read: KnowledgeRead): string {
		if (!CITE_ID_PATTERN.test(read.atomId)) return INVALID_ATOM_KEY;
		if (day !== this.missedDay) {
			this.missed = new Map();
			this.missedDay = day;
		}
		const scope = `${day}\u0000${read.principalId}`;
		let ids = this.missed.get(scope);
		if (!ids) {
			ids = new Set();
			this.missed.set(scope, ids);
		}
		if (ids.has(read.atomId)) return read.atomId;
		if (ids.size >= MISSED_IDS_PER_PRINCIPAL_DAY) return OVERFLOW_ATOM_KEY;
		ids.add(read.atomId);
		return read.atomId;
	}

	/** A failed flush puts its counts back, so a lost ok cannot turn into a false miss. Past the key cap they drop. */
	private restore(rows: readonly CounterRow[]): void {
		for (const row of rows) {
			const key = keyOf(row);
			const current = this.pending.get(key);
			if (current) {
				current.okCount += row.okCount;
				current.failCount += row.failCount;
			} else if (this.pending.size < READ_COUNT_MAX_KEYS) {
				this.pending.set(key, { ...row });
			} else {
				this.dropped += row.okCount + row.failCount;
			}
		}
	}

	private reportDropped(): void {
		if (this.dropped === 0) return;
		const reads = this.dropped;
		this.dropped = 0;
		this.safeLog({ event: "knowledge.read_count_write_failed", reqId: `read-count-flush-${globalThis.crypto.randomUUID()}`, reason: "map_full", reads });
	}

	private safeLog(event: UsageLogEvent): void {
		try {
			this.log(event);
		} catch {
			// NEVER_BLOCKS
		}
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.flush();
		}, READ_COUNT_FLUSH_INTERVAL_MS);
		this.timer.unref?.();
	}
}

/** Records each (atom, work item) pair a successful patch cites, once, in `knowledge_cite_pairs`. */
export class CitePairRecorder {
	private inFlight = 0;

	constructor(
		private readonly sql: Sql,
		private readonly log: (event: UsageLogEvent) => void,
	) {}

	/** `revision` is the item revision the patch produced; a non-integer revision records nothing. */
	record(workItemId: string, revision: string | number, cites: readonly { readonly id: string }[]): void {
		try {
			const firstItemRevision = Number(revision);
			const ids = [...new Set(cites.map((cite) => cite.id))].sort();
			if (!Number.isInteger(firstItemRevision) || ids.length === 0) return;
			if (this.inFlight >= 4) {
				this.fail("in_flight_cap", ids.length);
				return;
			}
			this.inFlight += 1;
			const params: Array<string | number> = [];
			const values = ids
				.map((atomId) => {
					const i = params.length;
					params.push(atomId, workItemId, firstItemRevision);
					return `($${i + 1}, $${i + 2}, $${i + 3}::int)`;
				})
				.join(", ");
			void this.sql
				.begin(async (tx) => {
					await tx.unsafe(STATEMENT_TIMEOUT);
					await tx.unsafe(
						`INSERT INTO knowledge_cite_pairs (atom_id, work_item_id, first_item_revision) VALUES ${values} ON CONFLICT DO NOTHING`,
						params,
					);
				})
				.catch((error: unknown) => this.fail("insert_failed", ids.length, error))
				.finally(() => {
					this.inFlight -= 1;
				});
		} catch {
			// NEVER_FAILS_THE_PATCH
		}
	}

	private fail(reason: "in_flight_cap" | "insert_failed", pairs: number, error?: unknown): void {
		try {
			this.log({
				event: "knowledge.cite_pairs_write_failed",
				reqId: `cite-pairs-${globalThis.crypto.randomUUID()}`,
				reason,
				pairs,
				...(error ? { errorClass: errorClass(error) } : {}),
			});
		} catch {
			// NEVER_FAILS_THE_PATCH
		}
	}
}

export const KNOWLEDGE_READ_MEASURES = ["miss_share", "read_units"] as const;
export type KnowledgeReadMeasure = (typeof KNOWLEDGE_READ_MEASURES)[number];

/** One statement: the day's units, its miss units, and the top missed and top read atoms. */
export const KNOWLEDGE_READS_SQL = `WITH d AS (SELECT (($1::timestamptz AT TIME ZONE 'UTC') - interval '1 day')::date AS day),
u AS (
  SELECT k.principal_id, k.atom_id, SUM(k.ok_count)::int AS ok, SUM(k.fail_count)::int AS fail
  FROM knowledge_read_daily k, d WHERE k.day = d.day
  GROUP BY k.principal_id, k.atom_id
),
m AS (
  SELECT atom_id, SUM(fail)::int AS n, COUNT(*)::int AS principals FROM u
  WHERE ok = 0 AND fail > 0 AND atom_id NOT IN ('${INVALID_ATOM_KEY}', '${OVERFLOW_ATOM_KEY}')
  GROUP BY atom_id ORDER BY n DESC, principals DESC, atom_id LIMIT 10
),
r AS (
  SELECT atom_id, SUM(ok)::int AS n, COUNT(*)::int AS principals FROM u
  WHERE ok > 0 AND atom_id NOT IN ('${INVALID_ATOM_KEY}', '${OVERFLOW_ATOM_KEY}')
  GROUP BY atom_id ORDER BY n DESC, atom_id LIMIT 10
)
SELECT (SELECT day FROM d)::text AS day, NOW() AS as_of,
  (SELECT COUNT(*) FROM u)::int AS units,
  (SELECT COUNT(*) FROM u WHERE ok = 0 AND fail > 0)::int AS miss_units,
  (SELECT COALESCE(SUM(ok + fail), 0) FROM u)::int AS reads,
  (SELECT COUNT(DISTINCT principal_id) FROM u)::int AS principals,
  COALESCE((SELECT json_agg(m ORDER BY m.n DESC, m.principals DESC, m.atom_id) FROM m), '[]'::json) AS top_misses,
  COALESCE((SELECT json_agg(r ORDER BY r.n DESC, r.atom_id) FROM r), '[]'::json) AS top_reads`;

interface AtomCount {
	atom_id: string;
	n: number;
	principals: number;
}

function atomCounts(value: unknown): AtomCount[] {
	const rows = typeof value === "string" ? JSON.parse(value) : value;
	return Array.isArray(rows)
		? rows.map((r) => ({ atom_id: String(r.atom_id), n: Number(r.n), principals: Number(r.principals) }))
		: [];
}

export async function readKnowledgeReads(
	sql: Sql,
	params: { measure: KnowledgeReadMeasure },
	window: { start: string; end: string },
	signal: AbortSignal,
): Promise<MetricSample> {
	signal.throwIfAborted();
	const endAt = new Date(window.end);
	if (Number.isNaN(endAt.getTime())) throw new Error("invalid_window");
	const query = sql.unsafe(KNOWLEDGE_READS_SQL, [endAt.toISOString()]);
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
	const row: Record<string, unknown> = rows[0] ?? {};
	const day = String(row.day ?? "");
	const units = Number(row.units);
	const missUnits = Number(row.miss_units);
	const reads = Number(row.reads);
	const principals = Number(row.principals);
	const complete =
		rows.length === 1 &&
		/^\d{4}-\d{2}-\d{2}$/.test(day) &&
		[units, missUnits, reads, principals].every((n) => Number.isInteger(n) && n >= 0) &&
		missUnits <= units;
	const list = (items: AtomCount[]) => items.map((a) => `${a.atom_id}=${a.n}/${a.principals}p`).join(",");
	const sourceWatermarks = [
		{ source: "node.knowledge_read_daily", asOf: row.as_of ? new Date(row.as_of as string).toISOString() : null },
	];
	const evidenceRefs = [
		`node:knowledge_read_daily:day=${day}`,
		`node:knowledge_read_daily:units=${units}:miss_units=${missUnits}:reads=${reads}:principals=${principals}`,
		`node:knowledge_read_daily:top-misses(fails/principals):${list(atomCounts(row.top_misses))}`,
		`node:knowledge_read_daily:top-reads(reads/principals):${list(atomCounts(row.top_reads))}`,
	];
	if (params.measure === "read_units") {
		return { value: units, unit: "units", complete, sourceWatermarks, evidenceRefs };
	}
	if (!complete || units === 0) {
		return {
			value: 0,
			unit: "ratio",
			complete: false,
			sourceWatermarks,
			evidenceRefs,
			reason: complete ? "zero_denominator" : "incomplete_or_invalid_source",
		};
	}
	return { value: missUnits / units, unit: "ratio", complete, sourceWatermarks, evidenceRefs };
}

const knowledgeReadParams = z.strictObject({ measure: z.enum(KNOWLEDGE_READ_MEASURES) });

/** `knowledge.usage@1`: the read-miss KPI and its unit guardrail, over the node's own `knowledge_read_daily`. */
export function createKnowledgeUsageCalculator(sql: Sql): MetricCalculator {
	return {
		id: "knowledge.usage@1",
		// The reading is the last full UTC day before the window end, a pure function of that end.
		historicalWindows: true,
		unit: "ratio",
		unitFor: (params) => (knowledgeReadParams.parse(params).measure === "miss_share" ? "ratio" : "units"),
		display: "progress",
		displayFor: (params) => (knowledgeReadParams.parse(params).measure === "miss_share" ? "progress" : "volume"),
		windowSeconds: () => 86400,
		paramsSchema: knowledgeReadParams,
		budget: { timeoutMs: 15000, maxSourceCalls: 1, maxRows: 1, maxResponseBytes: 65536 },
		compute: async (params, ctx) => {
			const parsed = knowledgeReadParams.parse(params);
			return ctx.read((signal) => readKnowledgeReads(sql, parsed, ctx.window, signal));
		},
	};
}
