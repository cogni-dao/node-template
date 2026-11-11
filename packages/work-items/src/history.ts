// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/history`
 * Purpose: Change reasons and row-history shaping for work items (task.0052).
 * Scope: Pure functions. No I/O, no zod, no runtime configuration.
 * Invariants:
 *   - REASON_REQUIRED (task.0086): every work-item patch carries a reason: 1-240 characters, at most 25 words, no NUL.
 *   - REASON_ONE_LINE: CR, LF, U+0085, U+2028 and U+2029 become spaces, so a reason or a cite cannot forge a commit-message line.
 *   - CITES_ARE_PINS: a `Cites:` trailer holds only `id@commit` and `id@contribution:commit` pins; each line matches from its start.
 *   - NOTE_NOT_BODY: reasons live in the Dolt commit message, never in a work-item field.
 *   - ONE_VERSION_PER_CHANGE: adjacent diff rows with identical `to_` values collapse to the older row.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

import {
  CITE_COMMIT_PATTERN,
  CITE_CONTRIBUTION_PATTERN,
  CITE_ID_PATTERN,
} from "./cites.js";

export const CHANGE_REASON_MAX_CHARS = 240;
export const CHANGE_REASON_MAX_WORDS = 25;
export const HISTORY_MAX_VERSIONS = 50;
/** Rows read per history call; the surplus absorbs merge repeats. */
export const HISTORY_READ_ROWS = 60;
export const HISTORY_VALUE_MAX_CHARS = 4096;

/** The message of a missing reason; the 400 issue and the tool text use it byte for byte. */
export const CHANGE_REASON_REQUIRED_MESSAGE =
  "reason is required: one line that says why this change happens; it is stored in the item's history";

const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;

export type ChangeReasonCheck =
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly message: string };

/**
 * The one reason rule: line breaks become spaces, then trim, then 1-240
 * characters, at most 25 words (runs without whitespace), no NUL. The zod
 * schema and the adapter both call it, so they cannot drift.
 */
export function checkChangeReason(reason: unknown): ChangeReasonCheck {
  if (reason === undefined || reason === null) {
    return { ok: false, message: CHANGE_REASON_REQUIRED_MESSAGE };
  }
  if (typeof reason !== "string") {
    return { ok: false, message: "reason must be a string" };
  }
  if (reason.includes("\u0000")) {
    return { ok: false, message: "reason must not contain a NUL character" };
  }
  const normalized = reason.replace(LINE_BREAKS, " ").trim();
  if (normalized.length < 1) {
    return { ok: false, message: CHANGE_REASON_REQUIRED_MESSAGE };
  }
  if (normalized.length > CHANGE_REASON_MAX_CHARS) {
    return {
      ok: false,
      message: `reason must be at most ${CHANGE_REASON_MAX_CHARS} characters on one line`,
    };
  }
  if (normalized.split(/\s+/).length > CHANGE_REASON_MAX_WORDS) {
    return {
      ok: false,
      message: `reason must be at most ${CHANGE_REASON_MAX_WORDS} words`,
    };
  }
  return { ok: true, reason: normalized };
}

export class ChangeReasonInvalidError extends Error {
  readonly code = "reason_invalid" as const;
  constructor(message: string = CHANGE_REASON_REQUIRED_MESSAGE) {
    super(message);
    this.name = "ChangeReasonInvalidError";
  }
}

/** The normalized reason; throws `ChangeReasonInvalidError` when it is missing or breaks a cap. */
export function normalizeChangeReason(reason: string | undefined): string {
  const checked = checkChangeReason(reason);
  if (!checked.ok) throw new ChangeReasonInvalidError(checked.message);
  return checked.reason;
}

export interface HistoryFieldDiff {
  readonly before: unknown;
  readonly after: unknown;
  readonly truncated: boolean;
}

/** A cite pinned to the commit that held the atom when the change was written. */
export interface HistoryCite {
  readonly id: string;
  readonly commit: string;
  readonly contribution?: string | undefined;
}

export interface HistoryEntry {
  readonly version: string;
  readonly commit: string;
  readonly at: string;
  readonly actor: string | null;
  readonly reason: string | null;
  readonly cites: HistoryCite[];
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
    cites?: HistoryCite[];
  };
}

/**
 * Work-item commit: first line `work-items: <op> by actor:<p>`, optional
 * `Reason: <r>` line, optional last `Cites: id@commit, id@contrib-x:commit`
 * line. Each line matches from its start, and a reason or cite holds no line
 * break, so neither can forge another line.
 */
export function parseWorkItemCommitMessage(message: string | null): {
  reason: string | null;
  actor: string | null;
  cites: HistoryCite[];
} {
  if (!message) return { reason: null, actor: null, cites: [] };
  const [first = "", ...rest] = message.split("\n");
  const actor = /by actor:([^ ]+)$/.exec(first)?.[1] ?? null;
  const reasonLine = rest.find((line) => line.startsWith("Reason: "));
  const citesLine = rest.find((line) => line.startsWith("Cites: "));
  return {
    reason: reasonLine ? reasonLine.slice(8) : null,
    actor,
    cites: citesLine ? parseCitesTrailer(citesLine.slice(7)) : [],
  };
}

const CITE_PIN = new RegExp(
  `^(${CITE_ID_PATTERN.source.slice(1, -1)})@(?:(${CITE_CONTRIBUTION_PATTERN.source.slice(1, -1)}):)?(${CITE_COMMIT_PATTERN.source.slice(1, -1)})$`
);

/** `id@commit, id@contrib-x:commit` to pins; an entry that is not a pin is dropped. */
export function parseCitesTrailer(value: string): HistoryCite[] {
  const cites: HistoryCite[] = [];
  for (const part of value.split(",")) {
    const match = CITE_PIN.exec(part.trim());
    if (!match) continue;
    const [, id, contribution, commit] = match;
    cites.push({
      id: id as string,
      commit: commit as string,
      ...(contribution ? { contribution } : {}),
    });
  }
  return cites;
}

/** The `Cites:` trailer value for resolved pins, in request order. */
export function formatCitesTrailer(cites: readonly HistoryCite[]): string {
  return cites
    .map((c) =>
      c.contribution
        ? `${c.id}@${c.contribution}:${c.commit}`
        : `${c.id}@${c.commit}`
    )
    .join(", ");
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
    const { reason, actor, cites } = options.reasonAndActor(row);
    entries.push({
      version: options.version(row),
      commit: row.to_commit,
      at: iso(row.to_commit_date),
      actor,
      reason,
      cites: cites ?? [],
      changed,
      diff,
    });
    if (entries.length >= HISTORY_MAX_VERSIONS) break;
  }
  return entries;
}
