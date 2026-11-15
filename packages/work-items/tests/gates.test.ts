// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/gates`
 * Purpose: Pins the one move predicate at its seam (task.0122, story.0047): every exit gate of the ladder and every
 *   falsifier of hub work-gate-enforcement ("How to falsify it"), table-driven over the pure `evaluateMove`.
 * Scope: Pure. No store, no network, no clock. The adapter's wiring (status_revision, the PR read, the lock) is in
 *   `adapters/doltgres-adapter-gates.test.ts`.
 * Invariants:
 *   - Each forward move is refused without its exit artifact and accepted with it.
 *   - Refused: a jump, an exit from done or cancelled, a forward move on an artifact written before the item re-entered
 *     the stage, an approve followed by a later request_changes, a validation or a merge at another head than the
 *     approved one, a failed fact read (`facts_unavailable`).
 *   - Accepted: a move back to triage or an earlier stage on the path, and a cancel.
 *   - Only artifacts recorded on this item count.
 * Side-effects: none
 * Links: hub work-status-ladder, work-gate-enforcement
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { ArtifactKind, ScorecardRow } from "../src/artifacts.js";
import {
  classifyDeliverable,
  evaluateMove,
  GATE_CHILDREN_MAX,
  type GateArtifact,
  type GateFacts,
  type GateItem,
  gateNeeds,
  type InboxFacts,
  type MoveResult,
  type PrFacts,
  refusesPathChange,
} from "../src/gates.js";
import {
  FORWARD_TARGETS,
  isValidTransition,
  STATUS_ORDER,
  VALID_TRANSITIONS,
} from "../src/transitions.js";
import type { WorkItemStatus, WorkItemType } from "../src/types.js";

const ID = "task.0001";
const PR = "https://github.com/cogni-dao/node-template/pull/9";
const OTHER_REPO_PR = "https://github.com/cogni-dao/levelup/pull/9";
const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const INBOX = "contrib-code-work-0001";
const INBOX_URL = `https://node-template.cognidao.org/knowledge/inbox/${INBOX}`;
const DESIGN_INBOX = "contrib-design-0001";
const COMMIT = "0123456789abcdefghijklmnopqrstuv";
const NEW_COMMIT = "vutsrqponmlkjihgfedcba9876543210";
const ORIGIN = "https://node-template.cognidao.org";
const BUILD = `${ORIGIN}@${HEAD}`;
/** The revision at which the item entered its stage. */
const SREV = 4;

const PASS: ScorecardRow[] = [
  { tweak: "GATES", human: "—", ai: "🟢", loki: "🟢", trace: "—", overall: "🟢 PASS" },
];
const UNREASONED: ScorecardRow[] = [
  { tweak: "GATES", human: "—", ai: "🟡", loki: "🟡", trace: "—", overall: "🟡 UNPROVEN" },
];
const FAILED: ScorecardRow[] = [
  { tweak: "GATES", human: "—", ai: "🔴", loki: "🔴", trace: "—", overall: "🔴 FAIL" },
];

const SIX = {
  ease: { v: 3 },
  goal: { v: 4 },
  time: { v: 3 },
  agent: { v: 4 },
  unblocks: { v: 4 },
  confidence: { v: 4 },
};

function art(
  kind: ArtifactKind,
  subject: string,
  verdict: string,
  extra: Partial<GateArtifact> = {}
): GateArtifact {
  return {
    id: `wia-${kind}-${extra.itemRevision ?? SREV}-${verdict}`,
    itemId: ID,
    kind,
    subject,
    verdict,
    itemRevision: SREV,
    // seq orders artifacts: by default a later revision is a later artifact.
    seq: extra.itemRevision ?? SREV,
    author: "reviewer",
    ...extra,
  };
}

const triage = (verdict: string, extra: Partial<GateArtifact> = {}) =>
  art("triage", `work:${ID}`, verdict, extra);
const designReview = (head = COMMIT, verdict = "approve", extra: Partial<GateArtifact> = {}) =>
  art("design_review", `knowledge:${DESIGN_INBOX}@${head}`, verdict, extra);
const prReview = (head = HEAD, verdict = "approve", extra: Partial<GateArtifact> = {}) =>
  art("implementation_review", `${PR}@${head}`, verdict, extra);
const inboxReview = (head = COMMIT, contribution = INBOX, verdict = "approve", extra: Partial<GateArtifact> = {}) =>
  art("implementation_review", `knowledge:${contribution}@${head}`, verdict, extra);
const prValidation = (head = HEAD, rows: ScorecardRow[] = PASS, verdict = "pass", extra: Partial<GateArtifact> = {}) =>
  art("validation", `${PR}@${head}`, verdict, { rows, ...extra });
const buildValidation = (rows: ScorecardRow[] = PASS, subject = BUILD) =>
  art("validation", subject, "pass", { rows });

interface Case {
  readonly name: string;
  readonly type?: WorkItemType;
  readonly from: WorkItemStatus;
  readonly to: WorkItemStatus;
  readonly pr?: string | null;
  readonly artifacts?: readonly GateArtifact[];
  readonly prFacts?: PrFacts | null;
  readonly inboxes?: Record<string, InboxFacts | null>;
  readonly children?: readonly string[] | null;
  readonly item?: Partial<GateItem>;
  readonly hubOrigin?: string | null;
  readonly repos?: readonly string[];
  readonly ok?: true;
  readonly unmet?: string;
  readonly unavailable?: string;
}

const OPEN_PR: PrFacts = { head: HEAD, merged: false };
const MERGED_PR: PrFacts = { head: HEAD, merged: true };
const OPEN_INBOX: InboxFacts = { head: COMMIT, merged: false };
const MERGED_INBOX: InboxFacts = { head: COMMIT, merged: true };

function run(c: Case): MoveResult {
  const pr = c.pr === undefined ? PR : c.pr;
  const item: GateItem = {
    id: ID,
    type: c.type ?? "task",
    pr,
    labels: ["goal:goal-ai-work-converges"],
    scores: SIX,
    moves: [{ metricId: "m", direction: "up" }],
    statusRevision: SREV,
    ...c.item,
  };
  const facts: GateFacts = {
    deliverable: classifyDeliverable(pr, c.repos),
    ...(c.prFacts === null ? {} : { pr: c.prFacts ?? OPEN_PR }),
    inboxes: c.inboxes ?? { [INBOX]: OPEN_INBOX, [DESIGN_INBOX]: OPEN_INBOX },
    ...(c.children === null ? {} : { children: { statuses: c.children ?? ["done"] } }),
    ...(c.hubOrigin === null ? {} : { hubOrigin: c.hubOrigin ?? ORIGIN }),
  };
  return evaluateMove(item, c.from, c.to, c.artifacts ?? [], facts);
}

function expectCase(c: Case) {
  const result = run(c);
  if (c.ok) expect(result).toEqual({ ok: true });
  else if (c.unavailable)
    expect(result).toEqual({ ok: false, code: "facts_unavailable", missing: c.unavailable });
  else expect(result).toEqual({ ok: false, code: "gate_unmet", missing: c.unmet });
}

const designRoute = [triage("design", { itemRevision: 1 })];

describe("exit of needs_triage: a triage artifact, six scores, a goal label, moves or a gap", () => {
  const cases: Case[] = [
    { name: "triage verdict implement routes to needs_implement", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], ok: true },
    { name: "verdict design routes to needs_design", from: "needs_triage", to: "needs_design", artifacts: [triage("design")], ok: true },
    { name: "verdict research routes to needs_research", from: "needs_triage", to: "needs_research", artifacts: [triage("research")], ok: true },
    { name: "no triage artifact is refused", from: "needs_triage", to: "needs_implement", unmet: "triage" },
    { name: "a verdict that names another route is refused", from: "needs_triage", to: "needs_implement", artifacts: [triage("design")], unmet: "triage" },
    { name: "a triage artifact written before the item re-entered triage is stale", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement", { itemRevision: SREV - 1 })], unmet: "triage" },
    { name: "a triage artifact of another item never counts", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement", { itemId: "task.0002" })], unmet: "triage" },
    { name: "a triage subject that names another item is refused", from: "needs_triage", to: "needs_implement", artifacts: [art("triage", "work:task.0002", "implement")], unmet: "triage" },
    { name: "five nonzero scores are refused", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { scores: { ...SIX, confidence: { v: 0 } } }, unmet: "scores" },
    { name: "six axes under other names do not count: the named six are required", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { scores: { goal: { v: 4 }, time: { v: 3 }, unblocks: { v: 4 }, ease: { v: 3 }, confidence: { v: 4 }, extra: { v: 4 } } }, unmet: "scores" },
    { name: "seven axes with the six named all nonzero pass", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { scores: { ...SIX, extra: { v: 1 } } }, ok: true },
    { name: "no scores are refused", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { scores: null }, unmet: "scores" },
    { name: "no goal label is refused", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { labels: ["area:web"] }, unmet: "goal_label" },
    { name: "no moves and no measurement gap in the note is refused", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement")], item: { moves: [] }, unmet: "moves_or_gap" },
    { name: "no moves but a gap in the note passes", from: "needs_triage", to: "needs_implement", artifacts: [triage("implement", { note: "no KPI measures this yet" })], item: { moves: [] }, ok: true },
    { name: "a jump to needs_implementation_review is refused", from: "needs_triage", to: "needs_implementation_review", artifacts: [triage("implement")], unmet: "path" },
    { name: "a jump to needs_design_review is refused", from: "needs_triage", to: "needs_design_review", artifacts: [triage("design")], unmet: "path" },
    { name: "a jump to needs_validation is refused", from: "needs_triage", to: "needs_validation", artifacts: [triage("implement")], unmet: "path" },
    { name: "a jump to needs_merge is refused", from: "needs_triage", to: "needs_merge", artifacts: [triage("implement")], unmet: "path" },
    { name: "a jump to done is refused", from: "needs_triage", to: "done", artifacts: [triage("implement")], unmet: "path" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("back, cancel and terminal", () => {
  const cases: Case[] = [
    { name: "needs_validation back to needs_triage needs nothing", from: "needs_validation", to: "needs_triage", ok: true },
    { name: "needs_validation back to needs_implementation_review", from: "needs_validation", to: "needs_implementation_review", ok: true },
    { name: "needs_validation back to needs_implement", from: "needs_validation", to: "needs_implement", ok: true },
    { name: "needs_merge back to needs_validation", from: "needs_merge", to: "needs_validation", ok: true },
    { name: "back to needs_design is off the implement route: go through triage", from: "needs_implementation_review", to: "needs_design", unmet: "path" },
    { name: "back to needs_design is on the design route", from: "needs_implementation_review", to: "needs_design", artifacts: designRoute, ok: true },
    { name: "back to needs_design_review is on the design route", from: "needs_implement", to: "needs_design_review", artifacts: designRoute, ok: true },
    { name: "a story goes back to needs_implement", type: "story", pr: null, from: "needs_validation", to: "needs_implement", ok: true },
    { name: "a knowledge item goes back from merge to implementation review", pr: INBOX_URL, from: "needs_merge", to: "needs_implementation_review", ok: true },
    { name: "cancel from needs_implement", from: "needs_implement", to: "cancelled", ok: true },
    { name: "cancel from needs_triage", from: "needs_triage", to: "cancelled", ok: true },
    { name: "cancel from needs_merge", from: "needs_merge", to: "cancelled", ok: true },
    { name: "done -> needs_merge is refused", from: "done", to: "needs_merge", unmet: "terminal" },
    { name: "done -> needs_triage is refused", from: "done", to: "needs_triage", unmet: "terminal" },
    { name: "done -> cancelled is refused", from: "done", to: "cancelled", unmet: "terminal" },
    { name: "cancelled -> needs_triage is refused", from: "cancelled", to: "needs_triage", unmet: "terminal" },
    { name: "no write enters blocked", from: "needs_implement", to: "blocked", unmet: "path" },
    { name: "no write enters needs_closeout", from: "needs_merge", to: "needs_closeout", unmet: "path" },
    { name: "a legacy blocked item goes back to triage", from: "blocked", to: "needs_triage", ok: true },
    { name: "a legacy blocked item can be cancelled", from: "blocked", to: "cancelled", ok: true },
    { name: "a legacy blocked item cannot move forward", from: "blocked", to: "needs_implement", artifacts: [triage("implement")], unmet: "path" },
    { name: "a legacy needs_closeout item goes back to triage", from: "needs_closeout", to: "needs_triage", ok: true },
    { name: "a legacy needs_closeout item cannot jump to done", from: "needs_closeout", to: "done", unmet: "path" },
    { name: "a move that keeps the status is not a move", from: "done", to: "done", ok: true },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_research and needs_design", () => {
  const spike = (c: Omit<Case, "type">): Case => ({ ...c, type: "spike" });
  const cases: Case[] = [
    spike({ name: "a spike's research ends in done when its inbox merged", from: "needs_research", to: "done", pr: INBOX_URL, inboxes: { [INBOX]: MERGED_INBOX }, ok: true }),
    spike({ name: "an open inbox is refused", from: "needs_research", to: "done", pr: INBOX_URL, unmet: "inbox_merged" }),
    spike({ name: "a pr that is not an inbox is refused", from: "needs_research", to: "done", unmet: "pr" }),
    spike({ name: "no pr is refused", from: "needs_research", to: "done", pr: null, unmet: "pr" }),
    spike({ name: "an inbox not read is facts_unavailable", from: "needs_research", to: "done", pr: INBOX_URL, inboxes: {}, unavailable: "inbox_merged" }),
    { name: "a task cannot go from research to done: go back to triage", from: "needs_research", to: "done", pr: INBOX_URL, inboxes: { [INBOX]: MERGED_INBOX }, unmet: "path" },
    spike({ name: "a spike goes back from research to triage", from: "needs_research", to: "needs_triage", ok: true }),
    { name: "needs_design -> needs_design_review needs nothing", from: "needs_design", to: "needs_design_review", ok: true },
    { name: "needs_design -> needs_implement is a jump", from: "needs_design", to: "needs_implement", artifacts: designRoute, unmet: "path" },
    { name: "needs_design -> needs_implementation_review is a jump", from: "needs_design", to: "needs_implementation_review", artifacts: designRoute, unmet: "path" },
    { name: "a story needs_design -> needs_validation is a jump", type: "story", pr: null, from: "needs_design", to: "needs_validation", artifacts: designRoute, unmet: "path" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_design_review: an approve of the design inbox at its current head", () => {
  const base = { from: "needs_design_review", to: "needs_implement", artifacts: undefined } as const;
  const cases: Case[] = [
    { name: "approve at the inbox's head passes", ...base, artifacts: [...designRoute, designReview()], ok: true },
    { name: "no review is refused", ...base, artifacts: designRoute, unmet: "design_review" },
    { name: "an approve at a stale head is refused", ...base, artifacts: [...designRoute, designReview(NEW_COMMIT)], unmet: "design_review" },
    { name: "request_changes is refused", ...base, artifacts: [...designRoute, designReview(COMMIT, "request_changes")], unmet: "design_review" },
    { name: "an approve written before the item re-entered the stage is refused", ...base, artifacts: [...designRoute, designReview(COMMIT, "approve", { itemRevision: SREV - 1 })], unmet: "design_review" },
    { name: "an approve followed by a later request_changes is refused", ...base, artifacts: [...designRoute, designReview(COMMIT, "approve"), designReview(COMMIT, "request_changes", { itemRevision: SREV + 1 })], unmet: "design_review" },
    { name: "a later approve overrides an earlier request_changes", ...base, artifacts: [...designRoute, designReview(COMMIT, "request_changes"), designReview(COMMIT, "approve", { itemRevision: SREV + 1 })], ok: true },
    { name: "a review recorded on another item never counts", ...base, artifacts: [...designRoute, designReview(COMMIT, "approve", { itemId: "task.0002" })], unmet: "design_review" },
    { name: "an inbox that is not in this hub is refused", ...base, artifacts: [...designRoute, designReview()], inboxes: { [DESIGN_INBOX]: null }, unmet: "design_review" },
    { name: "an inbox not read is facts_unavailable", ...base, artifacts: [...designRoute, designReview()], inboxes: {}, unavailable: "design_review" },
    { name: "a review whose subject is not an inbox is refused", ...base, artifacts: [...designRoute, art("design_review", `${PR}@${HEAD}`, "approve")], unmet: "design_review" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_implement: pr is a deliverable of this node (a story: its children)", () => {
  const cases: Case[] = [
    { name: "a PR of this node's repo passes", from: "needs_implement", to: "needs_implementation_review", repos: ["cogni-dao/node-template"], ok: true },
    { name: "unpinned, a PR of any github.com repo passes", from: "needs_implement", to: "needs_implementation_review", pr: OTHER_REPO_PR, ok: true },
    { name: "pinned, a PR of another repo is refused", from: "needs_implement", to: "needs_implementation_review", pr: OTHER_REPO_PR, repos: ["cogni-dao/node-template"], unmet: "pr" },
    { name: "several pinned repos: a PR of the second passes", from: "needs_implement", to: "needs_implementation_review", pr: OTHER_REPO_PR, repos: ["cogni-dao/node-template", "Cogni-DAO/levelup"], ok: true },
    { name: "no pr is refused", from: "needs_implement", to: "needs_implementation_review", pr: null, unmet: "pr" },
    { name: "an inbox of this hub passes", from: "needs_implement", to: "needs_implementation_review", pr: INBOX_URL, ok: true },
    { name: "an inbox that is not in this hub is refused", from: "needs_implement", to: "needs_implementation_review", pr: INBOX_URL, inboxes: { [INBOX]: null }, unmet: "pr" },
    { name: "an inbox not read is facts_unavailable", from: "needs_implement", to: "needs_implementation_review", pr: INBOX_URL, inboxes: {}, unavailable: "pr" },
    { name: "a knowledge item cannot jump to validation", from: "needs_implement", to: "needs_validation", pr: INBOX_URL, unmet: "path" },
    { name: "a code item cannot jump to validation", from: "needs_implement", to: "needs_validation", unmet: "path" },
    { name: "a code item cannot jump to needs_merge", from: "needs_implement", to: "needs_merge", unmet: "path" },
    { name: "a story with a done child and the rest settled passes", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: ["done", "cancelled"], ok: true },
    { name: "a story with an open child is refused", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: ["done", "needs_implement"], unmet: "children" },
    { name: "a story with every child cancelled is refused (none done)", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: ["cancelled"], unmet: "children" },
    { name: "a story with no children is refused", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: [], unmet: "children" },
    { name: "a story with more than 50 children fails closed", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: Array.from({ length: GATE_CHILDREN_MAX + 1 }, () => "done"), unmet: "children" },
    { name: "children not read is facts_unavailable", type: "story", pr: null, from: "needs_implement", to: "needs_validation", children: null, unavailable: "children" },
    { name: "a story has no implementation review", type: "story", pr: null, from: "needs_implement", to: "needs_implementation_review", children: ["done"], unmet: "path" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_implementation_review: an approve at the deliverable's current head", () => {
  const code = { from: "needs_implementation_review", to: "needs_validation" } as const;
  const cases: Case[] = [
    { name: "approve at the PR head passes", ...code, artifacts: [prReview()], ok: true },
    { name: "no review is refused", ...code, unmet: "implementation_review" },
    { name: "a review of an old head is refused", ...code, artifacts: [prReview(NEW_HEAD)], unmet: "implementation_review" },
    { name: "request_changes is refused", ...code, artifacts: [prReview(HEAD, "request_changes")], unmet: "implementation_review" },
    { name: "an approve written before the item re-entered the stage is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: SREV - 1 })], unmet: "implementation_review" },
    { name: "an approve followed by a later request_changes is refused", ...code, artifacts: [prReview(HEAD, "approve"), prReview(HEAD, "request_changes", { itemRevision: SREV + 1 })], unmet: "implementation_review" },
    { name: "a review of another PR is refused", ...code, artifacts: [art("implementation_review", `https://github.com/cogni-dao/node-template/pull/10@${HEAD}`, "approve")], unmet: "implementation_review" },
    { name: "a review recorded on another item never counts", ...code, artifacts: [prReview(HEAD, "approve", { itemId: "task.0002" })], unmet: "implementation_review" },
    { name: "the PR facts not read is facts_unavailable", ...code, artifacts: [prReview()], prFacts: null, unavailable: "pr" },
    { name: "a code item cannot skip validation to needs_merge", from: "needs_implementation_review", to: "needs_merge", artifacts: [prReview()], unmet: "path" },
    { name: "a knowledge item goes to needs_merge on an approve at the inbox head", from: "needs_implementation_review", to: "needs_merge", pr: INBOX_URL, artifacts: [inboxReview()], ok: true },
    { name: "a knowledge review at a stale inbox head is refused", from: "needs_implementation_review", to: "needs_merge", pr: INBOX_URL, artifacts: [inboxReview(NEW_COMMIT)], unmet: "implementation_review" },
    { name: "a knowledge review of another inbox is refused", from: "needs_implementation_review", to: "needs_merge", pr: INBOX_URL, artifacts: [inboxReview(COMMIT, "contrib-other")], unmet: "implementation_review" },
    { name: "a knowledge item has no validation stage", from: "needs_implementation_review", to: "needs_validation", pr: INBOX_URL, artifacts: [inboxReview()], unmet: "path" },
    { name: "an inbox not read is facts_unavailable", from: "needs_implementation_review", to: "needs_merge", pr: INBOX_URL, artifacts: [inboxReview()], inboxes: {}, unavailable: "implementation_review" },
    { name: "no pr is refused", ...code, pr: null, artifacts: [prReview()], unmet: "pr" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_validation: PASS-grade at the approved head", () => {
  const code = { from: "needs_validation", to: "needs_merge" } as const;
  const cases: Case[] = [
    { name: "a PASS validation at the approved head passes", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation()], ok: true },
    { name: "no validation is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 })], unmet: "validation" },
    { name: "a validation at another head than the approved one is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(NEW_HEAD)], unmet: "validation" },
    { name: "a PR head that moved after the approval is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation()], prFacts: { head: NEW_HEAD, merged: false }, unmet: "validation" },
    { name: "a later request_changes during validation voids the approved head", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prReview(HEAD, "request_changes", { itemRevision: 3 }), prValidation()], unmet: "implementation_review" },
    { name: "no approving review at all voids it", ...code, artifacts: [prValidation()], unmet: "implementation_review" },
    { name: "a validation written before the item re-entered validation is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD, PASS, "pass", { itemRevision: SREV - 1 })], unmet: "validation" },
    { name: "a notes validation with an UNPROVEN row and no reason is not PASS-grade", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD, UNREASONED, "notes")], unmet: "validation" },
    { name: "a notes validation with a reasoned UNPROVEN row is PASS-grade", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD, [{ ...UNREASONED[0]!, reason: "no loki signal on candidate" }], "notes")], ok: true },
    { name: "a fail validation is refused", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD, FAILED, "fail")], unmet: "validation" },
    { name: "a later fail overrides an earlier pass", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD), prValidation(HEAD, FAILED, "fail", { itemRevision: SREV + 1 })], unmet: "validation" },
    { name: "a build-subject validation does not count on the code path", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), buildValidation()], unmet: "validation" },
    { name: "a validation recorded on another item never counts", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation(HEAD, PASS, "pass", { itemId: "task.0002" })], unmet: "validation" },
    { name: "the PR facts not read is facts_unavailable", ...code, artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation()], prFacts: null, unavailable: "pr" },
    { name: "a code item cannot jump from validation to done", from: "needs_validation", to: "done", artifacts: [prReview(HEAD, "approve", { itemRevision: 2 }), prValidation()], prFacts: MERGED_PR, unmet: "path" },
    { name: "a story's validation names this hub's origin", type: "story", pr: null, from: "needs_validation", to: "done", artifacts: [buildValidation()], ok: true },
    { name: "a story validation of another origin is refused", type: "story", pr: null, from: "needs_validation", to: "done", artifacts: [buildValidation(PASS, `https://other.example@${HEAD}`)], unmet: "validation" },
    { name: "with no hub origin configured a story validation is refused (fail closed)", type: "story", pr: null, from: "needs_validation", to: "done", artifacts: [buildValidation()], hubOrigin: null, unmet: "validation" },
    { name: "a story needs a PASS-grade validation", type: "story", pr: null, from: "needs_validation", to: "done", artifacts: [buildValidation(FAILED)], unmet: "validation" },
    { name: "a story without a validation is refused", type: "story", pr: null, from: "needs_validation", to: "done", unmet: "validation" },
    { name: "a PR-subject validation does not count on the story path", type: "story", pr: null, from: "needs_validation", to: "done", artifacts: [prValidation()], unmet: "validation" },
    { name: "a story never enters needs_merge", type: "story", pr: null, from: "needs_validation", to: "needs_merge", artifacts: [buildValidation()], unmet: "path" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("exit of needs_merge: the deliverable merged at the approved head, a code item also validated there", () => {
  const review = prReview(HEAD, "approve", { itemRevision: 2 });
  const validated = prValidation(HEAD);
  const cases: Case[] = [
    { name: "a PR merged at the approved head passes", from: "needs_merge", to: "done", artifacts: [review, validated], prFacts: MERGED_PR, ok: true },
    { name: "an unmerged PR is refused", from: "needs_merge", to: "done", artifacts: [review, validated], prFacts: OPEN_PR, unmet: "pr_merged" },
    { name: "a PR merged at another head than the approved one is refused", from: "needs_merge", to: "done", artifacts: [review, validated], prFacts: { head: NEW_HEAD, merged: true }, unmet: "implementation_review" },
    { name: "no validation at all is refused", from: "needs_merge", to: "done", artifacts: [review], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a validation of another head than the approved one is refused, however late", from: "needs_merge", to: "done", artifacts: [review, prValidation(NEW_HEAD, PASS, "pass", { itemRevision: 5 })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "validated at H, then approved again at H2, merged at H2, is refused", from: "needs_merge", to: "done", artifacts: [review, validated, prReview(NEW_HEAD, "approve", { itemRevision: 5 })], prFacts: { head: NEW_HEAD, merged: true }, unmet: "validation" },
    { name: "validated at H2 after the new approval at H2, merged at H2, passes", from: "needs_merge", to: "done", artifacts: [review, validated, prReview(NEW_HEAD, "approve", { itemRevision: 5 }), prValidation(NEW_HEAD, PASS, "pass", { itemRevision: 6 })], prFacts: { head: NEW_HEAD, merged: true }, ok: true },
    { name: "a validation older than the approval at the same head is refused", from: "needs_merge", to: "done", artifacts: [validated, prReview(HEAD, "approve", { itemRevision: 6 })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a failing validation is refused", from: "needs_merge", to: "done", artifacts: [review, prValidation(HEAD, FAILED, "fail")], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a later fail overrides an earlier pass", from: "needs_merge", to: "done", artifacts: [review, validated, prValidation(HEAD, FAILED, "fail", { itemRevision: 5 })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a validation of another PR is refused", from: "needs_merge", to: "done", artifacts: [review, art("validation", `https://github.com/cogni-dao/node-template/pull/10@${HEAD}`, "pass", { rows: PASS })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a validation recorded on another item never counts", from: "needs_merge", to: "done", artifacts: [review, prValidation(HEAD, PASS, "pass", { itemId: "task.0002" })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "a knowledge item that switched pr to a PR and got a review is a code item: refused without a validation", from: "needs_merge", to: "done", pr: PR, artifacts: [inboxReview(COMMIT, INBOX, "approve", { itemRevision: 2 }), prReview(HEAD, "approve", { itemRevision: 3 })], prFacts: MERGED_PR, unmet: "validation" },
    { name: "no approving review is refused", from: "needs_merge", to: "done", prFacts: MERGED_PR, unmet: "implementation_review" },
    { name: "a later request_changes voids the approval", from: "needs_merge", to: "done", artifacts: [review, prReview(HEAD, "request_changes", { itemRevision: 3 })], prFacts: MERGED_PR, unmet: "implementation_review" },
    { name: "the PR facts not read is facts_unavailable", from: "needs_merge", to: "done", artifacts: [review, validated], prFacts: null, unavailable: "pr" },
    { name: "a knowledge item: the inbox merged at the approved head passes", pr: INBOX_URL, from: "needs_merge", to: "done", artifacts: [inboxReview(COMMIT, INBOX, "approve", { itemRevision: 2 })], inboxes: { [INBOX]: MERGED_INBOX }, ok: true },
    { name: "a knowledge item: an open inbox is refused", pr: INBOX_URL, from: "needs_merge", to: "done", artifacts: [inboxReview(COMMIT, INBOX, "approve", { itemRevision: 2 })], unmet: "inbox_merged" },
    { name: "a knowledge item: an inbox merged at another head is refused", pr: INBOX_URL, from: "needs_merge", to: "done", artifacts: [inboxReview(NEW_COMMIT, INBOX, "approve", { itemRevision: 2 })], inboxes: { [INBOX]: MERGED_INBOX }, unmet: "implementation_review" },
  ];
  it.each(cases)("$name", expectCase);
});

describe("a migrated item with no triage artifact takes its path from its stage", () => {
  const review = prReview(HEAD, "approve", { itemRevision: 2 });
  const cases: Case[] = [
    { name: "needs_implementation_review moves forward", from: "needs_implementation_review", to: "needs_validation", artifacts: [prReview()], ok: true },
    { name: "needs_merge closes on a merged PR", from: "needs_merge", to: "done", artifacts: [review, prValidation(HEAD)], prFacts: MERGED_PR, ok: true },
    { name: "needs_design_review keeps the design route", from: "needs_design_review", to: "needs_implement", artifacts: [designReview()], ok: true },
    { name: "needs_implement can go back to triage", from: "needs_implement", to: "needs_triage", ok: true },
  ];
  it.each(cases)("$name", expectCase);
});

describe("one full walk and the re-walk after a move back", () => {
  it("walks a code item from triage to done, one stage at a time, each on its exit artifact", () => {
    const rev = (n: number) => ({ itemRevision: n });
    const triaged = triage("implement", rev(1));
    const review = prReview(HEAD, "approve", rev(5));
    const walk: Case[] = [
      { name: "triage", from: "needs_triage", to: "needs_implement", artifacts: [triaged], item: { statusRevision: 1 }, ok: true },
      { name: "implement", from: "needs_implement", to: "needs_implementation_review", artifacts: [triaged], item: { statusRevision: 2 }, ok: true },
      { name: "review", from: "needs_implementation_review", to: "needs_validation", artifacts: [triaged, review], item: { statusRevision: 4 }, ok: true },
      { name: "validation", from: "needs_validation", to: "needs_merge", artifacts: [triaged, review, prValidation(HEAD, PASS, "pass", rev(7))], item: { statusRevision: 6 }, ok: true },
      { name: "merge", from: "needs_merge", to: "done", artifacts: [triaged, review, prValidation(HEAD, PASS, "pass", rev(7))], item: { statusRevision: 8 }, prFacts: MERGED_PR, ok: true },
    ];
    for (const step of walk) expectCase(step);
  });

  it("after a move back every earlier artifact for the re-entered stage is stale", () => {
    // Back from validation to implementation review restamps statusRevision (here 9); the old approve (rev 5) no longer counts.
    const review = prReview(HEAD, "approve", { itemRevision: 5 });
    expectCase({
      name: "x",
      from: "needs_implementation_review",
      to: "needs_validation",
      artifacts: [review],
      item: { statusRevision: 9 },
      unmet: "implementation_review",
    });
    // A fresh approve written after re-entering passes.
    expectCase({
      name: "x",
      from: "needs_implementation_review",
      to: "needs_validation",
      artifacts: [review, prReview(HEAD, "approve", { itemRevision: 10 })],
      item: { statusRevision: 9 },
      ok: true,
    });
  });
});

describe("refusesPathChange: the deliverable kind changes only via triage", () => {
  it.each<[string, WorkItemStatus, WorkItemStatus, string | null, string, boolean]>([
    ["a PR to an inbox at needs_implementation_review", "needs_implementation_review", "needs_implementation_review", PR, INBOX_URL, true],
    ["an inbox to a PR at needs_merge", "needs_merge", "needs_merge", INBOX_URL, PR, true],
    ["a PR to an inbox at needs_validation, moving forward", "needs_validation", "needs_merge", PR, INBOX_URL, true],
    ["an inbox to a PR at done", "done", "done", INBOX_URL, PR, true],
    ["a PR to an inbox moving back to needs_implement", "needs_implementation_review", "needs_implement", PR, INBOX_URL, false],
    ["a PR to an inbox moving back to needs_triage", "needs_merge", "needs_triage", PR, INBOX_URL, false],
    ["a PR to an inbox moving back to needs_design", "needs_validation", "needs_design", PR, INBOX_URL, false],
    ["a PR to an inbox being cancelled", "needs_merge", "cancelled", PR, INBOX_URL, false],
    ["a PR to an inbox at needs_implement (not yet in review)", "needs_implement", "needs_implement", PR, INBOX_URL, false],
    ["a PR to another PR at needs_merge (same kind)", "needs_merge", "needs_merge", PR, "https://github.com/cogni-dao/node-template/pull/10", false],
    ["the same pr written again", "needs_merge", "needs_merge", PR, PR, false],
    ["a first pr at needs_implementation_review", "needs_implementation_review", "needs_implementation_review", null, PR, false],
  ])("%s -> refused: %s", (_name, from, to, current, next, refused) => {
    expect(refusesPathChange(from, to, current, next)).toBe(refused);
  });

  it("a patch that does not touch pr is never a path change", () => {
    expect(refusesPathChange("needs_merge", "needs_merge", PR, undefined)).toBe(false);
  });
});

describe("gateNeeds: the facts a move reads, known before the lock", () => {
  const item = (type: WorkItemType = "task", pr: string | null = PR): GateItem => ({
    id: ID,
    type,
    pr,
    statusRevision: SREV,
  });
  const needs = (from: WorkItemStatus, to: WorkItemStatus, type: WorkItemType = "task", pr: string | null = PR) =>
    gateNeeds(item(type, pr), from, to, classifyDeliverable(pr));

  it.each<[WorkItemStatus, WorkItemStatus, boolean]>([
    ["needs_implement", "needs_implementation_review", false],
    ["needs_implementation_review", "needs_validation", true],
    ["needs_validation", "needs_merge", true],
    ["needs_merge", "done", true],
  ])("a code item moving %s -> %s reads the PR: %s", (from, to, reads) => {
    expect(needs(from, to).pr).toBe(reads);
  });

  it("a back move, a cancel and a move out of a legacy status read nothing", () => {
    const none = { pr: false, children: false, artifacts: false };
    expect(needs("needs_validation", "needs_triage")).toEqual(none);
    expect(needs("needs_merge", "needs_implementation_review")).toEqual(none);
    expect(needs("needs_merge", "cancelled")).toEqual(none);
    expect(needs("blocked", "needs_triage")).toEqual(none);
  });

  it("a forward move reads the artifacts; a story reads its children, never a PR; a knowledge item never reads a PR", () => {
    expect(needs("needs_triage", "needs_implement").artifacts).toBe(true);
    expect(needs("needs_implement", "needs_validation", "story", null).children).toBe(true);
    expect(needs("needs_validation", "done", "story", null).pr).toBe(false);
    expect(needs("needs_implementation_review", "needs_merge", "task", INBOX_URL).pr).toBe(false);
  });
});

describe("classifyDeliverable", () => {
  it.each<[string | null | undefined, unknown]>([
    [PR, { kind: "pr", url: PR }],
    ["https://github.com/Cogni-DAO/node-template/pull/9", { kind: "pr", url: "https://github.com/Cogni-DAO/node-template/pull/9" }],
    [INBOX_URL, { kind: "inbox", contribution: INBOX }],
    ["https://github.com/cogni-dao/node-template/issues/9", undefined],
    ["", undefined],
    [null, undefined],
  ])("%s", (pr, expected) => {
    expect(classifyDeliverable(pr, ["cogni-dao/node-template"])).toEqual(expected);
  });

  it("a pinned list names the repositories whose PRs count, case-insensitive", () => {
    expect(classifyDeliverable(OTHER_REPO_PR, ["cogni-dao/node-template"])).toBeUndefined();
    expect(classifyDeliverable(OTHER_REPO_PR, ["cogni-dao/node-template", "Cogni-DAO/Levelup"])).toEqual({
      kind: "pr",
      url: OTHER_REPO_PR,
    });
  });

  it("unpinned, a PR of any github.com repository is a deliverable", () => {
    expect(classifyDeliverable(OTHER_REPO_PR)).toEqual({ kind: "pr", url: OTHER_REPO_PR });
    expect(classifyDeliverable(OTHER_REPO_PR, [])).toEqual({ kind: "pr", url: OTHER_REPO_PR });
    expect(classifyDeliverable("https://github.com/o/r/issues/1")).toBeUndefined();
  });
});

describe("the stage order", () => {
  it("is one order, triage first", () => {
    expect([...STATUS_ORDER]).toEqual([
      "needs_triage",
      "needs_research",
      "needs_design",
      "needs_design_review",
      "needs_implement",
      "needs_implementation_review",
      "needs_validation",
      "needs_merge",
      "done",
    ]);
  });

  it("gives every status an entry: the ladder, then the legacy statuses and cancelled", () => {
    expect([...VALID_TRANSITIONS.keys()]).toEqual([
      ...STATUS_ORDER,
      "blocked",
      "needs_closeout",
      "cancelled",
    ]);
    expect(VALID_TRANSITIONS.get("done")).toEqual([]);
    expect(VALID_TRANSITIONS.get("cancelled")).toEqual([]);
  });

  it("allows no move into a legacy status; legacy items go back to triage or are cancelled", () => {
    for (const [from, to] of VALID_TRANSITIONS) {
      expect(to).not.toContain("blocked");
      expect(to).not.toContain("needs_closeout");
      expect(to).not.toContain(from);
    }
    expect(VALID_TRANSITIONS.get("blocked")).toEqual(["needs_triage", "cancelled"]);
    expect(VALID_TRANSITIONS.get("needs_closeout")).toEqual(["needs_triage", "cancelled"]);
  });

  it("structurally allows any move back and only the forward targets of a stage", () => {
    expect(isValidTransition("needs_validation", "needs_triage")).toBe(true);
    expect(isValidTransition("needs_triage", "needs_implement")).toBe(true);
    expect(isValidTransition("needs_triage", "needs_merge")).toBe(false);
    expect(isValidTransition("needs_design", "needs_implement")).toBe(false);
    expect(isValidTransition("done", "needs_merge")).toBe(false);
    for (const [from, targets] of FORWARD_TARGETS) {
      for (const to of targets) expect(isValidTransition(from, to)).toBe(true);
    }
  });
});
