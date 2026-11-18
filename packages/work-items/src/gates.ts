// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/gates`
 * Purpose: The one move predicate (task.0122, story.0047): may this item move from this stage to that one? Forward is one
 *   stage on the item's path and only with the exit artifact of the stage it leaves. Back or cancel is allowed.
 * Scope: Pure. `evaluateMove` reads no store, no network and no clock; the adapter hands it the row after the patch, the
 *   item's artifacts and the facts it read (PR head and merge state, inbox head and merge state, children).
 * Invariants:
 *   - FORWARD_IS_ONE_STAGE: `to` must be the next stage on the path (a jump is refused), and the exit artifact of `from`
 *     must hold: the latest of its kind, written at or after the item entered `from` (`itemRevision` >= `statusRevision`),
 *     on this item, with a passing verdict, judging the current head.
 *   - BACK_IS_FREE: a move to needs_triage, to an earlier stage on the path, or to cancelled is allowed (the patch carries a
 *     reason like every patch). To change path an item goes back to triage.
 *   - TERMINAL_STAYS_TERMINAL: `done` and `cancelled` have no exits.
 *   - LEGACY_IS_NEVER_ENTERED: `blocked` is read, never entered; from it only back to triage or cancel.
 *   - CLOSEOUT_IS_A_STAGE: `needs_closeout` follows the merge (a story: the validation) and precedes done. The checks that
 *     once guarded the move into done (the PR merged at the approved head plus the latest PASS validation; a story's
 *     origin-pinned PASS) now guard the move into needs_closeout; the move to done needs the latest `closeout` artifact
 *     (verdict `done`, written since the item entered needs_closeout).
 *   - ONE_PATH: triage decides the route (research or design; a stored legacy `implement` still holds); the item kind decides the rest: a story goes
 *     implement -> validation -> closeout -> done, an inbox deliverable skips validation (review -> merge -> closeout ->
 *     done), everything else is review -> validation -> merge -> closeout -> done. A spike's research -> done is unchanged. A migrated item with no triage artifact takes its route from its stage.
 *   - APPROVED_HEAD: the approved head is the head of the latest implementation_review, which must be `approve`; a later
 *     request_changes voids it. Validation and merge must be at that head, and a code item's merge also needs the latest
 *     validation, PASS-grade, at that head and written after the approval.
 *   - PATH_CHANGES_ONLY_VIA_TRIAGE: changing the deliverable kind of `pr` at needs_implementation_review or later is refused
 *     (`refusesPathChange`) unless the patch moves the item back to needs_implement or earlier.
 *   - ORIGIN_FAILS_CLOSED: a story validation must name this hub's own origin; with no origin configured it is refused.
 *   - FACTS_ARE_NOT_GUESSED: a fact the adapter could not supply is `facts_unavailable`, never a pass.
 *   - NEVER_THROWS: every outcome is a result.
 * Side-effects: none
 * Links: hub work-status-ladder, work-gate-enforcement
 * @public
 */

import {
  type ArtifactKind,
  isOwnOrigin,
  isPassGrade,
  parseArtifactSubject,
  type TRIAGE_VERDICTS,
  type WorkItemArtifact,
} from "./artifacts.js";
import { isLegacyStatus, statusRank } from "./transitions.js";
import type { WorkItemStatus, WorkItemType } from "./types.js";

/** Most children one story gate reads; a story with more fails closed. */
export const GATE_CHILDREN_MAX = 50;

/** The kinds of artifact a move reads (`artifacts.ts` owns them). */
export type GateArtifactKind = ArtifactKind;

/** The slice of a stored artifact the predicate reads; `artifacts.ts` owns the shape, a store row satisfies it. */
export type GateArtifact = Pick<
  WorkItemArtifact,
  | "id"
  | "itemId"
  | "kind"
  | "subject"
  | "verdict"
  | "rows"
  | "note"
  | "itemRevision"
  | "seq"
  | "author"
>;

/** The facts a gate reads about a pull request. */
export interface PrFacts {
  /** The PR's current head commit (40 hex). */
  readonly head: string;
  readonly merged: boolean;
}

/** The facts a gate reads about an inbox (a knowledge contribution) of this node's hub. */
export interface InboxFacts {
  /** The inbox's current head commit. `null` while it has none. */
  readonly head: string | null;
  readonly merged: boolean;
}

/**
 * The narrow PR read the adapter takes before the writer lock (5 s timeout, 60 s cache per PR URL, a failure remembered 10 s).
 * The app wires it to its existing unauthenticated GitHub read. A throw is a failed read: the write is 503, nothing written.
 */
export interface PrFactsPort {
  read(url: string, signal: AbortSignal): Promise<PrFacts>;
}

/**
 * Reads an inbox of this node's hub, locally. `null`: no such inbox. A throw is a failed read (503). Never the writer's connection.
 */
export interface InboxStatePort {
  stateOf(contributionId: string, signal: AbortSignal): Promise<InboxFacts | null>;
}

/** What `pr` points at. */
export type Deliverable =
  | { readonly kind: "pr"; readonly url: string }
  | { readonly kind: "inbox"; readonly contribution: string };

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)$/;
const INBOX_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/knowledge\/inbox\/(contrib-[a-z0-9-]{1,200})$/;

/** One `owner/repo` of a repository pin. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `WORK_ITEMS_PR_REPO` as the gate takes it: one or more comma-separated `owner/repo`. The well-formed entries pin the
 * repositories whose pull requests are code deliverables; a malformed entry is ignored and reported, never pinned. No
 * well-formed entry leaves it unpinned (the gate accepts a PR of any github.com repo) with the reason, so the caller can
 * warn once; it never fails boot and never becomes a default repository. The one reader of the pin.
 */
export function resolvePrRepoPin(value: string | undefined): {
  readonly repos: readonly string[];
  readonly ignored: readonly string[];
  readonly reason?: "unset" | "invalid";
} {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const repos = entries.filter((entry) => REPO_PATTERN.test(entry));
  const ignored = entries.filter((entry) => !REPO_PATTERN.test(entry));
  if (repos.length) return { repos, ignored };
  return { repos, ignored, reason: entries.length ? "invalid" : "unset" };
}

/** `owner/repo` and number of a GitHub pull request URL; `undefined` for anything else. */
export function parsePullRequestUrl(
  url: string
): { readonly owner: string; readonly repo: string; readonly number: number } | undefined {
  const match = PR_URL.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * What `pr` points at: a pull request of one of `repos` (`owner/repo`, case-insensitive), an inbox URL of a hub, or nothing.
 * With no `repos` pinned a pull request of any github.com repository is a deliverable. Whether an inbox belongs to this
 * node's hub is the adapter's local read, not this function's.
 */
export function classifyDeliverable(
  pr: string | null | undefined,
  repos?: readonly string[] | undefined
): Deliverable | undefined {
  if (!pr) return undefined;
  const parsed = parsePullRequestUrl(pr);
  if (parsed) {
    const name = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    return !repos?.length || repos.some((repo) => repo.toLowerCase() === name)
      ? { kind: "pr", url: pr }
      : undefined;
  }
  const inbox = INBOX_URL.exec(pr);
  if (inbox?.[1]) return { kind: "inbox", contribution: inbox[1] };
  return undefined;
}

/** The row after the patch: what the predicate judges. `statusRevision` is the revision at which the item entered `from`. */
export interface GateItem {
  readonly id: string;
  readonly type: WorkItemType;
  readonly pr?: string | null | undefined;
  readonly labels?: readonly string[] | undefined;
  /** axis id -> { v }. */
  readonly scores?: Readonly<Record<string, { readonly v: number }>> | null | undefined;
  /** Declared moves (only the count matters here). */
  readonly moves?: readonly unknown[] | undefined;
  readonly statusRevision: number;
}

export interface GateFacts {
  /** What `item.pr` points at (`classifyDeliverable`). */
  readonly deliverable?: Deliverable | undefined;
  /** The PR's facts, when `deliverable` is a pull request and the move reads them (`gateNeeds`). */
  readonly pr?: PrFacts | undefined;
  /** Inbox facts by contribution id. `null`: no such inbox in this node's hub. An absent key was not read. */
  readonly inboxes?: Readonly<Record<string, InboxFacts | null>> | undefined;
  /** The statuses of a story's children, read with `GATE_CHILDREN_MAX + 1` as the limit. */
  readonly children?: { readonly statuses: readonly string[] } | undefined;
  /** This hub's own origin: a story validation must name it. Unset, a story validation is refused (fail closed). */
  readonly hubOrigin?: string | undefined;
}

/** What the move found missing: an artifact kind or the fact that was not true. */
export type GateMissing =
  | GateArtifactKind
  | "closeout"
  | "scores"
  | "goal_label"
  | "moves_or_gap"
  | "pr"
  | "pr_merged"
  | "inbox_merged"
  | "children"
  | "path"
  | "terminal";

export type MoveResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** `gate_unmet`: a 409. `facts_unavailable`: a fact was not supplied; the adapter answers 503 and writes nothing. */
      readonly code: "gate_unmet" | "facts_unavailable";
      readonly missing: GateMissing;
    };

/** The six scored axes triage must fill, each with a nonzero value (hub work-item-scores-design). */
export const TRIAGE_SCORE_AXES = [
  "goal",
  "time",
  "unblocks",
  "ease",
  "confidence",
  "agent",
] as const;

type Route = "research" | "design" | "implement";

/**
 * The ladder's exits from needs_triage: one stage per triage verdict, research or design (TRIAGE_VERDICTS). There is no
 * exit to needs_implement, so every change passes design and design review (CEO 2026-11-18).
 */
export const TRIAGE_ROUTE_STAGES: Readonly<Record<(typeof TRIAGE_VERDICTS)[number], WorkItemStatus>> = {
  research: "needs_research",
  design: "needs_design",
};
const ROUTE_STAGE: Readonly<Record<string, WorkItemStatus>> = TRIAGE_ROUTE_STAGES;

/** The latest artifact of a kind on THIS item: the highest `seq` (timestamps tie; `seq` is exact). */
function latestOf(
  artifacts: readonly GateArtifact[],
  kind: GateArtifactKind,
  itemId: string
): GateArtifact | undefined {
  let best: GateArtifact | undefined;
  for (const artifact of artifacts) {
    if (artifact.kind !== kind || artifact.itemId !== itemId) continue;
    if (!best || artifact.seq > best.seq) best = artifact;
  }
  return best;
}

/** The latest artifact of a kind, only when it was written since the item entered its stage. */
function freshOf(
  artifacts: readonly GateArtifact[],
  kind: GateArtifactKind,
  item: GateItem
): GateArtifact | undefined {
  const latest = latestOf(artifacts, kind, item.id);
  return latest && latest.itemRevision >= item.statusRevision ? latest : undefined;
}

function routeOf(
  item: GateItem,
  from: WorkItemStatus,
  artifacts: readonly GateArtifact[]
): Route {
  const verdict = latestOf(artifacts, "triage", item.id)?.verdict;
  // `implement` is no longer written (TRIAGE_VERDICTS); a stored one keeps its item on the path it was triaged to.
  if (verdict === "research" || verdict === "design" || verdict === "implement")
    return verdict;
  // A migrated item with no triage artifact takes its route from its stage.
  if (from === "needs_research") return "research";
  if (from === "needs_design" || from === "needs_design_review") return "design";
  return "implement";
}

/** The stages of the item's path, triage first. */
function pathOf(
  item: GateItem,
  route: Route,
  deliverable: Deliverable | undefined
): readonly WorkItemStatus[] {
  if (route === "research")
    return item.type === "spike"
      ? ["needs_triage", "needs_research", "done"]
      : ["needs_triage", "needs_research"];
  const head: WorkItemStatus[] =
    route === "design"
      ? ["needs_triage", "needs_design", "needs_design_review", "needs_implement"]
      : ["needs_triage", "needs_implement"];
  if (item.type === "story")
    return [...head, "needs_validation", "needs_closeout", "done"];
  if (deliverable?.kind === "inbox")
    return [
      ...head,
      "needs_implementation_review",
      "needs_merge",
      "needs_closeout",
      "done",
    ];
  return [
    ...head,
    "needs_implementation_review",
    "needs_validation",
    "needs_merge",
    "needs_closeout",
    "done",
  ];
}

/** The facts a move reads, known before any lock so the adapter can fetch them first. */
export interface GateNeeds {
  /** Read the PR's head and merge state (a network read; the adapter does it before it takes the lock). */
  readonly pr: boolean;
  /** Read the story's children. */
  readonly children: boolean;
  /** Read the artifacts and the inbox heads they and `pr` name. */
  readonly artifacts: boolean;
}

const NO_NEEDS: GateNeeds = { pr: false, children: false, artifacts: false };

const PR_STAGES: readonly WorkItemStatus[] = [
  "needs_implementation_review",
  "needs_validation",
  "needs_merge",
];

/**
 * What the move reads, a superset known without the artifacts (the route needs them): a move to needs_triage or a cancel, or a
 * move from a legacy status, reads nothing. A move to any other ladder stage reads the artifacts, forward or back, because the
 * item's path depends on its latest triage (a design-route item may go back to needs_design; without its triage artifact the
 * route would read as implement). Only a forward move reads the PR (a code item leaving review, validation or merge) or the
 * children (a story leaving implement).
 */
export function gateNeeds(
  item: GateItem,
  from: WorkItemStatus,
  to: WorkItemStatus,
  deliverable: Deliverable | undefined
): GateNeeds {
  const toRank = statusRank(to);
  if (statusRank(from) < 0 || toRank <= 0) return NO_NEEDS;
  const forward = toRank > statusRank(from);
  return {
    pr:
      forward &&
      item.type !== "story" &&
      deliverable?.kind === "pr" &&
      PR_STAGES.includes(from),
    children: forward && item.type === "story" && from === "needs_implement",
    artifacts: true,
  };
}

const OK: MoveResult = { ok: true };
const unmet = (missing: GateMissing): MoveResult => ({
  ok: false,
  code: "gate_unmet",
  missing,
});
const unavailable = (missing: GateMissing): MoveResult => ({
  ok: false,
  code: "facts_unavailable",
  missing,
});

const hasGoalLabel = (labels: readonly string[] | undefined) =>
  (labels ?? []).some((label) => label.startsWith("goal:"));

/** Each of the six named axes carries a nonzero score; another axis name never stands in for one. */
function scoresFilled(item: GateItem): boolean {
  return TRIAGE_SCORE_AXES.every((axis) => (item.scores?.[axis]?.v ?? 0) > 0);
}

/**
 * The implementation review that approved this deliverable: the latest one (highest `seq`), only while it approves. Its `head` is
 * the approved head and its `seq` orders the validation that must follow it.
 */
function approvedReview(
  artifacts: readonly GateArtifact[],
  item: GateItem,
  deliverable: Deliverable | undefined
): { readonly head: string; readonly seq: number } | undefined {
  const review = latestOf(artifacts, "implementation_review", item.id);
  if (!review || review.verdict !== "approve") return undefined;
  const subject = parseArtifactSubject(review.subject);
  if (deliverable?.kind === "pr")
    return subject?.form === "pr" && subject.url === item.pr
      ? { head: subject.head, seq: review.seq }
      : undefined;
  if (deliverable?.kind === "inbox")
    return subject?.form === "knowledge" &&
      subject.contribution === deliverable.contribution
      ? { head: subject.head, seq: review.seq }
      : undefined;
  return undefined;
}

/**
 * PATH_CHANGES_ONLY_VIA_TRIAGE: a patch that changes the deliverable kind of `pr` (a pull request to an inbox or back) at
 * needs_implementation_review or later is refused, unless the same patch moves the item back to needs_implement or earlier
 * (or cancels it). Setting a first `pr`, or one of the same kind, is not a path change.
 */
export function refusesPathChange(
  from: WorkItemStatus,
  to: WorkItemStatus,
  currentPr: string | null | undefined,
  nextPr: string | null | undefined,
  repos?: readonly string[] | undefined
): boolean {
  if (nextPr === undefined || nextPr === null || nextPr === (currentPr ?? "")) return false;
  const before = classifyDeliverable(currentPr, repos)?.kind;
  const after = classifyDeliverable(nextPr, repos)?.kind;
  if (!before || !after || before === after) return false;
  if (statusRank(from) < statusRank("needs_implementation_review")) return false;
  if (to === "cancelled") return false;
  const rank = statusRank(to);
  return !(rank >= 0 && rank <= statusRank("needs_implement"));
}

/**
 * May `item` move from `from` to `to`? `item` is the row after the patch, so one patch that sets `pr`, scores, labels or
 * `moves` together with the status is judged as a whole. `artifacts` are the item's artifacts. Pure: the adapter reads everything.
 */
export function evaluateMove(
  item: GateItem,
  from: WorkItemStatus,
  to: WorkItemStatus,
  artifacts: readonly GateArtifact[],
  facts: GateFacts
): MoveResult {
  if (to === from) return OK;
  if (from === "done" || from === "cancelled") return unmet("terminal");
  if (to === "blocked") return unmet("path");
  // BACK_IS_FREE: to triage or cancelled from any live status, including a legacy one.
  if (to === "cancelled" || to === "needs_triage") return OK;
  if (isLegacyStatus(from)) return unmet("path");

  const deliverable = facts.deliverable;
  const inbox = (contribution: string): InboxFacts | null | undefined =>
    facts.inboxes?.[contribution];

  if (from === "needs_triage") return leaveTriage(item, to, artifacts);

  const route = routeOf(item, from, artifacts);
  const path = pathOf(item, route, deliverable);
  const fromIndex = path.indexOf(from);
  const toIndex = path.indexOf(to);
  if (toIndex < 0 || fromIndex < 0) return unmet("path");
  if (toIndex < fromIndex) return OK;
  if (toIndex !== fromIndex + 1) return unmet("path");

  switch (from) {
    case "needs_research": {
      // A spike answers its question in a hub inbox; the move to done is that inbox merged.
      if (deliverable?.kind !== "inbox") return unmet("pr");
      const state = inbox(deliverable.contribution);
      if (state === undefined) return unavailable("inbox_merged");
      return state?.merged ? OK : unmet("inbox_merged");
    }
    case "needs_design":
      return OK;
    case "needs_design_review": {
      const review = freshOf(artifacts, "design_review", item);
      if (!review || review.verdict !== "approve") return unmet("design_review");
      const subject = parseArtifactSubject(review.subject);
      if (subject?.form !== "knowledge") return unmet("design_review");
      const state = inbox(subject.contribution);
      if (state === undefined) return unavailable("design_review");
      return state && state.head && state.head === subject.head
        ? OK
        : unmet("design_review");
    }
    case "needs_implement": {
      if (item.type === "story") {
        const children = facts.children?.statuses;
        if (!children) return unavailable("children");
        const settled = children.every((s) => s === "done" || s === "cancelled");
        return children.length <= GATE_CHILDREN_MAX &&
          settled &&
          children.includes("done")
          ? OK
          : unmet("children");
      }
      if (!deliverable) return unmet("pr");
      if (deliverable.kind === "inbox") {
        const state = inbox(deliverable.contribution);
        if (state === undefined) return unavailable("pr");
        if (!state) return unmet("pr");
      }
      return OK;
    }
    case "needs_implementation_review": {
      const review = freshOf(artifacts, "implementation_review", item);
      if (!review || review.verdict !== "approve") return unmet("implementation_review");
      const subject = parseArtifactSubject(review.subject);
      if (deliverable?.kind === "pr") {
        if (!facts.pr) return unavailable("pr");
        return subject?.form === "pr" &&
          subject.url === item.pr &&
          subject.head === facts.pr.head
          ? OK
          : unmet("implementation_review");
      }
      if (deliverable?.kind === "inbox") {
        const state = inbox(deliverable.contribution);
        if (state === undefined) return unavailable("implementation_review");
        return state &&
          state.head &&
          subject?.form === "knowledge" &&
          subject.contribution === deliverable.contribution &&
          subject.head === state.head
          ? OK
          : unmet("implementation_review");
      }
      return unmet("pr");
    }
    case "needs_validation": {
      const validation = freshOf(artifacts, "validation", item);
      if (!validation || !isPassGrade(validation.rows, validation.verdict))
        return unmet("validation");
      const subject = parseArtifactSubject(validation.subject);
      if (item.type === "story") {
        if (subject?.form !== "build") return unmet("validation");
        // FAIL_CLOSED: a story validation must name this hub's own origin; with none configured nothing can.
        // The same normalisation the write side applies (`isOwnOrigin`): scheme, host and port, case and a trailing slash aside.
        return isOwnOrigin(subject.origin, facts.hubOrigin) ? OK : unmet("validation");
      }
      if (deliverable?.kind !== "pr") return unmet("pr");
      if (!facts.pr) return unavailable("pr");
      const head = approvedReview(artifacts, item, deliverable)?.head;
      if (!head) return unmet("implementation_review");
      return subject?.form === "pr" &&
        subject.url === item.pr &&
        subject.head === head &&
        facts.pr.head === head
        ? OK
        : unmet("validation");
    }
    case "needs_merge": {
      const approved = approvedReview(artifacts, item, deliverable);
      if (!approved) return unmet("implementation_review");
      const head = approved.head;
      if (deliverable?.kind === "pr") {
        // A code item leaves merge only on a validation that still stands: the latest, PASS-grade, of this PR at the approved
        // head, written after the approval (a later approve restarts validation). `itemRevision` cannot order it: the
        // validation was written before the item entered needs_merge.
        const validation = latestOf(artifacts, "validation", item.id);
        const validated = validation ? parseArtifactSubject(validation.subject) : undefined;
        if (
          !validation ||
          !isPassGrade(validation.rows, validation.verdict) ||
          validated?.form !== "pr" ||
          validated.url !== item.pr ||
          validated.head !== head ||
          validation.seq <= approved.seq
        )
          return unmet("validation");
        if (!facts.pr) return unavailable("pr");
        if (facts.pr.head !== head) return unmet("implementation_review");
        return facts.pr.merged ? OK : unmet("pr_merged");
      }
      if (deliverable?.kind === "inbox") {
        const state = inbox(deliverable.contribution);
        if (state === undefined) return unavailable("inbox_merged");
        if (!state || state.head !== head) return unmet("implementation_review");
        return state.merged ? OK : unmet("inbox_merged");
      }
      return unmet("pr");
    }
    case "needs_closeout": {
      // The exit of closeout: the latest closeout artifact, written since the item entered it, says done.
      const closeout = freshOf(artifacts, "closeout", item);
      return closeout?.verdict === "done" ? OK : unmet("closeout");
    }
    default:
      return unmet("path");
  }
}

/** The exit of needs_triage: a triage artifact, six scores, a goal label, and `moves` or a measurement gap. */
function leaveTriage(
  item: GateItem,
  to: WorkItemStatus,
  artifacts: readonly GateArtifact[]
): MoveResult {
  const routed = Object.values(ROUTE_STAGE);
  if (!routed.includes(to)) return unmet("path");
  const triage = freshOf(artifacts, "triage", item);
  if (!triage || ROUTE_STAGE[triage.verdict] !== to) return unmet("triage");
  const subject = parseArtifactSubject(triage.subject);
  if (subject?.form !== "work" || subject.itemId !== item.id) return unmet("triage");
  if (!scoresFilled(item)) return unmet("scores");
  if (!hasGoalLabel(item.labels)) return unmet("goal_label");
  if ((item.moves?.length ?? 0) === 0 && !triage.note?.trim()) return unmet("moves_or_gap");
  return OK;
}
