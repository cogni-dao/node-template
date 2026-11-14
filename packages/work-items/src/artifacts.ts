// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/artifacts`
 * Purpose: The immutable review artifact record of a work item (task.0028, story.0047): the typed contract, the
 *   server-computed PASS-grade, the independence check and the framework-agnostic record and list handlers.
 * Scope: Pure contract and decisions over injected ports (`WorkItemArtifactStore`, the item store's `get` and `history`,
 *   `ContributionAuthorPort`). Imports no web framework, auth, container or logger. Never reads knowledge tables.
 * Invariants:
 *   - INSERT_ONLY: the store has no update or delete; a later verdict is a new row, never an edit.
 *   - AUTHOR_IS_STAMPED: the caller never names the author; the handler stamps the authenticated principal.
 *   - INDEPENDENCE_IS_HERE: the package refuses a review or validation from the subject's author; the route is a shell.
 *     An inbox subject's author is the inbox `principalId` (through the port). A PR subject's author is the principal
 *     that last set the item's `pr`; a build subject's (a story), the principal that last moved it to needs_validation.
 *     History says who; if it cannot show an author the write is refused (fail closed). A `triage` artifact has NO
 *     independence rule: it names who routed.
 *   - ITEM_REVISION_IS_STAMPED: the store stamps the item's revision, read inside the writer lock, never the caller.
 *   - OWN_ORIGIN_ONLY: a build subject (`<origin>@<buildSha>`) must name this hub's own origin (`deps.ownOrigin`); with none configured it is refused.
 *   - BODY_STAYS_OFF_THE_ITEM_READ: the item read carries the latest artifact of each kind without `body`; the list may carry it.
 *   - PASS_GRADE_IS_COMPUTED: `isPassGrade` decides from `rows` and the headline; a caller never sends a grade.
 *   - NEVER_THROWS: every handler failure becomes a status; a missing item is 404, a failed read or write 503. A write whose outcome is unknown (`WorkItemWriteOutcomeUnknownError`) is a distinct 409 `work_item_write_outcome_unknown`, `retryable: false`: the caller must inspect, never replay into a duplicate.
 *   - ONE_EVENT_PER_REFUSAL: every non-success write (400, 404, 409, 503) logs `work.items.artifact_refused`; `work.items.artifact_recorded` is a success only.
 *   - RECORDING_NEVER_MOVES_STATUS: this module never reads or writes an item's status.
 * Side-effects: IO (through the injected ports)
 * Links: hub work-item-artifacts, work-status-ladder, change-history-design
 * @public
 */

import { z } from "zod";

import { CITE_COMMIT_PATTERN, CITE_CONTRIBUTION_PATTERN } from "./cites.js";
import type { HistoryEntry } from "./history.js";
import { errorDetail } from "./history-read.js";
import { toWorkItemId, type WorkItemId } from "./types.js";
import { workItemWriteErrorResponse } from "./write-errors.js";

export const ARTIFACT_KINDS = [
  "triage",
  "design_review",
  "implementation_review",
  "validation",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const TRIAGE_VERDICTS = ["research", "design", "implement"] as const;
export const REVIEW_VERDICTS = ["approve", "request_changes"] as const;
export const VALIDATION_VERDICTS = ["pass", "notes", "fail"] as const;

/** The verdicts each kind accepts. */
export const VERDICTS_BY_KIND: Readonly<
  Record<ArtifactKind, readonly string[]>
> = {
  triage: TRIAGE_VERDICTS,
  design_review: REVIEW_VERDICTS,
  implementation_review: REVIEW_VERDICTS,
  validation: VALIDATION_VERDICTS,
};

/** Most artifacts a list returns, and most scorecard rows one validation holds. */
export const ARTIFACTS_LIST_MAX = 50;
export const ARTIFACT_ROWS_MAX = 50;
export const ARTIFACT_URL_MAX = 2048;
export const ARTIFACT_NOTE_MAX = 240;
export const ARTIFACT_BODY_MAX = 16_000;
const TWEAK_MAX = 200;
const REASON_MAX = 500;

// ---------------------------------------------------------------------------
// Scorecard rows: lossless against the canonical /validate-candidate scorecard.
// ---------------------------------------------------------------------------

/** HUMAN, AI, LOKI and TRACE cells: one emoji, or `—` when the axis does not apply. */
export const SCORECARD_CELLS = ["🔴", "🟡", "🟢", "—"] as const;
/** OVERALL cell: the emoji and the CAPS label, exactly as the scorecard prints them. */
export const SCORECARD_OVERALLS = [
  "🔴 FAIL",
  "🔴 DRIFT",
  "🟡 INDIRECT",
  "🟡 UNPROVEN",
  "🟢 PASS",
  "⚪ N/A",
] as const;
export type ScorecardOverall = (typeof SCORECARD_OVERALLS)[number];

const noNul = (value: string) => !value.includes("\u0000");

const CellSchema = z.enum(SCORECARD_CELLS);

export const ScorecardRowSchema = z.object({
  tweak: z.string().trim().min(1).max(TWEAK_MAX).refine(noNul, "no NUL"),
  human: CellSchema,
  ai: CellSchema,
  loki: CellSchema,
  trace: CellSchema,
  overall: z.enum(SCORECARD_OVERALLS),
  /** Why a non-green row is UNPROVEN or INDIRECT; PASS-grade needs it on each of those rows. */
  reason: z.string().trim().min(1).max(REASON_MAX).refine(noNul, "no NUL").optional(),
});
export type ScorecardRow = z.infer<typeof ScorecardRowSchema>;

const FAILING: ReadonlySet<string> = new Set(["🔴 FAIL", "🔴 DRIFT"]);
const NEEDS_REASON: ReadonlySet<string> = new Set([
  "🟡 INDIRECT",
  "🟡 UNPROVEN",
]);

/**
 * PASS-grade, computed on the server from `rows` and the headline (never sent by a caller):
 * no row is FAIL or DRIFT, and each UNPROVEN or INDIRECT row has a `reason`. `notes` passes only
 * then; `pass` follows the same rule; `fail` never passes. Missing evidence is unscorable, never
 * a pass: no rows is not PASS-grade.
 */
export function isPassGrade(
  rows: readonly Pick<ScorecardRow, "overall" | "reason">[] | null | undefined,
  verdict: string
): boolean {
  if (verdict !== "pass" && verdict !== "notes") return false;
  if (!rows || rows.length === 0) return false;
  for (const row of rows) {
    if (FAILING.has(row.overall)) return false;
    if (NEEDS_REASON.has(row.overall) && !row.reason?.trim()) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Subjects: the revision judged.
// ---------------------------------------------------------------------------

const WORK_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export type ArtifactSubject =
  | { readonly form: "knowledge"; readonly contribution: string; readonly head: string }
  | { readonly form: "work"; readonly itemId: string }
  | { readonly form: "pr"; readonly url: string; readonly head: string }
  | { readonly form: "build"; readonly origin: string; readonly buildSha: string };

export type SubjectForm = ArtifactSubject["form"];

/** The subject formats each kind accepts. */
export const SUBJECT_FORMS_BY_KIND: Readonly<
  Record<ArtifactKind, readonly SubjectForm[]>
> = {
  triage: ["work"],
  design_review: ["knowledge"],
  implementation_review: ["pr", "knowledge"],
  validation: ["pr", "build"],
};

/**
 * `work:<itemId>` (triage), `knowledge:<contrib-id>@<head commit>`, `<PR URL>@<40-hex head>` or
 * `<origin>@<40-hex buildSha>`; `undefined` for anything else.
 */
export function parseArtifactSubject(subject: string): ArtifactSubject | undefined {
  if (subject.startsWith("work:")) {
    const itemId = subject.slice("work:".length);
    return WORK_ID.test(itemId) ? { form: "work", itemId } : undefined;
  }
  const at = subject.lastIndexOf("@");
  if (at < 1) return undefined;
  const left = subject.slice(0, at);
  const right = subject.slice(at + 1);
  if (left.startsWith("knowledge:")) {
    const contribution = left.slice("knowledge:".length);
    return CITE_CONTRIBUTION_PATTERN.test(contribution) && CITE_COMMIT_PATTERN.test(right)
      ? { form: "knowledge", contribution, head: right }
      : undefined;
  }
  if (PR_URL.test(left)) {
    return GIT_SHA.test(right) ? { form: "pr", url: left, head: right } : undefined;
  }
  if (ORIGIN.test(left)) {
    return GIT_SHA.test(right) ? { form: "build", origin: left, buildSha: right } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The record a caller writes, and the record as stored.
// ---------------------------------------------------------------------------

const UrlSchema = z
  .string()
  .max(ARTIFACT_URL_MAX)
  .regex(/^https?:\/\/[^\s]+$/, "url must be an http(s) link with no whitespace");

const NoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_NOTE_MAX)
  .refine((value) => !/[\r\n\u0085\u2028\u2029]/.test(value), "note is one line")
  .refine(noNul, "no NUL");
const BodySchema = z.string().min(1).max(ARTIFACT_BODY_MAX).refine(noNul, "no NUL");

/**
 * The body of `POST /api/v1/work/items/{id}/artifacts`. The author and the item revision are never in it: the
 * server stamps the authenticated principal and the item's current revision.
 */
export const WorkItemArtifactInputSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    subject: z.string().min(3).max(512),
    verdict: z.string().min(1).max(32),
    rows: z.array(ScorecardRowSchema).max(ARTIFACT_ROWS_MAX).optional(),
    note: NoteSchema.optional(),
    body: BodySchema.optional(),
    url: UrlSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!VERDICTS_BY_KIND[value.kind].includes(value.verdict)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: `${value.kind} verdict must be one of ${VERDICTS_BY_KIND[value.kind].join(", ")}`,
      });
    }
    const subject = parseArtifactSubject(value.subject);
    if (!subject) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message:
          "subject must be work:<itemId> (triage), knowledge:<contrib-id>@<head commit>, <PR URL>@<40-hex head> or <origin>@<40-hex buildSha>",
      });
    } else if (!SUBJECT_FORMS_BY_KIND[value.kind].includes(subject.form)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: `${value.kind} subject must be ${SUBJECT_FORMS_BY_KIND[value.kind].join(" or ")}`,
      });
    }
    if (value.kind === "validation") {
      if (!value.rows?.length) {
        ctx.addIssue({
          code: "custom",
          path: ["rows"],
          message: "a validation carries the scorecard rows: at least one",
        });
      }
    } else if (value.rows !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["rows"],
        message: "rows belong to a validation only",
      });
    }
    // A review or validation must point at its full text: a PR comment or scorecard (`url`), or `body` when none exists.
    if (value.kind !== "triage" && value.url === undefined && value.body === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `a ${value.kind} needs a url or a body`,
      });
    }
  });
export type WorkItemArtifactInput = z.infer<typeof WorkItemArtifactInputSchema>;

/** A stored artifact as the wire carries it. `passGrade` is derived on read, never stored. */
export const WorkItemArtifactSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  /** The item's revision when this was written, stamped by the server. */
  itemRevision: z.number().int(),
  kind: z.enum(ARTIFACT_KINDS),
  subject: z.string(),
  verdict: z.string(),
  rows: z.array(ScorecardRowSchema).optional(),
  passGrade: z.boolean().optional(),
  note: z.string().optional(),
  /** The full review, when no PR comment holds it. The list and the write answer carry it; the item read does not. */
  body: z.string().optional(),
  url: z.string().optional(),
  author: z.string(),
  createdAt: z.string(),
});
export type WorkItemArtifact = z.infer<typeof WorkItemArtifactSchema>;

/** An artifact as the item read carries it: everything but `body`. */
export const WorkItemArtifactSummarySchema = WorkItemArtifactSchema.omit({ body: true });
export type WorkItemArtifactSummary = z.infer<typeof WorkItemArtifactSummarySchema>;

/** The latest artifact of each kind, for the item read, without `body`. `unavailable` is never an empty answer. */
export const WorkItemArtifactsLatestSchema = z.object({
  triage: WorkItemArtifactSummarySchema.optional(),
  design_review: WorkItemArtifactSummarySchema.optional(),
  implementation_review: WorkItemArtifactSummarySchema.optional(),
  validation: WorkItemArtifactSummarySchema.optional(),
  unavailable: z.literal(true).optional(),
});
export type WorkItemArtifactsLatest = z.infer<typeof WorkItemArtifactsLatestSchema>;

/** The row a store inserts. `author` is the stamped principal; the store stamps `itemRevision` inside its writer lock. */
export interface NewWorkItemArtifact {
  readonly itemId: string;
  readonly kind: ArtifactKind;
  readonly subject: string;
  readonly verdict: string;
  readonly rows?: readonly ScorecardRow[] | undefined;
  readonly note?: string | undefined;
  readonly body?: string | undefined;
  readonly url?: string | undefined;
  readonly author: string;
}

/** Insert-only storage. There is no update and no delete. */
export interface WorkItemArtifactStore {
  /** Inserts one row inside the store's writer path; resolves with the stored row. */
  insert(row: NewWorkItemArtifact): Promise<WorkItemArtifact>;
  /** Newest first, at most `ARTIFACTS_LIST_MAX`. */
  list(itemId: string): Promise<readonly WorkItemArtifact[]>;
  /** The newest artifact of each kind, in one read, without `body`. */
  latest(itemId: string): Promise<readonly WorkItemArtifact[]>;
}

/** A row with `passGrade` derived (validation only). */
export function withPassGrade(artifact: WorkItemArtifact): WorkItemArtifact {
  return artifact.kind === "validation"
    ? { ...artifact, passGrade: isPassGrade(artifact.rows, artifact.verdict) }
    : artifact;
}

/** One artifact per kind, the newest of each (a store returns at most one of a kind; the first wins). */
export function toLatestArtifacts(
  artifacts: readonly WorkItemArtifact[]
): WorkItemArtifactsLatest {
  const latest: { -readonly [K in ArtifactKind]?: WorkItemArtifactSummary } = {};
  for (const artifact of artifacts) {
    if (latest[artifact.kind]) continue;
    // BODY_STAYS_OFF_THE_ITEM_READ: the full review is on the list, never on the item.
    const { body: _body, ...summary } = withPassGrade(artifact);
    latest[artifact.kind] = summary;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Independence.
// ---------------------------------------------------------------------------

/** Reads an inbox's author. `null`: no such inbox. A throw is a failed read. */
export interface ContributionAuthorPort {
  principalOf(contributionId: string, signal: AbortSignal): Promise<string | null>;
}

/** The slice of the item store the handlers read. */
export interface ArtifactItemStore {
  get(id: WorkItemId): Promise<{ readonly revision: number; readonly pr?: string | undefined } | null>;
  history?(id: WorkItemId): Promise<readonly HistoryEntry[]>;
}

export interface WorkItemArtifactDeps {
  readonly items: ArtifactItemStore;
  readonly artifacts: WorkItemArtifactStore;
  /** Without it an inbox subject has no known author, so the write is refused. */
  readonly inboxes?: ContributionAuthorPort | undefined;
  /** This hub's own public origin (the app's configured one). A build subject must name it; with none, a build subject is refused. */
  readonly ownOrigin?: string | undefined;
}

type AuthorOutcome =
  | { readonly ok: true; readonly author: string }
  | { readonly ok: false; readonly reason: string };

const AUTHOR_READ_MS = 5_000;

/** Newest history entry that moved `field` and whose new value passes `accept`; its actor. */
function lastActor(
  history: readonly HistoryEntry[],
  field: string,
  accept: (after: unknown) => boolean
): AuthorOutcome {
  for (const entry of history) {
    if (!entry.changed.includes(field)) continue;
    if (!accept(entry.diff[field]?.after)) continue;
    return entry.actor
      ? { ok: true, author: entry.actor }
      : { ok: false, reason: "author_unknown" };
  }
  return { ok: false, reason: "author_unknown" };
}

/**
 * Who authored the subject. History is newest first; its actor is the principal that wrote the commit.
 * A throw means the read failed (503). Anything that cannot name an author is a refusal, not a pass.
 */
async function subjectAuthor(
  deps: WorkItemArtifactDeps,
  itemId: string,
  item: { readonly pr?: string | undefined },
  subject: ArtifactSubject
): Promise<AuthorOutcome> {
  if (subject.form === "knowledge") {
    if (!deps.inboxes) return { ok: false, reason: "author_unknown" };
    const principal = await deps.inboxes.principalOf(
      subject.contribution,
      AbortSignal.timeout(AUTHOR_READ_MS)
    );
    return principal
      ? { ok: true, author: principal }
      : { ok: false, reason: "author_unknown" };
  }
  if (!deps.items.history) return { ok: false, reason: "author_unknown" };
  const history = await deps.items.history(toWorkItemId(itemId));
  switch (subject.form) {
    case "pr":
      return lastActor(history, "pr", (after) => after === item.pr);
    case "work":
      // Triage has no independence rule; the handler never asks.
      return { ok: false, reason: "author_unknown" };
    case "build":
      return lastActor(history, "status", (after) => after === "needs_validation");
  }
}

// ---------------------------------------------------------------------------
// Handlers: `{ status, body, log }`, never throw.
// ---------------------------------------------------------------------------

export type ArtifactErrorCode =
  | "invalid_input"
  | "not_found"
  | "artifact_author_not_independent"
  | "artifacts_unavailable"
  | "work_item_write_outcome_unknown";

/** One terminal log record per call: counts and codes, never a body, a row or a url. */
export interface ArtifactLog {
  readonly event:
    | "work.items.artifact_recorded"
    | "work.items.artifact_refused"
    | "work.items.artifacts_read";
  readonly status: 200 | 201 | 400 | 404 | 409 | 503;
  readonly outcome: "success" | "refused" | "error";
  readonly workItemId: string;
  readonly kind?: ArtifactKind;
  readonly verdict?: string;
  readonly passGrade?: boolean;
  readonly rowCount?: number;
  readonly artifactCount?: number;
  readonly errorCode?: ArtifactErrorCode;
  /** Why an independence check refused: `same_principal` or `author_unknown`. */
  readonly reason?: string;
  /** Set on a failed call so the route may warn with the error class. */
  readonly errorName?: string;
  /** Database error code (SQLSTATE) from the thrown error, when it carries one. */
  readonly dbCode?: string;
  /** First 300 chars of the thrown error's message, CR/LF collapsed. */
  readonly errorMessage?: string;
}

export interface ArtifactResult {
  readonly status: 200 | 201 | 400 | 404 | 409 | 503;
  readonly body: unknown;
  readonly log: ArtifactLog;
}

const RECORDED = "work.items.artifact_recorded" as const;
const REFUSED = "work.items.artifact_refused" as const;
const READ = "work.items.artifacts_read" as const;

/** A refused write logs under its own event so a refusal is as findable as a success. */
const refusedEvent = (event: ArtifactLog["event"]): ArtifactLog["event"] =>
  event === RECORDED ? REFUSED : event;

const UNAVAILABLE_BODY = {
  error: "artifacts_unavailable",
  errorCode: "artifacts_unavailable",
} as const;

const notFound = (id: string, event: ArtifactLog["event"]): ArtifactResult => ({
  status: 404,
  body: { error: `Work item not found: ${id}`, errorCode: "not_found" },
  log: {
    event: refusedEvent(event),
    status: 404,
    outcome: "refused",
    workItemId: id,
    errorCode: "not_found",
  },
});

const unavailable = (
  id: string,
  event: ArtifactLog["event"],
  error: unknown,
  extra: Partial<ArtifactLog> = {}
): ArtifactResult => {
  // A write whose outcome is unknown may have landed: say so, and never invite a replay.
  const mapped = workItemWriteErrorResponse(error, "create");
  if (mapped?.errorCode === "work_item_write_outcome_unknown") {
    return {
      status: 409,
      body: mapped.body,
      log: {
        event: refusedEvent(event),
        status: 409,
        outcome: "error",
        workItemId: id,
        errorCode: "work_item_write_outcome_unknown",
        errorName: "WorkItemWriteOutcomeUnknownError",
        ...extra,
      },
    };
  }
  return {
    status: 503,
    body: UNAVAILABLE_BODY,
    log: {
      event: refusedEvent(event),
      status: 503,
      outcome: "error",
      workItemId: id,
      errorCode: "artifacts_unavailable",
      errorName: (error as Error | undefined)?.name ?? "Error",
      ...errorDetail(error),
      ...extra,
    },
  };
};

/** The body was not JSON: a 400 that logs like every other refusal. */
export function artifactInvalidJson(itemId: string): ArtifactResult {
  return {
    status: 400,
    body: { error: "invalid JSON body", errorCode: "invalid_input" },
    log: {
      event: REFUSED,
      status: 400,
      outcome: "refused",
      workItemId: itemId,
      errorCode: "invalid_input",
    },
  };
}

/** This node has no artifact store wired (no Doltgres): a 503 that logs like every other refusal. */
export function artifactsNotConfigured(
  itemId: string,
  operation: "write" | "read"
): ArtifactResult {
  return {
    status: 503,
    body: UNAVAILABLE_BODY,
    log: {
      event: operation === "write" ? REFUSED : READ,
      status: 503,
      outcome: "error",
      workItemId: itemId,
      errorCode: "artifacts_unavailable",
      errorName: "ArtifactsNotConfigured",
    },
  };
}

const invalid = (
  id: string,
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
  extra: Partial<ArtifactLog> = {}
): ArtifactResult => ({
  status: 400,
  body: { error: "invalid input", errorCode: "invalid_input", issues },
  log: {
    event: REFUSED,
    status: 400,
    outcome: "refused",
    workItemId: id,
    errorCode: "invalid_input",
    ...extra,
  },
});

/** Same origin, ignoring case and a trailing slash. No configured origin matches nothing. */
function isOwnOrigin(origin: string, own: string | undefined): boolean {
  if (!own) return false;
  try {
    return new URL(origin).origin === new URL(own).origin;
  } catch {
    return false;
  }
}

/**
 * Records one artifact on item `itemId` as `principalId`. The caller's body is parsed, the subject must belong
 * to the item (a build subject to this hub's own origin), and a review or validation must not come from the
 * subject's author. Triage has no independence rule. Recording never changes the item's status.
 */
export async function recordWorkItemArtifact(
  deps: WorkItemArtifactDeps,
  itemId: string,
  principalId: string,
  body: unknown
): Promise<ArtifactResult> {
  const parsed = WorkItemArtifactInputSchema.safeParse(body);
  if (!parsed.success) {
    const kind = (body as { kind?: unknown } | null)?.kind;
    return invalid(
      itemId,
      parsed.error.issues.map((issue) => ({
        path: issue.path.filter((p): p is string | number => typeof p !== "symbol"),
        message: issue.message,
      })),
      typeof kind === "string" && (ARTIFACT_KINDS as readonly string[]).includes(kind)
        ? { kind: kind as ArtifactKind }
        : {}
    );
  }
  const input = parsed.data;
  const base = { kind: input.kind, verdict: input.verdict } as const;
  const subject = parseArtifactSubject(input.subject);
  if (!subject) {
    // The schema parsed the subject already; this keeps the handler total.
    return invalid(itemId, [{ path: ["subject"], message: "unrecognized subject" }], base);
  }

  let item: Awaited<ReturnType<ArtifactItemStore["get"]>>;
  try {
    item = await deps.items.get(toWorkItemId(itemId));
  } catch (error) {
    return unavailable(itemId, RECORDED, error, base);
  }
  if (!item) return notFound(itemId, RECORDED);

  // The subject must belong to this item, so its author is the right one to compare against.
  const mismatch = (message: string): ArtifactResult =>
    invalid(itemId, [{ path: ["subject"], message }], base);
  if (subject.form === "work" && subject.itemId !== itemId)
    return mismatch("subject names a different work item");
  if (subject.form === "pr" && subject.url !== item.pr)
    return mismatch("subject is not this item's pr");
  if (subject.form === "build" && !isOwnOrigin(subject.origin, deps.ownOrigin))
    return mismatch("subject origin is not this hub's own origin");

  // Triage has no independence rule: the artifact names who routed.
  let author: AuthorOutcome = { ok: true, author: "" };
  if (subject.form !== "work") {
    try {
      author = await subjectAuthor(deps, itemId, item, subject);
    } catch (error) {
      return unavailable(itemId, RECORDED, error, base);
    }
  }
  if (subject.form !== "work" && (!author.ok || author.author === principalId)) {
    const reason = author.ok ? "same_principal" : author.reason;
    return {
      status: 409,
      body: {
        error: "artifact author is not independent of the subject's author",
        errorCode: "artifact_author_not_independent",
        reason,
      },
      log: {
        event: REFUSED,
        status: 409,
        outcome: "refused",
        workItemId: itemId,
        ...base,
        errorCode: "artifact_author_not_independent",
        reason,
      },
    };
  }

  try {
    const stored = withPassGrade(
      await deps.artifacts.insert({
        itemId,
        kind: input.kind,
        subject: input.subject,
        verdict: input.verdict,
        ...(input.rows ? { rows: input.rows } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        author: principalId,
      })
    );
    return {
      status: 201,
      body: { artifact: stored },
      log: {
        event: RECORDED,
        status: 201,
        outcome: "success",
        workItemId: itemId,
        ...base,
        ...(stored.passGrade !== undefined ? { passGrade: stored.passGrade } : {}),
        ...(input.rows ? { rowCount: input.rows.length } : {}),
      },
    };
  } catch (error) {
    return unavailable(itemId, RECORDED, error, base);
  }
}

/** The artifacts of one item, newest first, at most `ARTIFACTS_LIST_MAX`. */
export async function listWorkItemArtifacts(
  deps: WorkItemArtifactDeps,
  itemId: string
): Promise<ArtifactResult> {
  try {
    if (!(await deps.items.get(toWorkItemId(itemId)))) return notFound(itemId, READ);
    const artifacts = (await deps.artifacts.list(itemId))
      .slice(0, ARTIFACTS_LIST_MAX)
      .map(withPassGrade);
    return {
      status: 200,
      body: { items: artifacts },
      log: {
        event: READ,
        status: 200,
        outcome: "success",
        workItemId: itemId,
        artifactCount: artifacts.length,
      },
    };
  } catch (error) {
    return unavailable(itemId, READ, error);
  }
}

export const workItemsArtifactsCreateOperation = {
  id: "work.items.artifacts.create.v1",
  summary: "Record a review or validation artifact on a work item",
  description:
    "Writes one immutable artifact: a triage (routes research, design or implement), a design review, an implementation review or a validation (with the canonical scorecard rows). The author is the authenticated principal; a review or validation must not come from the subject's author (triage has no such rule). The server stamps the item's revision and computes PASS-grade from the rows. A review or validation needs a `url` or a `body`. Recording never changes the item's status.",
  input: WorkItemArtifactInputSchema,
  output: z.object({ artifact: WorkItemArtifactSchema }),
} as const;

export const workItemsArtifactsListOperation = {
  id: "work.items.artifacts.list.v1",
  summary: "List a work item's artifacts",
  description: "Newest first, at most 50, each with its `body` when it has one.",
  input: z.object({ id: z.string() }),
  output: z.object({ items: z.array(WorkItemArtifactSchema).max(ARTIFACTS_LIST_MAX) }),
} as const;
