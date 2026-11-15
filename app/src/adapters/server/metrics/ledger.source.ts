// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Module: ledger.source
 * Purpose: Goal-metric source reader over this node's work ledger: validated
 * work (done + deploy_verified inside the window, either order) attributed to
 * its work author — the actor of the latest authored needs_merge transition
 * (hub: work-author). Merge-commit repeats carry no actor and never supersede.
 * Scope: bounded windowed reads; classes internal / non-internal /
 * unclassified until the Via attribution trailer stamps credential kind.
 * Links: https://node-template.cognidao.org/knowledge/usage-metrics-design
 */
import type { MetricSample } from "@cogni-dao/metrics/contracts";
import { parseWorkItemCommitMessage } from "@cogni/work-items";
import type { Sql } from "postgres";

export const WORK_AUTHOR_CLASSES = [
  "internal",
  "non-internal",
  "unclassified",
  "all",
] as const;
export type WorkAuthorClass = (typeof WORK_AUTHOR_CLASSES)[number];
export type WorkAuthorMode = "count" | "share";

/** Row cap per query; a capped read is incomplete, never silently truncated. */
export const LEDGER_MAX_ROWS = 500;

/** Window edges come from the metrics engine; reject anything that is not an instant. */
function isoOrThrow(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_window");
  return at.toISOString();
}

/** Zone-less UTC literal for Dolt timestamp columns, as the package sources use. */
function doltUtcLiteral(iso: string): string {
  return iso.replace("T", " ").replace("Z", "");
}

/** Mirrors the package's synthetic-fixture exclusion (not exported from @cogni-dao/metrics). */
function syntheticLabels(column: string): string {
  return `(${column} IS NULL OR (CAST(${column} AS TEXT) NOT LIKE '%"test-fixture"%' AND CAST(${column} AS TEXT) NOT LIKE '%"synthetic"%' AND CAST(${column} AS TEXT) NOT LIKE '%"synthetic-fixture"%'))`;
}

function escapeId(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

type Read = <T>(source: (signal: AbortSignal) => Promise<T>) => Promise<T>;

async function runQuery(
  sql: Sql,
  text: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  signal.throwIfAborted();
  const query = sql.unsafe(text);
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
  return rows as unknown as Record<string, unknown>[];
}

/**
 * One sample: validated task/bug items in [start, end) by work-author class.
 * Four bounded reads: clock, internal principals (service Postgres), validated
 * transitions in the window, then needs_merge transitions for only those ids.
 * An item with no authored needs_merge transition stays unclassified; the
 * pre-trailer ledger cannot tell external agents from humans, so readings are
 * a lower bound on internal authorship.
 */
export async function readValidatedByAuthor(
  doltSql: Sql,
  principalsSql: Sql,
  params: { author: WorkAuthorClass; mode: WorkAuthorMode },
  window: { start: string; end: string },
  read: Read,
): Promise<MetricSample> {
  const start = doltUtcLiteral(isoOrThrow(window.start));
  const end = doltUtcLiteral(isoOrThrow(window.end));
  const clockRows = await read((signal) =>
    runQuery(doltSql, "SELECT NOW() AS as_of", signal),
  );
  const asOfRaw = clockRows[0]?.as_of;
  const asOf = asOfRaw ? new Date(asOfRaw as string).toISOString() : null;
  const internalRows = await read((signal) =>
    runQuery(
      principalsSql,
      "SELECT user_id FROM agent_principals WHERE kind = 'internal'",
      signal,
    ),
  );
  const internal = new Set(internalRows.map((r) => String(r.user_id)));
  // Either order counts: done then verify, or verify then done (convergence precedent).
  const validatedRows = await read((signal) =>
    runQuery(
      doltSql,
      `SELECT d.to_id AS id FROM dolt_diff_work_items d WHERE d.to_commit <> 'WORKING' AND d.to_commit_date >= '${start}' AND d.to_commit_date < '${end}' AND d.to_status = 'done' AND d.to_deploy_verified = true AND (d.from_id IS NULL OR d.from_status IS DISTINCT FROM 'done' OR d.from_deploy_verified IS DISTINCT FROM true) AND d.to_type IN ('task','bug') AND ${syntheticLabels("d.to_labels")} LIMIT ${LEDGER_MAX_ROWS + 1}`,
      signal,
    ),
  );
  const ids = new Set(validatedRows.map((r) => String(r.id)));
  const authorById = new Map<string, string | null>();
  let authorsCapped = false;
  if (ids.size > 0) {
    const authorRows = await read((signal) =>
      runQuery(
        doltSql,
        `SELECT d.to_id AS id, CAST(d.to_commit_date AS TEXT) AS at, l.message AS message FROM dolt_diff_work_items d JOIN dolt_log l ON l.commit_hash = d.to_commit WHERE d.to_commit <> 'WORKING' AND d.to_id IN (${[...ids].map(escapeId).join(", ")}) AND d.to_status = 'needs_merge' AND (d.from_id IS NULL OR d.from_status IS DISTINCT FROM 'needs_merge') AND l.message LIKE 'work-items: %' ORDER BY d.to_commit_date, d.to_commit LIMIT ${LEDGER_MAX_ROWS + 1}`,
        signal,
      ),
    );
    authorsCapped = authorRows.length > LEDGER_MAX_ROWS;
    const latest = new Map<string, string>();
    for (const row of authorRows) {
      const id = String(row.id);
      const at = String(row.at ?? "");
      if (!ids.has(id)) continue;
      const actor = parseWorkItemCommitMessage(String(row.message ?? "")).actor;
      // A row without an actor (merge repeat) never supersedes an authored one.
      if (actor === null) continue;
      const prev = latest.get(id);
      // Rows arrive ordered (at, commit); equal-or-later authored rows win.
      if (prev !== undefined && prev > at) continue;
      latest.set(id, at);
      authorById.set(id, actor);
    }
  }
  let internalCount = 0;
  let nonInternal = 0;
  let unclassified = 0;
  for (const id of ids) {
    const actor = authorById.get(id) ?? null;
    if (actor === null) unclassified += 1;
    else if (internal.has(actor)) internalCount += 1;
    else nonInternal += 1;
  }
  const total = ids.size;
  const byClass: Record<WorkAuthorClass, number> = {
    all: total,
    internal: internalCount,
    "non-internal": nonInternal,
    unclassified,
  };
  const capped = validatedRows.length > LEDGER_MAX_ROWS || authorsCapped;
  const complete = clockRows.length === 1 && asOf !== null && !capped;
  const sourceWatermarks = [
    { source: "node.work_items.dolt_history", asOf },
    { source: "node.agent_principals", asOf },
  ];
  const evidenceRefs = [
    `node:work_items:validated-by-author:window:${start}..${end}`,
    `node:work_items:validated-by-author:counts:total=${total}:internal=${internalCount}:non-internal=${nonInternal}:unclassified=${unclassified}${capped ? ":capped" : ""}`,
  ];
  const selected = byClass[params.author];
  if (params.mode === "count") {
    return {
      value: selected,
      unit: "items",
      complete,
      sourceWatermarks,
      evidenceRefs,
      ...(complete ? {} : { reason: "incomplete_or_invalid_source" as const }),
    };
  }
  if (!complete || total === 0) {
    return {
      value: 0,
      unit: "ratio",
      complete: false,
      sourceWatermarks,
      evidenceRefs,
      reason: complete ? "zero_denominator" : "incomplete_or_invalid_source",
    };
  }
  return {
    value: selected / total,
    unit: "ratio",
    complete,
    sourceWatermarks,
    evidenceRefs,
  };
}
