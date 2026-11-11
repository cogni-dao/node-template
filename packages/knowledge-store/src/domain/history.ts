// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/history`
 * Purpose: Shape one knowledge entry's Dolt diff rows into versions with their change reasons (task.0052).
 * Scope: Pure functions. No I/O.
 * Invariants:
 *   - REASON_IS_COMMIT_MESSAGE: a version's reason is its contribution commit message, else its Dolt commit message.
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

/** Drop engine bookkeeping lines (`operation: …`) from a Dolt commit message. */
function cleanMessage(message: string | null): string | null {
  if (!message) return null;
  const text = message
    .split("\n")
    .filter((line) => !line.startsWith("operation:"))
    .join("\n")
    .trim();
  return text || null;
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
    entries.push({
      version: String(row.to_source_ref ?? row.to_commit.slice(0, 12)),
      commit: row.to_commit,
      at: iso(row.to_commit_date),
      actor: row.contribution_principal ?? row.committer ?? null,
      reason: row.contribution_message ?? cleanMessage(row.message),
      cites: [],
      changed,
      diff,
    });
    if (entries.length >= KNOWLEDGE_HISTORY_MAX_VERSIONS) break;
  }
  return entries;
}
