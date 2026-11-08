// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/brief-steward/reconcile-check`
 * Purpose: The pure guard of the brief steward. A model proposes new `summary` and `outcome` text; this
 *   function alone decides whether the host may write it (hub brief-steward-design, section 3).
 * Scope: Pure and deterministic. No I/O, no clock (`now` is injected), no model. History is injected; an
 *   absent history fails `recent` closed. Does not write anything and does not read the store.
 * Invariants:
 *   - FIRST_FAILURE_WRITES_NOTHING: guards run in a fixed order and the first failure ends the check
 *   - APPROVED_LINES_UNTOUCHED: `Goal =` and `Done when =` lines must match in text, count and order
 *   - NOTHING_LOST: no URL, item id or PR number of the old text may disappear; the only new URL is the
 *     item's own `/history` route
 *   - RETAIN_80: at least 80% of the old distinct tokens survive (tokenizer `brief-steward-tokens@1`: lowercase
 *     runs of Unicode letters or digits; stopwords below dropped; approved lines are not tokens)
 *   - FEWER_VIOLATIONS: the proposal breaks no rule the old text did not, and removes at least one
 *     agent-fixable rule. The model never states the reason; it is built from the removed rule codes
 *   - FAIL_CLOSED: missing KPI, read, or history is a rejection, never a pass
 * Side-effects: none
 * Links: hub brief-steward-design, hub program-behavior-mode
 * @public
 */

import {
  APPROVED_LINE,
  type AgentFixableRule,
  isAgentFixable,
  MAX_FIELD_CHARS,
  scoreBrief,
} from "@cogni-dao/metrics/briefs";

/** Guard codes in the order the checks run. */
export const GUARD_CODES = [
  "fields",
  "kpi",
  "read",
  "recent",
  "clean",
  "approved",
  "links",
  "progress",
  "retain",
  "fewer",
  "budget",
] as const;
export type GuardCode = (typeof GUARD_CODES)[number];

export const MAX_WRITES_PER_RUN = 3;
export const RECENT_DAYS = 7;
export const RECONCILE_REASON_PREFIX = "reconcile brief:";
/** Version label of the token rule below; a change to the list or the split is a new version. */
export const STEWARD_TOKENS_VERSION = "brief-steward-tokens@1";
/** Dropped from the token sets; no other word is exempt. */
export const RETAIN_STOPWORDS: ReadonlySet<string> = new Set(
  "a an and are as at be by for from in is it of on or that the to was with".split(
    " ",
  ),
);
const RETAIN_NUMERATOR = 4;
const RETAIN_DENOMINATOR = 5;
const CLOSED = new Set(["done", "cancelled"]);
const PROPOSAL_KEYS = new Set(["id", "expectedRevision", "summary", "outcome"]);

/** The item as the run read it. */
export interface BriefItem {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly summary: string;
  readonly outcome: string;
}
/** What the model may propose: text of two fields, for one revision. */
export interface BriefProposal {
  readonly id: string;
  readonly expectedRevision: number;
  readonly summary: string;
  readonly outcome: string;
}
/** One version of the item's history, newest first in the list; values are never needed. */
export interface HistoryVersion {
  readonly at: string;
  readonly reason: string | null;
}
/** The KPI reading of this run: its state and the ids of its `worst` rows. */
export interface KpiReading {
  readonly ok: boolean;
  readonly worst: readonly string[];
}
/** Run-level facts the guard needs besides the item. */
export interface RunState {
  readonly kpi: KpiReading | undefined;
  /** Writes this run already made. */
  readonly writes: number;
  /** Ids this run already wrote. */
  readonly written: ReadonlySet<string>;
  /** Node public origin; the item's own `/history` URL is built from it. */
  readonly origin: string;
}

export type ReconcileResult =
  | {
      readonly ok: true;
      /** `reconcile brief: <removed rule codes>`; built here, never by the model. */
      readonly reason: string;
      readonly removed: readonly AgentFixableRule[];
    }
  | { readonly ok: false; readonly code: GuardCode };

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;
const ITEM_ID_PATTERN = /\b(?:story|task|bug|spike|subtask)\.\d+\b/g;
const PR_PATTERN = /(?:#|\bPR\s*#?\s*)(\d+)\b/gi;
const CHECKED_BOX = /\[[xX]\]/g;
const TOKEN = /[\p{L}\p{N}]+/gu;

/** The `Goal =` and `Done when =` lines of an outcome, in order, byte for byte. */
function approvedLines(outcome: string): string[] {
  return outcome
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => APPROVED_LINE.test(line));
}

/** Everything a reader may follow: URLs, item ids and PR numbers of a text. */
function linksOf(text: string): { urls: Set<string>; refs: Set<string> } {
  const urls = new Set(
    (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")),
  );
  const refs = new Set<string>(text.match(ITEM_ID_PATTERN) ?? []);
  for (const m of text.matchAll(PR_PATTERN)) refs.add(`pr:${m[1]}`);
  return { urls, refs };
}

/** Distinct tokens of the text outside approved lines. */
export function retainTokens(text: string): Set<string> {
  const body = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !APPROVED_LINE.test(line))
    .join("\n")
    .toLowerCase();
  return new Set(
    (body.match(TOKEN) ?? []).filter((t) => !RETAIN_STOPWORDS.has(t)),
  );
}

const fail = (code: GuardCode): ReconcileResult => ({ ok: false, code });

/**
 * Decide whether `proposed` may replace `old`. `old` is the item as read this run (undefined when it was
 * not read); `history` lists its versions newest first (undefined when the port has no history);
 * `now` is the injected clock.
 */
export function reconcileCheck(
  old: BriefItem | undefined,
  proposed: BriefProposal,
  maxLongShare: number,
  history: readonly HistoryVersion[] | undefined,
  now: number | Date,
  run: RunState,
): ReconcileResult {
  // fields: two strings, within the cap, and nothing else (a title or status change is not a proposal).
  const extra = Object.keys(proposed).some((k) => !PROPOSAL_KEYS.has(k));
  if (
    extra ||
    typeof proposed.id !== "string" ||
    !proposed.id ||
    !Number.isInteger(proposed.expectedRevision) ||
    typeof proposed.summary !== "string" ||
    typeof proposed.outcome !== "string" ||
    proposed.summary.length > MAX_FIELD_CHARS ||
    proposed.outcome.length > MAX_FIELD_CHARS
  )
    return fail("fields");

  // kpi: the reading is ok and names this item among its worst rows.
  if (!run.kpi?.ok || !run.kpi.worst.includes(proposed.id)) return fail("kpi");

  // read: this run read this item at this revision, and it is open.
  if (
    !old ||
    old.id !== proposed.id ||
    old.revision !== proposed.expectedRevision ||
    CLOSED.has(old.status)
  )
    return fail("read");

  // recent: a steward rewrite in the last 7 days stands unless someone else changed the item since.
  if (!history) return fail("recent");
  const newest = history[0];
  if (newest?.reason?.startsWith(RECONCILE_REASON_PREFIX)) {
    const at = Date.parse(newest.at);
    const age = (typeof now === "number" ? now : now.getTime()) - at;
    if (!Number.isFinite(at) || age < RECENT_DAYS * 86_400_000)
      return fail("recent");
  }

  // clean: the live text must break at least one agent-fixable rule, or there is nothing to fix.
  const before = scoreBrief(
    "items",
    { title: old.title, summary: old.summary, outcome: old.outcome },
    maxLongShare,
  );
  if (!before.broken.some(isAgentFixable)) return fail("clean");

  // approved: the human-approved lines are identical in text, count and order.
  const keptLines = approvedLines(old.outcome);
  const newLines = approvedLines(proposed.outcome);
  if (
    keptLines.length !== newLines.length ||
    keptLines.some((line, i) => line !== newLines[i])
  )
    return fail("approved");

  // links: nothing a reader can follow is lost; the only new URL is this item's history route.
  const was = linksOf(`${old.summary}\n${old.outcome}`);
  const proposedLinks = linksOf(`${proposed.summary}\n${proposed.outcome}`);
  const historyUrl = `${run.origin.replace(/\/$/, "")}/api/v1/work/items/${old.id}/history`;
  for (const u of was.urls) if (!proposedLinks.urls.has(u)) return fail("links");
  for (const r of was.refs) if (!proposedLinks.refs.has(r)) return fail("links");
  for (const u of proposedLinks.urls)
    if (!was.urls.has(u) && u !== historyUrl) return fail("links");

  // progress: the proposal never checks more boxes than the item has.
  const boxes = (s: string, o: string) =>
    (`${s}\n${o}`.match(CHECKED_BOX) ?? []).length;
  if (
    boxes(proposed.summary, proposed.outcome) > boxes(old.summary, old.outcome)
  )
    return fail("progress");

  // retain: at least 80% of the old distinct tokens survive.
  const oldTokens = retainTokens(`${old.summary}\n${old.outcome}`);
  const newTokens = retainTokens(`${proposed.summary}\n${proposed.outcome}`);
  let kept = 0;
  for (const t of oldTokens) if (newTokens.has(t)) kept++;
  if (kept * RETAIN_DENOMINATOR < oldTokens.size * RETAIN_NUMERATOR)
    return fail("retain");

  // fewer: no new broken rule, and at least one agent-fixable rule gone.
  const after = scoreBrief(
    "items",
    {
      title: old.title,
      summary: proposed.summary,
      outcome: proposed.outcome,
    },
    maxLongShare,
  );
  const removed = before.broken.filter(
    (r): r is AgentFixableRule => isAgentFixable(r) && !after.broken.includes(r),
  );
  if (after.broken.some((r) => !before.broken.includes(r)) || !removed.length)
    return fail("fewer");

  // budget: three writes a run, one per item.
  if (run.writes >= MAX_WRITES_PER_RUN || run.written.has(proposed.id))
    return fail("budget");

  return {
    ok: true,
    reason: `${RECONCILE_REASON_PREFIX} ${removed.join(", ")}`,
    removed,
  };
}
