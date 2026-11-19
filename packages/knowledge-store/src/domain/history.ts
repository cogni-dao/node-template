// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/history`
 * Purpose: Shape one knowledge entry's Dolt diff rows into versions with their change reasons (task.0052).
 * Scope: Pure functions. No I/O.
 * Invariants:
 *   - REASON_IS_COMMIT_MESSAGE: a version's reason is its contribution commit message, else for an attributed direct commit the first line of its Dolt commit message without the `by actor:` suffix (the trailer lines never become the reason), else the whole cleaned Dolt message.
 *   - ATTRIBUTION_FROM_THE_COMMIT (task.0133): a direct write's actor is the first line's `by actor:`; `Requested-by:` and `Run:` lines give `requestedBy` and `run`. Each line matches only from its start.
 *   - ONE_VERSION_PER_CHANGE: adjacent rows with identical `to_` values collapse to the older (branch) row.
 *   - Same item shape as `@cogni/work-items` history, so both planes serve one contract.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

export const KNOWLEDGE_HISTORY_MAX_VERSIONS = 50;
export const KNOWLEDGE_HISTORY_READ_ROWS = 60;
const VALUE_MAX_CHARS = 4096;

/** Columns that change with every write and carry no meaning. */
const IGNORED = new Set(["updated_at"]);

const DIFF_META = new Set(["to_commit", "to_commit_date", "from_commit", "from_commit_date"]);

/** Entry columns present in this node's diff table (schemas differ across nodes). */
export function historyColumns(rows: readonly Record<string, unknown>[]): string[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first)
    .filter((k) => k.startsWith("to_") && !DIFF_META.has(k) && k !== "to_id")
    .map((k) => k.slice(3));
}

export interface KnowledgeHistoryEntry {
  readonly version: string;
  readonly commit: string;
  readonly at: string;
  readonly actor: string | null;
  /** The node run's subject (`Requested-by:`); absent for a write no run made. */
  readonly requestedBy?: string;
  /** The run that wrote it (`Run:`); absent for a direct write. */
  readonly run?: { readonly id: string; readonly kind: "user_immediate" | "system_scheduled" | "system_webhook" };
  readonly reason: string | null;
  /** Always `[]`: one history shape across planes (task.0086). */
  readonly cites: readonly {
    id: string;
    commit: string;
    contribution?: string | undefined;
  }[];
  readonly changed: string[];
  readonly diff: Readonly<
    Record<string, { before: unknown; after: unknown; truncated: boolean }>
  >;
}

export interface KnowledgeHistoryRow {
  readonly to_commit: string;
  readonly to_commit_date: unknown;
  readonly diff_type: string;
  readonly message: string | null;
  readonly committer: string | null;
  readonly contribution_message: string | null;
  readonly contribution_principal: string | null;
  readonly [column: string]: unknown;
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v ?? null) : (v ?? null);
  return norm(a) === norm(b);
}

function bounded(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= VALUE_MAX_CHARS
    ? { value, truncated: false }
    : { value: text.slice(0, VALUE_MAX_CHARS), truncated: true };
}

const RUN_KINDS = ["user_immediate", "system_scheduled", "system_webhook"] as const;
type RunKind = (typeof RUN_KINDS)[number];
const RUN_LINE = new RegExp(`^Run: (\\S+) (${RUN_KINDS.join("|")})$`);

/**
 * A direct (non-contribution) Dolt commit message: the first line is `<what> by actor:<actor>` (engine bookkeeping lines such as
 * `operation: …` are dropped); `Requested-by:` and `Run:` lines follow. The reason is the first line without its actor suffix.
 */
function parseDirectMessage(message: string | null): {
  reason: string | null;
  actor: string | null;
  requestedBy?: string;
  run?: { id: string; kind: RunKind };
} {
  if (!message) return { reason: null, actor: null };
  const kept = message.split("\n").filter((line) => !line.startsWith("operation:"));
  const [first = "", ...rest] = kept;
  const actor = / by actor:([^ ]+)$/.exec(first)?.[1] ?? null;
  // Only an attributed commit becomes first-line-only; any other message keeps its whole cleaned text as the reason.
  const reason = actor
    ? first.replace(/ by actor:[^ ]+$/, "").trim() || null
    : kept.join("\n").trim() || null;
  const requestedBy = rest
    .find((line) => line.startsWith("Requested-by: "))
    ?.slice("Requested-by: ".length);
  const runMatch = rest.map((line) => RUN_LINE.exec(line)).find((match) => match !== null);
  return {
    reason,
    actor,
    ...(requestedBy ? { requestedBy } : {}),
    ...(runMatch ? { run: { id: runMatch[1] as string, kind: runMatch[2] as RunKind } } : {}),
  };
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Rows newest first → versions newest first, capped. */
export function shapeKnowledgeHistory(
  rows: readonly KnowledgeHistoryRow[]
): KnowledgeHistoryEntry[] {
  const columns = historyColumns(rows);
  const kept: KnowledgeHistoryRow[] = [];
  for (const row of rows) {
    if (row.to_commit === "WORKING") continue;
    const newer = kept[kept.length - 1];
    if (
      newer &&
      columns.every((c) => same(newer[`to_${c}`], row[`to_${c}`]))
    ) {
      kept[kept.length - 1] = row;
      continue;
    }
    kept.push(row);
  }
  const entries: KnowledgeHistoryEntry[] = [];
  for (const row of kept) {
    const changed: string[] = [];
    const diff: Record<string, { before: unknown; after: unknown; truncated: boolean }> = {};
    for (const column of columns) {
      if (IGNORED.has(column)) continue;
      const before = row[`from_${column}`];
      const after = row[`to_${column}`];
      if (row.diff_type === "added" ? after === null || after === undefined : same(before, after)) continue;
      changed.push(column);
      const b = bounded(before);
      const a = bounded(after);
      diff[column] = { before: b.value, after: a.value, truncated: b.truncated || a.truncated };
    }
    if (changed.length === 0) continue;
    const direct = parseDirectMessage(row.message);
    entries.push({
      version: String(row.to_source_ref ?? row.to_commit.slice(0, 12)),
      commit: row.to_commit,
      at: iso(row.to_commit_date),
      actor: row.contribution_principal ?? direct.actor ?? row.committer ?? null,
      ...(direct.requestedBy ? { requestedBy: direct.requestedBy } : {}),
      ...(direct.run ? { run: direct.run } : {}),
      reason: row.contribution_message ?? direct.reason,
      cites: [],
      changed,
      diff,
    });
    if (entries.length >= KNOWLEDGE_HISTORY_MAX_VERSIONS) break;
  }
  return entries;
}
