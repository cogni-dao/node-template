// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Module: runs.source
 * Purpose: Goal-metric source reader over this node's own graph_runs ledger:
 * run counts by caller class (human, system, bearer-agent, unclassified).
 * Scope: one bounded SQL read per compute; aggregates only, never per-user rows.
 * Links: https://node-template.cognidao.org/knowledge/usage-metrics-design
 */
import type { MetricSample } from "@cogni-dao/metrics/contracts";
import type { Sql } from "postgres";

export const RUN_CALLER_CLASSES = [
  "human",
  "system",
  "bearer-agent",
  "unclassified",
  "agent",
  "all",
] as const;
export type RunCallerClass = (typeof RUN_CALLER_CLASSES)[number];
export type RunCountMode = "count" | "share";

/** Window edges come from the metrics engine; reject anything that is not an instant. */
function isoOrThrow(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_window");
  return at.toISOString();
}

/**
 * One statement; classes are mutually exclusive and sum to total.
 * user_immediate splits by requester: an agent_principals row means a bearer
 * agent; a users row with a wallet means a SIWE human; the rest (the seeded
 * system user, legacy HMAC keys) stays unclassified by design, so a large
 * unclassified share is a finding about identity, not a metric defect.
 */
export async function readRunsByCaller(
  sql: Sql,
  params: { class: RunCallerClass; mode: RunCountMode },
  window: { start: string; end: string },
  signal: AbortSignal,
): Promise<MetricSample> {
  signal.throwIfAborted();
  const start = isoOrThrow(window.start);
  const end = isoOrThrow(window.end);
  const query = sql.unsafe(
    `SELECT NOW() AS as_of,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE gr.run_kind IN ('system_scheduled','system_webhook'))::int AS system,
      COUNT(*) FILTER (WHERE gr.run_kind = 'user_immediate' AND ap.user_id IS NOT NULL)::int AS bearer_agent,
      COUNT(*) FILTER (WHERE gr.run_kind = 'user_immediate' AND ap.user_id IS NULL AND u.wallet_address IS NOT NULL)::int AS human
    FROM graph_runs gr
    LEFT JOIN agent_principals ap ON ap.user_id = gr.requested_by
    LEFT JOIN users u ON u.id = gr.requested_by
    WHERE gr.started_at >= '${start}' AND gr.started_at < '${end}'`,
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
  const total = Number(row.total);
  const system = Number(row.system);
  const bearer = Number(row.bearer_agent);
  const human = Number(row.human);
  const complete =
    rows.length === 1 && [total, system, bearer, human].every(Number.isFinite);
  const unclassified = total - system - bearer - human;
  const byClass: Record<RunCallerClass, number> = {
    all: total,
    system,
    "bearer-agent": bearer,
    human,
    unclassified,
    agent: system + bearer,
  };
  const sourceWatermarks = [
    {
      source: "node.graph_runs",
      asOf: row.as_of ? new Date(row.as_of as string).toISOString() : null,
    },
  ];
  const evidenceRefs = [
    `node:graph_runs:window-started_at:${start}..${end}`,
    `node:graph_runs:counts:total=${total}:system=${system}:bearer-agent=${bearer}:human=${human}:unclassified=${unclassified}`,
  ];
  const selected = byClass[params.class];
  if (params.mode === "count") {
    return { value: selected, unit: "runs", complete, sourceWatermarks, evidenceRefs };
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
