// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Module: knowledge-merges.source
 * Purpose: Goal-metric source reader over this node's knowledge_contributions
 * table in Doltgres main: merges in the window and the share a resolver other
 * than the author merged.
 * Scope: one bounded SQL read per compute; counts only, never per-contribution rows.
 * Links: https://node-template.cognidao.org/work/items/task.0131
 */
import type { MetricSample } from "@cogni-dao/metrics/contracts";
import type { Sql } from "postgres";

export type KnowledgeMergeOutput = "share" | "merged";

/** Window edges come from the metrics engine; reject anything that is not an instant. */
function isoOrThrow(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_window");
  return at.toISOString();
}

/**
 * Static SQL with the window in the text (Doltgres), one statement. A merge is
 * state = 'merged' with resolved_at inside [start, end). `reviewed` counts
 * merges whose resolver differs from the author (resolved_by <> principal_id);
 * `unresolved` counts merges with no resolver, which neither prove nor disprove
 * review, so a share over them is unknown rather than guessed.
 */
export async function readKnowledgeMerges(
  sql: Sql,
  output: KnowledgeMergeOutput,
  window: { start: string; end: string },
  signal: AbortSignal,
): Promise<MetricSample> {
  signal.throwIfAborted();
  const start = isoOrThrow(window.start);
  const end = isoOrThrow(window.end);
  const merged = `state = 'merged' AND resolved_at >= '${start}' AND resolved_at < '${end}'`;
  const query = sql.unsafe(
    `SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
      (SELECT COUNT(*) FROM knowledge_contributions WHERE ${merged}) AS merged,
      (SELECT COUNT(*) FROM knowledge_contributions WHERE ${merged} AND resolved_by <> principal_id) AS reviewed,
      (SELECT COUNT(*) FROM knowledge_contributions WHERE ${merged} AND resolved_by IS NULL) AS unresolved`,
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
  const row: Record<string, unknown> = rows[0] ?? {};
  const merges = Number(row.merged);
  const reviewed = Number(row.reviewed);
  const unresolved = Number(row.unresolved);
  const counted =
    rows.length === 1 &&
    [merges, reviewed, unresolved].every((n) => Number.isInteger(n) && n >= 0) &&
    reviewed + unresolved <= merges;
  const asOfMs = Date.parse(String(row.as_of ?? ""));
  const sourceWatermarks = [
    {
      source: "node.doltgres.main",
      asOf: Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null,
    },
  ];
  const evidenceRefs = [
    `node:knowledge_contributions:window-resolved_at:${start}..${end}`,
    `counts:merged=${merges};reviewed=${reviewed};unresolved=${unresolved}`,
  ];
  if (output === "merged") {
    return {
      value: merges,
      unit: "items",
      complete: counted,
      sourceWatermarks,
      evidenceRefs,
      ...(counted ? {} : { reason: "incomplete_or_invalid_source" as const }),
    };
  }
  if (!counted || unresolved > 0) {
    return {
      value: 0,
      unit: "ratio",
      complete: false,
      sourceWatermarks,
      evidenceRefs,
      reason: "incomplete_or_invalid_source",
    };
  }
  if (merges === 0) {
    return {
      value: 0,
      unit: "ratio",
      complete: false,
      sourceWatermarks,
      evidenceRefs,
      reason: "zero_denominator",
    };
  }
  return {
    value: reviewed / merges,
    unit: "ratio",
    complete: true,
    sourceWatermarks,
    evidenceRefs,
  };
}
