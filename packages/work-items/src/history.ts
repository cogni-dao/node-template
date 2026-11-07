// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/history`
 * Purpose: Change reasons and row-history shaping for work items (task.0052).
 * Scope: Pure functions. No I/O, no zod, no runtime configuration.
 * Invariants:
 *   - REASON_ONE_LINE: a reason never contains CR/LF, so it cannot forge a commit-message line.
 *   - NOTE_NOT_BODY: reasons live in the Dolt commit message, never in a work-item field.
 *   - ONE_VERSION_PER_CHANGE: adjacent diff rows with identical `to_` values collapse to the older row.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

export const CHANGE_REASON_MAX_CHARS = 512;
export const HISTORY_MAX_VERSIONS = 50;
/** Rows read per history call; the surplus absorbs merge repeats. */
export const HISTORY_READ_ROWS = 60;
export const HISTORY_VALUE_MAX_CHARS = 4096;

export class ChangeReasonInvalidError extends Error {
  constructor() {
    super(
      `reason must be 1-${CHANGE_REASON_MAX_CHARS} characters after line breaks become spaces`
    );
    this.name = "ChangeReasonInvalidError";
  }
}

/** Line breaks become spaces, then trim; undefined stays undefined. */
export function normalizeChangeReason(
  reason: string | undefined
): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = reason.replace(/[\r\n]+/g, " ").trim();
  if (normalized.length < 1 || normalized.length > CHANGE_REASON_MAX_CHARS) {
    throw new ChangeReasonInvalidError();
  }
  return normalized;
}

export interface HistoryFieldDiff {
  readonly before: unknown;
  readonly after: unknown;
  readonly truncated: boolean;
}

export interface HistoryEntry {
  readonly version: string;
  readonly commit: string;
  readonly at: string;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly changed: string[];
  readonly diff: Readonly<Record<string, HistoryFieldDiff>>;
}

/** One `dolt_diff_<table>` row joined to `dolt_log`, newest first. */
export interface HistoryDiffRow {
  readonly to_commit: string;
  readonly to_commit_date: unknown;
  readonly diff_type: string;
  readonly message: string | null;
  readonly committer: string | null;
  readonly [column: string]: unknown;
}

export interface ShapeHistoryOptions {
  /** Columns that change on every write and carry no meaning. */
  readonly ignored: ReadonlySet<string>;
  /** Version label for a row, e.g. its revision. */
  readonly version: (row: HistoryDiffRow) => string;
  readonly reasonAndActor: (row: HistoryDiffRow) => {
    reason: string | null;
    actor: string | null;
  };
}

/** Work-item commit: first line `work-items: <op> by actor:<p>`, optional `Reason: <r>` line. */
export function parseWorkItemCommitMessage(message: string | null): {
  reason: string | null;
  actor: string | null;
} {
  if (!message) return { reason: null, actor: null };
  const [first = "", ...rest] = message.split("\n");
  const actor = /by actor:([^ ]+)$/.exec(first)?.[1] ?? null;
  const reasonLine = rest.find((line) => line.startsWith("Reason: "));
  return { reason: reasonLine ? reasonLine.slice(8) : null, actor };
}

function bounded(value: unknown): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= HISTORY_VALUE_MAX_CHARS) return { value, truncated: false };
  return { value: text.slice(0, HISTORY_VALUE_MAX_CHARS), truncated: true };
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return String(a instanceof Date ? a.toISOString() : a) ===
      String(b instanceof Date ? b.toISOString() : b);
  }
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return (a ?? null) === (b ?? null);
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

const DIFF_META = new Set(["to_commit", "to_commit_date", "from_commit", "from_commit_date"]);

/** Row columns present in this node's diff table (schemas differ across nodes). */
export function historyColumns(rows: readonly Record<string, unknown>[]): string[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first)
    .filter((k) => k.startsWith("to_") && !DIFF_META.has(k) && k !== "to_id")
    .map((k) => k.slice(3));
}

/** Collapse merge repeats, list changed fields, newest first, capped. */
export function shapeHistory(
  rows: readonly HistoryDiffRow[],
  options: ShapeHistoryOptions
): HistoryEntry[] {
  const columns = historyColumns(rows);
  const kept: HistoryDiffRow[] = [];
  for (const row of rows) {
    if (row.to_commit === "WORKING") continue;
    const newer = kept[kept.length - 1];
    if (
      newer &&
      columns.every((c) => same(newer[`to_${c}`], row[`to_${c}`]))
    ) {
      // `row` is older with identical state: the newer row is a merge repeat.
      kept[kept.length - 1] = row;
      continue;
    }
    kept.push(row);
  }
  const entries: HistoryEntry[] = [];
  for (const row of kept) {
    const changed: string[] = [];
    const diff: Record<string, HistoryFieldDiff> = {};
    for (const column of columns) {
      if (options.ignored.has(column)) continue;
      const before = row[`from_${column}`];
      const after = row[`to_${column}`];
      if (row.diff_type !== "added" && same(before, after)) continue;
      if (row.diff_type === "added" && (after === null || after === undefined)) continue;
      changed.push(column);
      const b = bounded(before);
      const a = bounded(after);
      diff[column] = { before: b.value, after: a.value, truncated: b.truncated || a.truncated };
    }
    if (changed.length === 0) continue;
    const { reason, actor } = options.reasonAndActor(row);
    entries.push({
      version: options.version(row),
      commit: row.to_commit,
      at: iso(row.to_commit_date),
      actor,
      reason,
      changed,
      diff,
    });
    if (entries.length >= HISTORY_MAX_VERSIONS) break;
  }
  return entries;
}
