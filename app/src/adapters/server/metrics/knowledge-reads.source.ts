// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Module: knowledge-reads.source
 * Purpose: Goal-metric source over this node's write-time read counters (knowledge_read_daily): the share of
 * (principal, atom) units whose reads all missed, and the unit count that guards it (story.0061).
 * Scope: one bounded static SQL read per compute over one UTC day; aggregates and top-10 atom ids only, never
 * principal ids.
 * Invariants:
 * - LAST_FULL_DAY: the reading covers the last full UTC day before the window end, and names it in evidence.
 * - UNIT_IS_DISTINCT: a unit is one (principal, atom) for the day, summed across classes; retries count once.
 * Links: https://node-template.cognidao.org/knowledge/knowledge-usage-telemetry
 */
import type { MetricSample } from "@cogni-dao/metrics/contracts";
import type { Sql } from "postgres";

export const KNOWLEDGE_READ_MEASURES = ["miss_share", "read_units"] as const;
export type KnowledgeReadMeasure = (typeof KNOWLEDGE_READ_MEASURES)[number];

interface AtomCount {
  atom_id: string;
  n: number;
  principals: number;
}

function endOrThrow(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_window");
  return at.toISOString();
}

function atomCounts(value: unknown): AtomCount[] {
  const rows = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(rows)
    ? rows.map((r) => ({ atom_id: String(r.atom_id), n: Number(r.n), principals: Number(r.principals) }))
    : [];
}

/** One statement: the day's units, its miss units, and the top missed and top read atoms. */
export const KNOWLEDGE_READS_SQL = `WITH d AS (SELECT (($1::timestamptz) - interval '1 day')::date AS day),
u AS (
  SELECT k.principal_id, k.atom_id, SUM(k.ok_count)::int AS ok, SUM(k.fail_count)::int AS fail
  FROM knowledge_read_daily k, d WHERE k.day = d.day
  GROUP BY k.principal_id, k.atom_id
),
m AS (
  SELECT atom_id, SUM(fail)::int AS n, COUNT(*)::int AS principals FROM u
  WHERE ok = 0 AND fail > 0 GROUP BY atom_id ORDER BY n DESC, principals DESC, atom_id LIMIT 10
),
r AS (
  SELECT atom_id, SUM(ok)::int AS n, COUNT(*)::int AS principals FROM u
  WHERE ok > 0 GROUP BY atom_id ORDER BY n DESC, atom_id LIMIT 10
)
SELECT (SELECT day FROM d)::text AS day, NOW() AS as_of,
  (SELECT COUNT(*) FROM u)::int AS units,
  (SELECT COUNT(*) FROM u WHERE ok = 0 AND fail > 0)::int AS miss_units,
  (SELECT COALESCE(SUM(ok + fail), 0) FROM u)::int AS reads,
  (SELECT COUNT(DISTINCT principal_id) FROM u)::int AS principals,
  COALESCE((SELECT json_agg(m) FROM m), '[]'::json) AS top_misses,
  COALESCE((SELECT json_agg(r) FROM r), '[]'::json) AS top_reads`;

export async function readKnowledgeReads(
  sql: Sql,
  params: { measure: KnowledgeReadMeasure },
  window: { start: string; end: string },
  signal: AbortSignal,
): Promise<MetricSample> {
  signal.throwIfAborted();
  const end = endOrThrow(window.end);
  const query = sql.unsafe(KNOWLEDGE_READS_SQL, [end]);
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
