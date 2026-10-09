// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Doltgres runtime authority for deployed work items. */

import { randomUUID } from "node:crypto";
import type {
  ActorKind,
  ExternalRef,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation,
} from "../../index.js";
import { toWorkItemId } from "../../index.js";
import type { ReservedSql, Sql } from "postgres";

import type {
  WorkItemsCreateInput,
  WorkItemsDoltgresPort,
  WorkItemsPatchInput,
  WorkItemsPatchSet,
} from "./ports.js";

import {
  decodeCursor,
  encodeCursor,
  type WorkItemCursor,
} from "./cursor.js";

export const OPERATOR_ID_FLOOR = 5000;
const AUTO_ID_RETRIES = 5;
const CLAIM_TTL_SECONDS = 300;
const COMMIT_TAG = "work-items";
const GLOBAL_LOCK_KEY = 5_001_001;
const OP_BRANCH_PREFIX = "work-item-op/";
/**
 * Where an unprovable operation branch is parked. Renaming out of
 * `OP_BRANCH_PREFIX` is what lets writes recover: the sweep only enumerates the
 * op namespace, so a quarantined ref stops blocking every future write while
 * its commits stay byte-for-byte intact and inspectable.
 */
const QUARANTINE_BRANCH_PREFIX = "work-item-quarantine/";
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 50;
const OPERATION_QUEUE_WAIT_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;
/**
 * Budget for REF HOUSEKEEPING — `dolt_branch` create/delete/rename. Six times
 * the DML budget, because these are not DML and they do not share its failure
 * mode.
 *
 * Measured on operator production 2026-10-09: with one budget for everything,
 * `dolt_branch` exceeded 5s under load, `terminateClient` destroyed the pool,
 * and the PATCH 500'd AFTER its merge had already landed on `main`. Worse, the
 * same 5s applied to the quarantine rename, so the one operation whose job is
 * to clear a stuck branch was itself killed by the timeout — writes stayed
 * down with the fix deployed.
 *
 * A longer budget here is strictly safer than a shorter one: a rename or a
 * delete of an operation ref mutates no rows, so the only thing a timeout buys
 * is a destroyed connection and an orphaned ref.
 */
const BRANCH_TIMEOUT_MS = 30_000;
/**
 * Stages that move REFS or SESSION STATE and write no rows — see
 * BRANCH_TIMEOUT_MS. `branch.create` is `dolt_checkout('-b', …)` and
 * `main.checkout` is `dolt_checkout('main')`; neither touches
 * `public.work_items`, so neither has a half-written row for a timeout to
 * protect. `merge.apply` and every `dml.*` stage deliberately stay on the DML
 * budget, because those DO write rows and a runaway one must be cut off.
 *
 * `branch.create` belongs here for a measured reason: Doltgres ref operations
 * get slower as refs accumulate, and the quarantine lane ADDS a ref each time
 * it parks an unprovable branch. On operator production that closed a loop —
 * `dolt_checkout -b` blew the 5s budget, the pool was destroyed, the orphaned
 * branch became unprovable residue, the next attempt quarantined it and added
 * another ref, and the following attempt was slower still. Writes to one item
 * failed six consecutive times while a freshly created item patched fine,
 * because the pile only has to be big enough to cross the budget.
 */
const BRANCH_HOUSEKEEPING_STAGES = new Set([
  "branch.create",
  "branch.delete",
  "main.checkout",
]);
const RESERVE_TIMEOUT_MS = 5_000;

/**
 * What a locked scope owes when it meets an operation branch it cannot prove.
 *
 * - `required` — fail closed. A write must never build on unproven evidence.
 * - `best_effort` — keep the evidence, re-prove `main`, and serve from it
 *   anyway. For reads, which cannot observe an operation branch (bug.5358).
 * - `skipped` — the caller already owns one branch and reconciles it itself; a
 *   generic sweep would race that work.
 */
type BranchReconciliation = "required" | "best_effort" | "skipped";

export interface WorkItemLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}
export interface DoltgresWorkItemAdapterOptions {
  readonly idFloor?: number;
  readonly logger?: WorkItemLogger;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly queueWaitMs?: number;
  readonly queryTimeoutMs?: number;
  /**
   * Budget for `dolt_branch` ref housekeeping. Defaults to 6× `queryTimeoutMs`'s
   * default; see BRANCH_TIMEOUT_MS for why it is separate.
   */
  readonly branchTimeoutMs?: number;
  readonly reserveTimeoutMs?: number;
  readonly recreateClient?: () => Sql;
  /**
   * Dedicated pool for the QUERY port. Reads run on it instead of the write
   * lane — see `readOnCleanMain`.
   *
   * Omitting it does NOT opt out of the read lane. When `recreateClient` is
   * set, the adapter derives its own read pool from that factory on first
   * read, because 0.1.5 shipped the read lane as an option every node had to
   * hand-wire and not one of them did: the whole fleet kept serializing reads
   * behind the write queue while the fix sat in the package, inert. A lane
   * that only works when six repositories each remember to pass an argument
   * is not a fix, so the package owns it. Pass this explicitly only to give
   * reads a WIDER pool than the write factory builds.
   */
  readonly readClient?: Sql;
}

interface OperationContext {
  readonly operationId: string;
  readonly operation: string;
  branch?: string;
}

interface WorkItemConnection {
  readonly context: OperationContext;
  readonly pool: Sql;
  unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}

type MutationVerb =
  | "create"
  | "patch"
  | "delete"
  | "claim"
  | "heartbeat"
  | "release";

interface MutationProof {
  readonly verb: MutationVerb;
  readonly principal: string;
  itemId?: string;
  beforeRow?: Record<string, unknown>;
  afterRow?: Record<string, unknown>;
  readonly patchValues?: Readonly<Record<string, unknown>>;
  readonly runId?: string;
  readonly command?: string;
  readonly commandProvided?: boolean;
}

interface MutationOptions<T> {
  readonly proof: MutationProof;
  readonly preflight?: (
    conn: WorkItemConnection,
    proof: MutationProof
  ) => Promise<void>;
  readonly shouldCommit?: (result: T) => boolean;
}

interface PendingBranchState<T> {
  readonly branch: string;
  readonly baseHash: string;
  readonly proof: MutationProof;
  result?: T;
  branchCommit?: string;
  requiresFreshOutcomeProof?: boolean;
}

interface ValidatedBranchTransition {
  readonly branch: string;
  readonly baseHash: string;
  readonly tip: string;
  readonly proof: MutationProof;
  readonly before: RowSnapshot;
  readonly after: RowSnapshot;
  readonly commitAt: number;
}

class PendingBranchRecoveryError<T = unknown> extends Error {
  constructor(
    readonly state: PendingBranchState<T>,
    readonly originalError: unknown
  ) {
    super("Work-item operation branch requires fresh-session recovery");
    this.name = "PendingBranchRecoveryError";
  }
}

const noopLogger: WorkItemLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class WorkItemAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`work item id '${id}' already exists`);
    this.name = "WorkItemAlreadyExistsError";
  }
}

export class WorkItemAuthorizationError extends Error {
  constructor(public readonly id: string) {
    super(`Not authorized to mutate work item: ${id}`);
    this.name = "WorkItemAuthorizationError";
  }
}

export class WorkItemLeaseConflictError extends Error {
  constructor(public readonly id: string) {
    super(`Work item is claimed by another principal or lease: ${id}`);
    this.name = "WorkItemLeaseConflictError";
  }
}

export class DoltCommitFailedError extends Error {
  constructor() {
    super("Dolt work-item commit did not return a commit hash");
    this.name = "DoltCommitFailedError";
  }
}

export class DoltOperationFailedError extends Error {
  constructor(operation: string) {
    super(`${operation} did not report success`);
    this.name = "DoltOperationFailedError";
  }
}

export class DirtyWorkItemsMainError extends Error {
  constructor() {
    super("main has uncommitted work_items changes; refusing access");
    this.name = "DirtyWorkItemsMainError";
  }
}

export class ForeignMergeInProgressError extends Error {
  constructor() {
    super("main has a merge in progress not owned by the work-item adapter");
    this.name = "ForeignMergeInProgressError";
  }
}

export class WorkItemMergeConflictError extends Error {
  constructor() {
    super("work_items operation branch conflicted while merging to main");
    this.name = "WorkItemMergeConflictError";
  }
}

export class WorkItemsBusyError extends Error {
  constructor(message = "Work-item store is busy; retry shortly") {
    super(message);
    this.name = "WorkItemsBusyError";
  }
}

/**
 * The branch is STRUCTURALLY verified — linear history, frozen base intact,
 * exactly one `public.work_items` row diff, authoritative commit time — and
 * fails only `validateTransitionMatrix`. That distinction is what makes
 * quarantine safe: we know the ref holds at most one work-item row change, so
 * parking it loses nothing, whereas a branch whose tip or reachability could
 * not be established has proven nothing and must keep failing closed.
 */
class UnprovableTransitionError extends WorkItemsBusyError {
  constructor(message: string) {
    super(message);
    this.name = "UnprovableTransitionError";
  }
}


class DoltMergeOutcomeUnknownError extends WorkItemsBusyError {
  constructor() {
    super(
      "Work-item merge outcome is unknown; adapter requires reconciliation"
    );
    this.name = "DoltMergeOutcomeUnknownError";
  }
}

function escapeValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value) || typeof value === "object") {
    return `'${JSON.stringify(value).replace(/\0/g, "").replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/\0/g, "").replace(/'/g, "''")}'`;
}

/**
 * Creator-binding constrains rows that HAVE a recorded creator. A row whose
 * `created_by_principal_id` is NULL predates the column and is unowned, so every
 * authenticated principal may mutate it — which is exactly the behaviour those
 * rows had before the column existed.
 *
 * Getting this wrong is a silent fleet-wide lockout, not a 403 on one row:
 * `String(null) !== principal` is always true, so the moment a node applies the
 * lease-column migration its entire pre-existing corpus becomes immutable while
 * reads keep returning 200. Observed on operator production 2026-10-08 — every
 * item created before the migration rejected every PATCH, every newly created
 * item was fine, so the failure looked like an auth problem rather than a
 * migration one.
 */
/**
 * Does `creator` (a `created_by_principal_id` rendered as a string, `""` for
 * NULL) permit `principal` to mutate the row?
 *
 * This is the SAME rule `mayMutate` applies to the row it reads, and the two
 * must agree or a write is admitted and then refused. An UNADOPTED row — one
 * created before `created_by_principal_id` existed, so NULL — is mutable by
 * anyone: that is deliberate, because the alternative is that every work item
 * predating the column is frozen forever with no path to adopt it.
 *
 * bug.5358: the transition matrix did NOT share this rule. It demanded
 * `creator === principal` outright, so a NULL-creator row passed `mayMutate`,
 * had its UPDATE committed to the operation branch, then failed its own
 * transition proof — a 500, every time, with the branch left behind as
 * unprovable residue for the next sweep to quarantine. Measured on operator
 * production: every item created on or before 2026-10-08 returned 500 on
 * PATCH while every item created after returned 200, because only the latter
 * carry a creator.
 */
function creatorPermits(creator: string, principal: string): boolean {
  return creator === "" || creator === principal;
}

function mayMutate(row: Record<string, unknown>, principal: string): boolean {
  const creator = row.created_by_principal_id;
  if (creator === null || creator === undefined || creator === "") return true;
  return String(creator) === principal;
}

function requirePrincipal(principalId: string): string {
  const value = principalId.trim();
  if (!value) throw new WorkItemAuthorizationError("unknown");
  return value;
}

function actorOf(value: unknown): ActorKind {
  return value === "human" || value === "ai" ? value : "either";
}

function jsonArrayOf<T>(value: unknown): readonly T[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalWorkItemId(value: unknown): WorkItemId | undefined {
  return value ? toWorkItemId(String(value)) : undefined;
}

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  const claimIsActive = row.claim_active !== false;
  const item: Record<string, unknown> = {
    id: toWorkItemId(String(row.id)),
    type: String(row.type) as WorkItemType,
    title: String(row.title),
    status: String(row.status) as WorkItemStatus,
    node: String(row.node ?? "shared"),
    actor: actorOf(row.actor),
    assignees: jsonArrayOf<SubjectRef>(row.assignees),
    externalRefs: jsonArrayOf<ExternalRef>(row.external_refs),
    labels: jsonArrayOf<string>(row.labels),
    specRefs: jsonArrayOf<string>(row.spec_refs),
    revision: Number(row.revision ?? 0),
    deployVerified: Boolean(row.deploy_verified ?? false),
    createdAt: row.created_at ? String(row.created_at) : "",
    updatedAt: row.updated_at ? String(row.updated_at) : "",
  };

  const optional = {
    priority: optionalNumber(row.priority),
    rank: optionalNumber(row.rank),
    estimate: optionalNumber(row.estimate),
    summary: optionalString(row.summary),
    outcome: optionalString(row.outcome),
    projectId: optionalWorkItemId(row.project_id),
    parentId: optionalWorkItemId(row.parent_id),
    branch: optionalString(row.branch),
    pr: optionalString(row.pr),
    reviewer: optionalString(row.reviewer),
    blockedBy: optionalWorkItemId(row.blocked_by),
    claimedByRun: claimIsActive
      ? optionalString(row.claimed_by_run)
      : undefined,
    claimedAt: claimIsActive ? optionalString(row.claimed_at) : undefined,
    lastCommand: claimIsActive ? optionalString(row.last_command) : undefined,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) item[key] = value;
  }
  return item as WorkItem;
}

function parseSuffix(id: string, type: WorkItemType): number | null {
  const prefix = `${type}.`;
  if (!id.startsWith(prefix)) return null;
  const tail = id.slice(prefix.length);
  return /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : null;
}

function isDuplicateError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "23505" ||
    /duplicate|unique|already exists/i.test(candidate.message ?? "")
  );
}

function doltCommitHash(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new DoltCommitFailedError();
  const value = (rows[0] as Record<string, unknown>).dolt_commit;
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "")
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim();
  if (!normalized || normalized === "undefined" || normalized === "null") {
    throw new DoltCommitFailedError();
  }
  return normalized;
}

function assertDoltStatus(
  rows: unknown,
  field: "dolt_add" | "dolt_checkout" | "dolt_branch"
): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DoltOperationFailedError(field);
  }
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  const statusMatch = String(raw ?? "").match(/^[({]?\s*(-?\d+)/);
  if (!statusMatch || Number(statusMatch[1]) !== 0) {
    throw new DoltOperationFailedError(field);
  }
}

function doltScalar(rows: unknown, field: string): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DoltOperationFailedError(field);
  }
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "")
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .trim();
  if (!normalized || normalized === "undefined" || normalized === "null") {
    throw new DoltOperationFailedError(field);
  }
  return normalized;
}

const PATCH_COLUMNS: Record<keyof WorkItemsPatchSet, string> = {
  title: "title",
  summary: "summary",
  outcome: "outcome",
  status: "status",
  priority: "priority",
  rank: "rank",
  estimate: "estimate",
  labels: "labels",
  specRefs: "spec_refs",
  branch: "branch",
  pr: "pr",
  reviewer: "reviewer",
  node: "node",
  deployVerified: "deploy_verified",
  projectId: "project_id",
  parentId: "parent_id",
  blockedBy: "blocked_by",
};

const PERSISTED_WORK_ITEM_COLUMNS = [
  "id",
  "type",
  "title",
  "status",
  "node",
  "project_id",
  "parent_id",
  "priority",
  "rank",
  "estimate",
  "summary",
  "outcome",
  "branch",
  "pr",
  "reviewer",
  "revision",
  "blocked_by",
  "deploy_verified",
  "claimed_by_run",
  "claimed_at",
  "last_command",
  "assignees",
  "external_refs",
  "labels",
  "spec_refs",
  "created_at",
  "updated_at",
  "created_by_principal_id",
  "claim_owner_principal_id",
  "claim_expires_at",
] as const;

type PersistedColumn = (typeof PERSISTED_WORK_ITEM_COLUMNS)[number];
type RowSnapshot = Record<PersistedColumn, unknown>;

const PATCH_DB_COLUMNS = new Set<string>(Object.values(PATCH_COLUMNS));
const IMMUTABLE_COLUMNS = new Set<string>([
  "id",
  "type",
  "created_at",
  "created_by_principal_id",
]);
const CLAIM_COLUMNS = new Set<string>([
  "claimed_by_run",
  "claim_owner_principal_id",
  "claimed_at",
  "claim_expires_at",
  "last_command",
  "revision",
  "updated_at",
]);
const HEARTBEAT_COLUMNS = new Set<string>([
  "claim_expires_at",
  "last_command",
  "revision",
  "updated_at",
]);
const RELEASE_COLUMNS = new Set<string>([
  "claimed_by_run",
  "claim_owner_principal_id",
  "claimed_at",
  "claim_expires_at",
  "revision",
  "updated_at",
]);

function normalizedPersistedValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
  }
  return value ?? null;
}

function snapshotRow(
  row: Record<string, unknown>,
  prefix = ""
): RowSnapshot {
  return Object.fromEntries(
    PERSISTED_WORK_ITEM_COLUMNS.map((column) => [
      column,
      normalizedPersistedValue(row[`${prefix}${column}`]),
    ])
  ) as RowSnapshot;
}

function snapshotsEqual(left: RowSnapshot, right: RowSnapshot): boolean {
  return PERSISTED_WORK_ITEM_COLUMNS.every(
    (column) =>
      JSON.stringify(left[column]) === JSON.stringify(right[column])
  );
}

function changedColumns(before: RowSnapshot, after: RowSnapshot): Set<string> {
  return new Set(
    PERSISTED_WORK_ITEM_COLUMNS.filter(
      (column) =>
        JSON.stringify(before[column]) !== JSON.stringify(after[column])
    )
  );
}

function onlyAllowedChanges(
  changed: ReadonlySet<string>,
  allowed: ReadonlySet<string>
): boolean {
  return [...changed].every((column) => allowed.has(column));
}

function asEpoch(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const epoch = new Date(String(value)).getTime();
  return Number.isFinite(epoch) ? epoch : undefined;
}

function asRevision(value: unknown): number | undefined {
  const revision = Number(value);
  return Number.isInteger(revision) ? revision : undefined;
}

function isNullSnapshot(snapshot: RowSnapshot): boolean {
  return PERSISTED_WORK_ITEM_COLUMNS.every(
    (column) => snapshot[column] === null
  );
}

function legacyProofFromMessage(
  message: string,
  before: RowSnapshot,
  after: RowSnapshot
): MutationProof | undefined {
  const match =
    /^work-items: (create work item|(?:patch|delete|claim|heartbeat|release) ([^ ]+)) by actor:([^ ]+)$/.exec(
      message
    );
  if (!match) return undefined;
  const operation = match[1];
  const explicitId = match[2];
  const principal = match[3];
  if (!operation || !principal) return undefined;
  const verb = operation === "create work item" ? "create" : operation.split(" ")[0];
  if (
    verb !== "create" &&
    verb !== "patch" &&
    verb !== "delete" &&
    verb !== "claim" &&
    verb !== "heartbeat" &&
    verb !== "release"
  ) {
    return undefined;
  }
  const diffId = String(
    verb === "delete" ? before.id ?? "" : after.id ?? ""
  );
  if (!diffId || (explicitId && explicitId !== diffId)) return undefined;
  return {
    verb,
    principal,
    itemId: diffId,
    beforeRow: before,
    afterRow: after,
  };
}

function requireNamedMerge(rows: unknown): {
  hash: string;
  conflicts: number;
} {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new WorkItemMergeConflictError();
  }
  const row = rows[0] as Record<string, unknown>;
  const hash = String(row.hash ?? "").trim();
  const conflicts = Number(row.conflicts);
  if (!hash || !Number.isFinite(conflicts) || conflicts !== 0) {
    throw new WorkItemMergeConflictError();
  }
  return { hash, conflicts };
}

function validateTransitionMatrix(
  proof: MutationProof,
  before: RowSnapshot,
  after: RowSnapshot,
  commitAt: number
): boolean {
  if (
    proof.beforeRow &&
    !snapshotsEqual(before, snapshotRow(proof.beforeRow))
  ) {
    return false;
  }
  if (proof.afterRow && !snapshotsEqual(after, snapshotRow(proof.afterRow))) {
    return false;
  }

  const changed = changedColumns(before, after);
  const beforeRevision = asRevision(before.revision);
  const afterRevision = asRevision(after.revision);
  const revisionAdvanced =
    beforeRevision !== undefined && afterRevision === beforeRevision + 1;
  const creatorBefore = String(before.created_by_principal_id ?? "");
  const creatorAfter = String(after.created_by_principal_id ?? "");
  const itemId = proof.itemId ?? "";

  switch (proof.verb) {
    case "create": {
      const required = [
        after.id,
        after.type,
        after.title,
        after.status,
        after.node,
        after.created_at,
        after.updated_at,
      ];
      return (
        isNullSnapshot(before) &&
        required.every((value) => value !== null && String(value).length > 0) &&
        String(after.id) === itemId &&
        creatorAfter === proof.principal &&
        afterRevision === 0 &&
        after.claimed_by_run === null &&
        after.claimed_at === null &&
        after.claim_owner_principal_id === null &&
        after.claim_expires_at === null
      );
    }
    case "patch": {
      const requestedColumns = proof.patchValues
        ? Object.keys(proof.patchValues)
        : [...PATCH_DB_COLUMNS];
      const allowed = new Set<string>([
        ...requestedColumns,
        "revision",
        "updated_at",
      ]);
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        // `created_by_principal_id` is immutable, so the equality below also
        // forbids a patch from quietly adopting an unadopted row.
        creatorBefore === creatorAfter &&
        creatorPermits(creatorBefore, proof.principal) &&
        [...IMMUTABLE_COLUMNS].every(
          (column) =>
            JSON.stringify(before[column as PersistedColumn]) ===
            JSON.stringify(after[column as PersistedColumn])
        ) &&
        changed.size > 0 &&
        changed.has("revision") &&
        changed.has("updated_at") &&
        onlyAllowedChanges(changed, allowed) &&
        revisionAdvanced &&
        Object.entries(proof.patchValues ?? {}).every(
          ([column, value]) =>
            PATCH_DB_COLUMNS.has(column) &&
            JSON.stringify(after[column as PersistedColumn]) ===
              JSON.stringify(normalizedPersistedValue(value))
        )
      );
    }
    case "delete":
      return (
        String(before.id) === itemId &&
        creatorPermits(creatorBefore, proof.principal) &&
        isNullSnapshot(after)
      );
    case "claim": {
      const beforeExpiry = asEpoch(before.claim_expires_at);
      const afterClaimedAt = asEpoch(after.claimed_at);
      const afterExpiry = asEpoch(after.claim_expires_at);
      const sameLease =
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "") === String(after.claimed_by_run ?? "");
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        creatorBefore === creatorAfter &&
        (sameLease || beforeExpiry === undefined || beforeExpiry <= commitAt) &&
        String(after.claim_owner_principal_id ?? "") === proof.principal &&
        String(after.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || after.claimed_by_run === proof.runId) &&
        afterClaimedAt !== undefined &&
        afterExpiry !== undefined &&
        // Doltgres may report commit metadata at whole-second precision while
        // NOW()-backed row timestamps retain fractional precision. Compare the
        // lower bound at the coarser authority precision so a legitimate claim
        // in the same second is not preserved as unsafe.
        Math.floor(afterClaimedAt / 1_000) <= Math.floor(commitAt / 1_000) &&
        commitAt < afterExpiry &&
        afterExpiry > afterClaimedAt &&
        (proof.command === undefined || after.last_command === proof.command) &&
        onlyAllowedChanges(changed, CLAIM_COLUMNS) &&
        revisionAdvanced
      );
    }
    case "heartbeat": {
      const beforeExpiry = asEpoch(before.claim_expires_at);
      const afterExpiry = asEpoch(after.claim_expires_at);
      const leaseUnchanged =
        before.claim_owner_principal_id === after.claim_owner_principal_id &&
        before.claimed_by_run === after.claimed_by_run &&
        before.claimed_at === after.claimed_at;
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || before.claimed_by_run === proof.runId) &&
        leaseUnchanged &&
        beforeExpiry !== undefined &&
        afterExpiry !== undefined &&
        beforeExpiry > commitAt &&
        afterExpiry > commitAt &&
        afterExpiry > beforeExpiry &&
        (proof.commandProvided
          ? after.last_command === proof.command
          : before.last_command === after.last_command) &&
        onlyAllowedChanges(changed, HEARTBEAT_COLUMNS) &&
        revisionAdvanced
      );
    }
    case "release":
      return (
        String(before.id) === itemId &&
        String(after.id) === itemId &&
        String(before.claim_owner_principal_id ?? "") === proof.principal &&
        String(before.claimed_by_run ?? "").length > 0 &&
        (proof.runId === undefined || before.claimed_by_run === proof.runId) &&
        after.claimed_by_run === null &&
        after.claim_owner_principal_id === null &&
        after.claimed_at === null &&
        after.claim_expires_at === null &&
        before.last_command === after.last_command &&
        onlyAllowedChanges(changed, RELEASE_COLUMNS) &&
        revisionAdvanced
      );
  }
}

function queryStage(query: string): string {
  if (query.startsWith("SELECT pg_try_advisory_lock")) return "lock.try";
  if (query.startsWith("SELECT pg_advisory_unlock")) return "lock.release";
  if (query.includes("dolt_checkout('-b'")) return "branch.create";
  if (query === "SELECT dolt_checkout('main')") return "main.checkout";
  if (query.startsWith("SELECT dolt_commit")) return "branch.commit";
  if (query.startsWith("SELECT dolt_merge_base")) return "merge.reachability";
  if (query === "SELECT dolt_merge('--abort')") return "merge.abort";
  if (query.startsWith("SELECT dolt_merge") || query.includes("FROM dolt_merge"))
    return "merge.apply";
  if (query.startsWith("SELECT dolt_branch")) return "branch.delete";
  if (query.includes("FROM dolt.merge_status")) return "merge.status";
  if (query === "SELECT table_name FROM dolt.status") return "main.status";
  if (query === "SELECT name, hash FROM dolt.branches") return "branches.list";
  if (query.startsWith("INSERT INTO work_items")) return "dml.create";
  if (query.startsWith("UPDATE work_items")) return "dml.update";
  if (query.startsWith("DELETE FROM work_items")) return "dml.delete";
  if (query.includes("FROM work_items")) return "dml.read";
  return "sql.other";
}

function doltBoolean(rows: unknown, field: string): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const value = (rows[0] as Record<string, unknown>)[field];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === true || raw === 1 || String(raw).toLowerCase() === "true";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorMessage: String(error) };
}

function isConnectionTerminal(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return (
    code === "CONNECTION_DESTROYED" ||
    code === "CONNECTION_ENDED" ||
    code === "CONNECTION_CLOSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

export class DoltgresWorkItemAdapter
  implements WorkItemsDoltgresPort, WorkItemQueryPort
{
  private operationTail: Promise<void> = Promise.resolve();
  private poisoned = false;
  private readonly logger: WorkItemLogger;
  private readonly idFloor: number;
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly queueWaitMs: number;
  private readonly queryTimeoutMs: number;
  private readonly branchTimeoutMs: number;
  private readonly reserveTimeoutMs: number;
  private readonly recreateClient: (() => Sql) | undefined;
  private readonly providedReadClient: Sql | undefined;
  /**
   * Read pool derived from `recreateClient` when the caller passed no
   * `readClient`. Built on first read, not in the constructor: a node that
   * never reads must not pay for a connection, and construction must not
   * depend on the database being reachable.
   */
  private derivedReadClient: Sql | undefined;
  private readonly terminatingPools = new WeakMap<object, Promise<void>>();

  constructor(
    private sql: Sql,
    options: DoltgresWorkItemAdapterOptions = {}
  ) {
    this.logger = options.logger ?? noopLogger;
    this.idFloor = options.idFloor ?? 1;
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.queueWaitMs = options.queueWaitMs ?? OPERATION_QUEUE_WAIT_MS;
    this.queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
    this.branchTimeoutMs = options.branchTimeoutMs ?? BRANCH_TIMEOUT_MS;
    this.reserveTimeoutMs = options.reserveTimeoutMs ?? RESERVE_TIMEOUT_MS;
    this.recreateClient = options.recreateClient;
    this.providedReadClient = options.readClient;
  }

  private logStage(
    level: "info" | "warn" | "error",
    context: OperationContext,
    stage: string,
    state: "start" | "complete" | "error",
    fields: Record<string, unknown> = {}
  ): void {
    this.logger[level](
      {
        event: `adapter.work_items.stage_${state}`,
        component: "doltgres-work-items",
        operationId: context.operationId,
        operation: context.operation,
        stage,
        ...fields,
      },
      `work_items ${stage} ${state}`
    );
  }

  private async terminateClient(
    pool: Sql,
    context: OperationContext,
    stage: string,
    reason: string
  ): Promise<void> {
    const activeTermination = this.terminatingPools.get(pool as object);
    if (activeTermination) return activeTermination;

    const termination = (async () => {
      if (this.sql === pool) this.poisoned = true;
      this.logStage("error", context, "connection.terminate", "error", {
        failedStage: stage,
        reason,
      });
      try {
        await pool.end({ timeout: 0 });
      } catch (error) {
        this.logStage("error", context, "connection.terminate", "error", {
          failedStage: stage,
          reason: "terminate_failed",
          ...errorFields(error),
        });
        return;
      }

      if (this.sql !== pool || !this.recreateClient) return;
      try {
        this.sql = this.recreateClient();
        this.poisoned = false;
        this.logStage("info", context, "connection.recreate", "complete", {
          failedStage: stage,
        });
      } catch (error) {
        this.logStage("error", context, "connection.recreate", "error", {
          failedStage: stage,
          ...errorFields(error),
        });
      }
    })();
    this.terminatingPools.set(pool as object, termination);
    return termination;
  }

  private async executeQuery(
    pool: Sql,
    conn: ReservedSql,
    context: OperationContext,
    query: string
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    const stage = queryStage(query);
    const startedAt = Date.now();
    let timedOut = false;
    const branch = /'(work-item-op\/[^']+)'/.exec(query)?.[1] ?? context.branch;
    const queryFields = branch ? { branch } : {};
    this.logStage("info", context, stage, "start", queryFields);
    const pending = conn.unsafe(query);
    const budgetMs = BRANCH_HOUSEKEEPING_STAGES.has(stage)
      ? Math.max(this.branchTimeoutMs, this.queryTimeoutMs)
      : this.queryTimeoutMs;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      void this.terminateClient(pool, context, stage, "query_timeout");
    }, budgetMs);
    try {
      const rows = (await pending) as ReadonlyArray<Record<string, unknown>>;
      if (timedOut) {
        await this.terminateClient(pool, context, stage, "query_timeout");
        throw new WorkItemsBusyError(
          `Work-item store timed out during ${stage}; retry shortly`
        );
      }
      this.logStage("info", context, stage, "complete", {
        ...queryFields,
        durationMs: Date.now() - startedAt,
      });
      return rows;
    } catch (error) {
      this.logStage("error", context, stage, "error", {
        ...queryFields,
        durationMs: Date.now() - startedAt,
        timedOut,
        ...errorFields(error),
      });
      if (timedOut) {
        await this.terminateClient(pool, context, stage, "query_timeout");
        throw new WorkItemsBusyError(
          `Work-item store timed out during ${stage}; retry shortly`
        );
      }
      if (isConnectionTerminal(error)) {
        await this.terminateClient(pool, context, stage, "connection_terminal");
        throw new WorkItemsBusyError(
          `Work-item store connection ended during ${stage}; retry shortly`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private instrumentConnection(
    pool: Sql,
    conn: ReservedSql,
    context: OperationContext
  ): WorkItemConnection {
    return {
      context,
      pool,
      unsafe: (query) => this.executeQuery(pool, conn, context, query),
    };
  }

  private async enterOperationQueue(
    context: OperationContext
  ): Promise<() => void> {
    const predecessor = this.operationTail;
    let releaseTurn: () => void = () => undefined;
    const turnDone = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.operationTail = predecessor.then(() => turnDone);

    const startedAt = Date.now();
    this.logStage("info", context, "operation.queue", "start");
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        predecessor,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new WorkItemsBusyError(
                  "Work-item store queue wait timed out; retry shortly"
                )
              ),
            this.queueWaitMs
          );
        }),
      ]);
    } catch (error) {
      // Keep the FIFO chain live even though this caller abandoned its turn.
      // The resolved ticket is skipped once its predecessor eventually exits.
      releaseTurn();
      this.logStage("warn", context, "operation.queue", "error", {
        durationMs: Date.now() - startedAt,
        reason: "wait_timeout",
      });
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    this.logStage("info", context, "operation.queue", "complete", {
      durationMs: Date.now() - startedAt,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTurn();
    };
  }

  private async withGlobalLock<T>(
    context: OperationContext,
    fn: (conn: WorkItemConnection) => Promise<T>,
    options: { readonly reconcile?: BranchReconciliation } = {}
  ): Promise<T> {
    if (this.poisoned) {
      throw new WorkItemsBusyError(
        "Work-item store requires restart reconciliation"
      );
    }
    const operationPool = this.sql;
    const reserveStartedAt = Date.now();
    let rawConn: ReservedSql | undefined;
    let locked = false;
    let reserveTimedOut = false;
    let reserveTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingRecovery = false;
    try {
      // postgres.js 3.4.9 does not resolve reserve() on its cold-connection
      // path when fetch_types=false. A real query opens the dedicated
      // connection first; reserve() can then bind that open session.
      await this.executeQuery(
        operationPool,
        operationPool as unknown as ReservedSql,
        context,
        "SELECT 1 AS work_items_ready"
      );
      this.logStage("info", context, "connection.reserve", "start");
      reserveTimer = setTimeout(() => {
        reserveTimedOut = true;
        void this.terminateClient(
          operationPool,
          context,
          "connection.reserve",
          "reserve_timeout"
        );
      }, this.reserveTimeoutMs);
      try {
        rawConn = await operationPool.reserve();
      } catch (error) {
        if (reserveTimedOut) {
          throw new WorkItemsBusyError(
            "Work-item store timed out reserving a connection; retry shortly"
          );
        }
        throw error;
      }
      if (reserveTimedOut) {
        await this.terminateClient(
          operationPool,
          context,
          "connection.reserve",
          "reserve_completed_after_timeout"
        );
        throw new WorkItemsBusyError(
          "Work-item store timed out reserving a connection; retry shortly"
        );
      }
      if (reserveTimer) clearTimeout(reserveTimer);
      this.logStage("info", context, "connection.reserve", "complete", {
        durationMs: Date.now() - reserveStartedAt,
      });
      const conn = this.instrumentConnection(operationPool, rawConn, context);
      locked = await this.acquireGlobalLock(conn, context);
      const reconciliation = options.reconcile ?? "required";
      if (reconciliation !== "skipped")
        await this.reconcileUnderLock(conn, reconciliation);
      return await fn(conn);
    } catch (error) {
      pendingRecovery = error instanceof PendingBranchRecoveryError;
      this.logStage("error", context, "operation", "error", {
        durationMs: Date.now() - reserveStartedAt,
        ...errorFields(error),
      });
      throw error;
    } finally {
      if (reserveTimer) clearTimeout(reserveTimer);
      // A branch operation with an uncertain acknowledgement is handed to a
      // second, fresh lock scope only after this session is definitively dead.
      // This releases the session-scoped advisory lock and abandons any dirty
      // working set without asking the failed connection to reconcile itself.
      if (pendingRecovery && rawConn) {
        await this.terminateClient(
          operationPool,
          context,
          "operation.recovery_handoff",
          "pending_branch_recovery"
        );
        rawConn = undefined;
        locked = false;
      }
      if (
        locked &&
        rawConn &&
        this.sql === operationPool &&
        !this.poisoned
      ) {
        try {
          await this.executeQuery(
            operationPool,
            rawConn,
            context,
            `SELECT pg_advisory_unlock(${GLOBAL_LOCK_KEY})`
          );
        } catch {
          // Never return a session that may still own the global lock to the
          // pool. This client is dedicated to work items, so terminate the old
          // pool before the injected factory constructs a clean replacement.
          await this.terminateClient(
            operationPool,
            context,
            "lock.release",
            "unlock_failed"
          );
          rawConn = undefined;
        }
      }
      if (rawConn && this.sql === operationPool && !this.poisoned) {
        rawConn.release();
      }
    }
  }

  private async withOperationQueue<T>(
    operation: string,
    fn: (context: OperationContext) => Promise<T>
  ): Promise<T> {
    const context = { operationId: randomUUID(), operation };
    const leaveQueue = await this.enterOperationQueue(context);
    try {
      return await fn(context);
    } finally {
      // The FIFO ticket spans the original lock scope and any fresh-session
      // recovery so an in-process successor cannot overtake reconciliation.
      leaveQueue();
    }
  }

  private async acquireGlobalLock(
    conn: WorkItemConnection,
    context: OperationContext
  ): Promise<boolean> {
    const deadline = Date.now() + this.lockWaitMs;
    do {
      const rows = await conn.unsafe(
        `SELECT pg_try_advisory_lock(${GLOBAL_LOCK_KEY})`
      );
      if (doltBoolean(rows, "pg_try_advisory_lock")) return true;
      if (Date.now() >= deadline) {
        this.logStage("warn", context, "lock.acquire", "error", {
          durationMs: this.lockWaitMs,
          reason: "contended",
        });
        throw new WorkItemsBusyError();
      }
      await sleep(
        Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now()))
      );
    } while (Date.now() <= deadline);
    throw new WorkItemsBusyError();
  }

  private logReconciliation(
    level: "info" | "warn" | "error",
    conn: WorkItemConnection,
    fields: Record<string, unknown>
  ): void {
    this.logger[level](
      {
        event: "adapter.work_items.reconcile",
        component: "doltgres-work-items",
        operationId: conn.context.operationId,
        ...fields,
      },
      "work_items operation branch reconciled"
    );
  }

  private preservedBranchError(
    branch: string,
    error: unknown
  ): WorkItemsBusyError {
    return error instanceof WorkItemsBusyError
      ? error
      : new WorkItemsBusyError(
          `Work-item branch ${branch} could not be safely proven; preserving evidence`
        );
  }

  /**
   * Re-reads the ref after a delete whose acknowledgement did not arrive.
   *
   * Doltgres can apply `dolt_branch('-D', ...)` durably and still lose the ack
   * to the query deadline — the same lost-acknowledgement shape as bug.5358,
   * one layer down. Taking the thrown error at face value reports completed
   * work as pending, which sends an operator (or a retry loop) chasing a ref
   * that is already gone. Observed on poly production 2026-10-08T02:20:15Z.
   */
  private async deleteLanded(
    conn: WorkItemConnection,
    branch: string
  ): Promise<boolean> {
    try {
      return (await this.operationBranchRow(conn, branch)) === undefined;
    } catch {
      // The session may be dead too. An unverifiable delete stays pending.
      return false;
    }
  }

  private async cleanupVerifiedBranch(
    conn: WorkItemConnection,
    transition: ValidatedBranchTransition,
    startedAt: number
  ): Promise<boolean> {
    try {
      await this.deleteOperationBranch(conn, transition.branch);
      return true;
    } catch (error) {
      const fields = {
        branch: transition.branch,
        baseHash: transition.baseHash,
        tip: transition.tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      };
      if (await this.deleteLanded(conn, transition.branch)) {
        // No `classification` key: the caller records the cleaned verdict, and
        // adding a value here would make existing classification queries
        // incomplete. `deleteAckLost` is the queryable substrate signal.
        this.logReconciliation("info", conn, { ...fields, deleteAckLost: true });
        return true;
      }
      // Once reachability (and, for a fresh merge, the exact current row) is
      // proven, ref deletion is repairable housekeeping. Returning a 503 here
      // would invite callers to replay an already-durable PATCH/CREATE.
      this.logReconciliation("warn", conn, {
        ...fields,
        classification: "cleanup_pending",
      });
      return false;
    }
  }

  private async operationBranchRow(
    conn: WorkItemConnection,
    branch: string
  ): Promise<Record<string, unknown> | undefined> {
    const rows = (await conn.unsafe(
      "SELECT name, hash FROM dolt.branches"
    )) as ReadonlyArray<Record<string, unknown>>;
    return rows.find((row) => String(row.name ?? "") === branch);
  }

  private async validateOperationBranch(
    conn: WorkItemConnection,
    branch: string,
    tip: string,
    pending?: PendingBranchState<unknown>
  ): Promise<ValidatedBranchTransition> {
    const commitRows = (await conn.unsafe(
      `SELECT * FROM dolt.commits WHERE commit_hash = ${escapeValue(tip)}`
    )) as ReadonlyArray<Record<string, unknown>>;
    const commit = commitRows.find(
      (row) => String(row.commit_hash ?? "") === tip
    );
    const parentRows = (await conn.unsafe(
      `SELECT * FROM dolt.commit_ancestors WHERE commit_hash = ${escapeValue(tip)}`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (!commit || parentRows.length !== 1) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has unprovable commit evidence; preserving evidence`
      );
    }
    const parent = parentRows[0];
    if (!parent || Number(parent.parent_index) !== 0) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has non-linear history; preserving evidence`
      );
    }
    const baseHash = String(parent.parent_hash ?? "");
    if (
      !baseHash ||
      (pending && baseHash !== pending.baseHash) ||
      (pending?.branchCommit && pending.branchCommit !== tip)
    ) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} moved from its frozen base; preserving evidence`
      );
    }

    const summaries = (await conn.unsafe(
      `SELECT * FROM dolt_diff_summary(${escapeValue(baseHash)}, ${escapeValue(tip)})`
    )) as ReadonlyArray<Record<string, unknown>>;
    const summary = summaries[0];
    // Deployed Doltgres falsifies data_change=false for the real b112 one-row
    // add. The exact row diff below is data authority; summary is schema/scope
    // authority only (bug.5358 approved Rev3 amendment).
    if (
      summaries.length !== 1 ||
      !summary ||
      String(summary.from_table_name ?? "") !== "public.work_items" ||
      String(summary.to_table_name ?? "") !== "public.work_items" ||
      doltBoolean([summary], "schema_change")
    ) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} changed unsupported schema or tables; preserving evidence`
      );
    }
    const diffs = (await conn.unsafe(
      `SELECT * FROM dolt_diff(${escapeValue(baseHash)}, ${escapeValue(tip)}, 'work_items')`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (diffs.length !== 1 || !diffs[0]) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} is not an exact one-row change; preserving evidence`
      );
    }
    const diff = diffs[0];
    const before = snapshotRow(diff, "from_");
    const after = snapshotRow(diff, "to_");
    const commitAt = asEpoch(commit.date);
    if (commitAt === undefined) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has no authoritative commit time; preserving evidence`
      );
    }
    const proof =
      pending?.proof ??
      legacyProofFromMessage(String(commit.message ?? ""), before, after);
    if (!proof || !validateTransitionMatrix(proof, before, after, commitAt)) {
      throw new UnprovableTransitionError(
        `Work-item branch ${branch} failed its operation proof; preserving evidence`
      );
    }
    const expectedDiffType =
      proof.verb === "create"
        ? "added"
        : proof.verb === "delete"
          ? "removed"
          : "modified";
    if (String(diff.diff_type ?? "").toLowerCase() !== expectedDiffType) {
      throw new WorkItemsBusyError(
        `Work-item branch ${branch} has the wrong operation shape; preserving evidence`
      );
    }
    return { branch, baseHash, tip, proof, before, after, commitAt };
  }

  private async proveFreshMergeOutcome(
    conn: WorkItemConnection,
    transition: ValidatedBranchTransition
  ): Promise<void> {
    if (!(await this.branchCommitIsOnMain(conn, transition.tip))) {
      throw new DoltMergeOutcomeUnknownError();
    }
    const id = String(
      transition.proof.verb === "delete"
        ? transition.before.id
        : transition.after.id
    );
    const rows = (await conn.unsafe(
      `SELECT * FROM work_items WHERE id = ${escapeValue(id)} LIMIT 1`
    )) as ReadonlyArray<Record<string, unknown>>;
    if (transition.proof.verb === "delete") {
      if (rows.length !== 0) throw new DoltMergeOutcomeUnknownError();
      return;
    }
    if (!rows[0] || !snapshotsEqual(snapshotRow(rows[0]), transition.after)) {
      throw new DoltMergeOutcomeUnknownError();
    }
  }

  private async resolveOperationBranch<T>(
    conn: WorkItemConnection,
    branch: string,
    pending?: PendingBranchState<T>,
    originalError?: unknown,
    reconciliation: BranchReconciliation = "required"
  ): Promise<T | undefined> {
    const startedAt = Date.now();
    // A read that will serve anyway records handled degradation, not failure:
    // the request still succeeds, so an error level would make every healthy
    // read on a node carrying residual evidence look like an outage.
    const served = reconciliation === "best_effort";
    const preserveLevel = served ? "warn" : "error";
    const preserveFields = served ? { served: true } : {};
    try {
      const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(checkoutRows, "dolt_checkout");
      await this.abortOwnedMergeIfPresent(conn, branch);
      await this.assertMainClean(conn);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }

    let row: Record<string, unknown> | undefined;
    try {
      row = await this.operationBranchRow(conn, branch);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    if (!row && !pending?.branchCommit) {
      if (pending) throw originalError;
      return undefined;
    }
    let tip: string;
    try {
      tip = row
        ? doltScalar([row], "hash")
        : String(pending?.branchCommit ?? "");
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    if (pending && tip === pending.baseHash) {
      try {
        await this.deleteOperationBranch(conn, branch);
      } catch (error) {
        this.logReconciliation(preserveLevel, conn, {
          ...preserveFields,
          branch,
          baseHash: pending.baseHash,
          tip,
          classification: "preserved_unsafe",
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
        throw this.preservedBranchError(branch, error);
      }
      this.logReconciliation("info", conn, {
        branch,
        baseHash: pending.baseHash,
        tip,
        verb: pending.proof.verb,
        itemId: pending.proof.itemId,
        classification: "empty_deleted",
        durationMs: Date.now() - startedAt,
      });
      throw originalError;
    }
    if (!pending) {
      let currentMain: string;
      try {
        currentMain = doltScalar(
          await conn.unsafe("SELECT dolt_hashof('main') AS dolt_hashof"),
          "dolt_hashof"
        );
      } catch (error) {
        this.logReconciliation(preserveLevel, conn, {
          ...preserveFields,
          branch,
          tip,
          classification: "preserved_unsafe",
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
        throw this.preservedBranchError(branch, error);
      }
      if (tip === currentMain) {
        try {
          await this.deleteOperationBranch(conn, branch);
        } catch (error) {
          this.logReconciliation(preserveLevel, conn, {
            ...preserveFields,
            branch,
            baseHash: currentMain,
            tip,
            classification: "preserved_unsafe",
            durationMs: Date.now() - startedAt,
            ...errorFields(error),
          });
          throw this.preservedBranchError(branch, error);
        }
        this.logReconciliation("info", conn, {
          branch,
          baseHash: currentMain,
          tip,
          classification: "empty_deleted",
          durationMs: Date.now() - startedAt,
        });
        return undefined;
      }
    }

    let reachable: boolean;
    try {
      reachable = await this.branchCommitIsOnMain(conn, tip);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        tip,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    // A restart branch whose exact tip is already reachable from main owns no
    // commits that main does not. This includes a branch-create acknowledgement
    // failure: Dolt can create the ref at the then-current main, lose the ack,
    // and leave the ref behind; once main advances that tip is an old main
    // ancestor. Do not interpret that ancestor commit as a work-item operation
    // commit — its parent diff legitimately describes any repository change,
    // which is what produced `changed unsupported schema or tables` on poly
    // production (poly #169, bug.5358).
    if (reachable && !pending) {
      let cleaned = true;
      try {
        await this.deleteOperationBranch(conn, branch);
      } catch (error) {
        cleaned = await this.deleteLanded(conn, branch);
        this.logReconciliation(cleaned ? "info" : "warn", conn, {
          branch,
          tip,
          ...(cleaned
            ? { deleteAckLost: true }
            : { classification: "reachable_redundant_cleanup_pending" }),
          durationMs: Date.now() - startedAt,
          ...errorFields(error),
        });
      }
      this.logReconciliation("info", conn, {
        branch,
        tip,
        classification: cleaned
          ? "reachable_redundant_cleaned"
          : "reachable_redundant_cleanup_pending",
        durationMs: Date.now() - startedAt,
      });
      return undefined;
    }

    let transition: ValidatedBranchTransition;
    try {
      transition = await this.validateOperationBranch(
        conn,
        branch,
        tip,
        pending as PendingBranchState<unknown> | undefined
      );
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        tip,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }

    if (reachable) {
      if (pending?.requiresFreshOutcomeProof) {
        try {
          await this.proveFreshMergeOutcome(conn, transition);
        } catch (error) {
          this.logReconciliation(preserveLevel, conn, {
            ...preserveFields,
            branch,
            baseHash: transition.baseHash,
            tip,
            verb: transition.proof.verb,
            itemId: transition.proof.itemId,
            classification: "preserved_unsafe",
            durationMs: Date.now() - startedAt,
            ...errorFields(error),
          });
          throw this.preservedBranchError(branch, error);
        }
      }
      const cleaned = row
        ? await this.cleanupVerifiedBranch(conn, transition, startedAt)
        : true;
      this.logReconciliation("info", conn, {
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: cleaned
          ? "reachable_cleaned"
          : "reachable_cleanup_pending",
        durationMs: Date.now() - startedAt,
      });
      return pending?.result;
    }

    let merge: { hash: string; conflicts: number };
    try {
      merge = requireNamedMerge(
        await conn.unsafe(
          `SELECT hash, fast_forward, conflicts, message FROM dolt_merge(${escapeValue(branch)})`
        )
      );
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: "preserved_conflict",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    try {
      await this.proveFreshMergeOutcome(conn, transition);
    } catch (error) {
      this.logReconciliation(preserveLevel, conn, {
        ...preserveFields,
        branch,
        baseHash: transition.baseHash,
        tip,
        verb: transition.proof.verb,
        itemId: transition.proof.itemId,
        classification: "preserved_unsafe",
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw this.preservedBranchError(branch, error);
    }
    const cleaned = await this.cleanupVerifiedBranch(
      conn,
      transition,
      startedAt
    );
    this.logReconciliation("info", conn, {
      branch,
      baseHash: transition.baseHash,
      tip,
      verb: transition.proof.verb,
      itemId: transition.proof.itemId,
      mergeHash: merge.hash,
      classification: "merged_verified",
      cleanupPending: !cleaned,
      durationMs: Date.now() - startedAt,
    });
    return pending?.result;
  }

  private async makeMainSafe(conn: WorkItemConnection): Promise<void> {
    try {
      const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(checkoutRows, "dolt_checkout");
      await this.abortOwnedMergeIfPresent(conn);
      await this.assertMainClean(conn);
    } catch {
      throw new WorkItemsBusyError(
        "Work-item main could not be made safe for reconciliation; retry shortly"
      );
    }
  }

  private async reconcileUnderLock(
    conn: WorkItemConnection,
    reconciliation: Exclude<BranchReconciliation, "skipped">
  ): Promise<void> {
    await this.makeMainSafe(conn);

    let branchRows: ReadonlyArray<Record<string, unknown>>;
    try {
      branchRows = await conn.unsafe("SELECT name, hash FROM dolt.branches");
    } catch {
      throw new WorkItemsBusyError(
        "Work-item branch reconciliation could not list evidence; retry shortly"
      );
    }
    const branches = branchRows
      .map((row) => String(row.name ?? ""))
      .filter((branch) => branch.startsWith(OP_BRANCH_PREFIX))
      .sort();
    // bug.5358: a read is served from committed `main`, which an unprovable
    // evidence branch cannot corrupt. Failing the read closed here let one
    // residual branch return 503 for every read permanently — nothing deletes a
    // `preserved_unsafe` branch, and this sweep re-walks `dolt.branches` on each
    // request, so a restart does not clear it. `resolveOperationBranch` already
    // recorded the branch; keep sweeping, because a sibling may still be
    // provable and skipping it would drop read-your-writes for a durable write
    // that only needs its merge finished.
    let tolerated = false;
    for (const branch of branches) {
      try {
        await this.resolveOperationBranch(
          conn,
          branch,
          undefined,
          undefined,
          reconciliation
        );
      } catch (error) {
        if (reconciliation === "required") {
          // ONLY the structurally-verified arm is quarantinable. A branch whose
          // tip is missing, or whose reachability could not be proven, has
          // established nothing about its contents — parking it could hide
          // arbitrary divergence, so those keep failing closed exactly as
          // before.
          if (!(error instanceof UnprovableTransitionError)) throw error;
          // ONE UNPROVABLE BRANCH MUST NOT BLOCK EVERY FUTURE WRITE.
          // bug.5358 left this arm throwing, which made writes permanently
          // unavailable on a node carrying a single residual branch: nothing
          // deletes a `preserved_unsafe` ref, and this sweep re-walks
          // `dolt.branches` on every request, so no restart clears it. Measured
          // on operator production — a promote failed at 05:27:04Z, the lost
          // `branch.create` ack left `work-item-op/9ee34c81…` behind at
          // 05:28:33Z, and 88 consecutive write attempts 503'd over the next
          // two hours while reads stayed 200.
          //
          // Quarantine rather than delete. The branch reached this arm having
          // ALREADY passed every structural check — linear history, frozen base
          // intact, exactly one `public.work_items` row diff, authoritative
          // commit time — and fails only its transition proof. So it may hold a
          // real one-row write, and deleting it is the data loss bug.5358 was
          // filed to prevent. Renaming it out of the enumerated namespace
          // preserves those commits byte-for-byte with zero data mutation,
          // keeps them reachable for a human to merge, and unblocks writes now.
          // A failed rename still throws: quarantine must not be best-effort,
          // or a write would proceed believing evidence was parked when it was
          // not.
          await this.quarantineOperationBranch(conn, branch, error);
          tolerated = true;
          continue;
        }
        tolerated = true;
      }
    }
    // Each iteration re-proves `main` itself, so one pass at the end is enough
    // to guarantee the caller's read never runs on a half-reconciled session.
    if (tolerated) await this.makeMainSafe(conn);
  }

  private async mergeState(
    conn: WorkItemConnection
  ): Promise<Record<string, unknown> | undefined> {
    const rows = (await conn.unsafe(
      "SELECT is_merging, source, source_commit, target, unmerged_tables FROM dolt.merge_status"
    )) as ReadonlyArray<Record<string, unknown>>;
    return rows.find((row) => doltBoolean([row], "is_merging"));
  }

  private async abortOwnedMergeIfPresent(
    conn: WorkItemConnection,
    expectedBranch?: string
  ): Promise<boolean> {
    const state = await this.mergeState(conn);
    if (!state) return false;
    const source = String(state.source ?? "");
    const target = String(state.target ?? "");
    const owned =
      source.startsWith(OP_BRANCH_PREFIX) &&
      (expectedBranch === undefined || source === expectedBranch) &&
      (target === "main" || target === "refs/heads/main");
    if (!owned) throw new ForeignMergeInProgressError();

    await conn.unsafe("SELECT dolt_merge('--abort')");
    if (await this.mergeState(conn)) {
      throw new DoltOperationFailedError("dolt_merge --abort");
    }
    return true;
  }

  private async branchCommitIsOnMain(
    conn: WorkItemConnection,
    branchCommit: string
  ): Promise<boolean> {
    const rows = await conn.unsafe(
      `SELECT dolt_merge_base('main', ${escapeValue(branchCommit)}) AS dolt_merge_base`
    );
    return doltScalar(rows, "dolt_merge_base") === branchCommit;
  }

  private async assertMainClean(conn: WorkItemConnection): Promise<void> {
    const rows = (await conn.unsafe(
      "SELECT table_name FROM dolt.status"
    )) as ReadonlyArray<Record<string, unknown>>;
    if (
      rows.some((row) =>
        String(row.table_name ?? "")
          .toLowerCase()
          .endsWith("work_items")
      )
    ) {
      throw new DirtyWorkItemsMainError();
    }
  }

  private async mutate<T>(
    message: string,
    principalId: string,
    fn: (conn: WorkItemConnection, proof: MutationProof) => Promise<T>,
    options: MutationOptions<T>
  ): Promise<T> {
    return this.withOperationQueue(message, async (context) => {
      try {
        return await this.withGlobalLock(context, async (conn) => {
          await options.preflight?.(conn, options.proof);
          return this.mutateOnBranch(
            conn,
            message,
            requirePrincipal(principalId),
            fn,
            options.proof,
            options.shouldCommit ?? (() => true)
          );
        });
      } catch (error) {
        if (!(error instanceof PendingBranchRecoveryError)) throw error;
        const resolved = await this.withGlobalLock(
          context,
          (conn) =>
            this.resolveOperationBranch(
              conn,
              error.state.branch,
              error.state as PendingBranchState<T>,
              error.originalError
            ),
          { reconcile: "skipped" }
        );
        if (resolved === undefined) {
          throw new DoltMergeOutcomeUnknownError();
        }
        return resolved;
      }
    });
  }

  private async mutateOnBranch<T>(
    conn: WorkItemConnection,
    message: string,
    principalId: string,
    fn: (conn: WorkItemConnection, proof: MutationProof) => Promise<T>,
    proof: MutationProof,
    shouldCommit: (result: T) => boolean
  ): Promise<T> {
    const startedAt = Date.now();
    const branch = `${OP_BRANCH_PREFIX}${randomUUID()}`;
    conn.context.branch = branch;
    const baseRows = await conn.unsafe(
      "SELECT dolt_hashof('main') AS dolt_hashof"
    );
    const state: PendingBranchState<T> = {
      branch,
      baseHash: doltScalar(baseRows, "dolt_hashof"),
      proof,
    };
    // Arm recovery before branch-create: the ref can be durable even when the
    // checkout acknowledgement is lost (bug.5358 Rev3).
    try {
      const createRows = await conn.unsafe(
        `SELECT dolt_checkout('-b', ${escapeValue(branch)}, 'main')`
      );
      assertDoltStatus(createRows, "dolt_checkout");

      const result = await fn(conn, proof);
      state.result = result;
      if (!shouldCommit(result)) {
        await this.returnToMainAndDeleteBranch(conn, branch);
        return result;
      }
      const addRows = await conn.unsafe("SELECT dolt_add('work_items')");
      assertDoltStatus(addRows, "dolt_add");
      const commitRows = await conn.unsafe(
        `SELECT dolt_commit('-m', ${escapeValue(`${COMMIT_TAG}: ${message} by actor:${principalId}`)})`
      );
      const branchCommit = doltCommitHash(commitRows);
      state.branchCommit = branchCommit;

      const mainRows = await conn.unsafe("SELECT dolt_checkout('main')");
      assertDoltStatus(mainRows, "dolt_checkout");
      const transition = await this.validateOperationBranch(
        conn,
        branch,
        branchCommit,
        state as PendingBranchState<unknown>
      );
      requireNamedMerge(
        await conn.unsafe(
          `SELECT hash, fast_forward, conflicts, message FROM dolt_merge(${escapeValue(branch)})`
        )
      );
      state.requiresFreshOutcomeProof = true;
      // A merge acknowledgement alone is not success. Reachability and the
      // exact current row are proven while serialization is still held.
      await this.proveFreshMergeOutcome(conn, transition);
      await this.cleanupVerifiedBranch(conn, transition, startedAt);
      return result;
    } catch (error) {
      throw new PendingBranchRecoveryError(state, error);
    }
  }

  private async returnToMainAndDeleteBranch(
    conn: WorkItemConnection,
    branch: string
  ): Promise<void> {
    const checkoutRows = await conn.unsafe("SELECT dolt_checkout('main')");
    assertDoltStatus(checkoutRows, "dolt_checkout");
    await this.assertMainClean(conn);
    await this.deleteOperationBranch(conn, branch);
  }

  /**
   * Move an unprovable operation branch out of the swept namespace, loudly.
   * `error` is the proof failure that sent it here and is logged with it, so
   * the quarantine record says WHY this ref could not be proven rather than
   * just that it moved.
   */
  private async quarantineOperationBranch(
    conn: WorkItemConnection,
    branch: string,
    error: unknown
  ): Promise<void> {
    const target = `${QUARANTINE_BRANCH_PREFIX}${branch.slice(
      OP_BRANCH_PREFIX.length
    )}`;
    const rows = await conn.unsafe(
      `SELECT dolt_branch('-m', ${escapeValue(branch)}, ${escapeValue(target)})`
    );
    assertDoltStatus(rows, "dolt_branch");
    this.logReconciliation("warn", conn, {
      branch,
      quarantinedAs: target,
      classification: "quarantined_unprovable",
      ...errorFields(error),
    });
  }

  private async deleteOperationBranch(
    conn: WorkItemConnection,
    branch: string
  ): Promise<void> {
    const rows = await conn.unsafe(
      `SELECT dolt_branch('-D', ${escapeValue(branch)})`
    );
    assertDoltStatus(rows, "dolt_branch");
  }

  /**
   * COMMAND_QUERY_SEPARATION AT RUNTIME, not just in the type system.
   * `work-items-port.md` splits `WorkItemQueryPort` from
   * `WorkItemCommandPort`; this method is why that split has to hold in
   * execution too.
   *
   * `dolt_checkout` is session state, so a WRITE must own its session: pinned
   * connection, FIFO admission, advisory lock `GLOBAL_LOCK_KEY`. A READ needs
   * none of that — it reads committed `main`, which is plain SQL. Routing reads
   * through the write lane made read concurrency structurally 1 (a `max: 1`
   * pool behind a single-slot queue), so N concurrent readers serialized.
   * Measured on operator production: `operation.queue` averaged 2660 ms and
   * peaked at 7334 ms while the actual `dml.read` was 677 ms — a dashboard
   * firing four list calls took ~30 s to paint.
   *
   * The read path runs on a pool of its own — `readClient` when the caller
   * passed one, otherwise one the adapter derives from `recreateClient`. It
   * never calls `dolt_checkout`, never takes the lock, and never reconciles,
   * so read concurrency equals that pool's width and no read ever waits on a
   * write. Only a consumer that passes neither falls back to the shared lane.
   *
   * WHY NOT CHECKING OUT IS SAFE: a fresh connection opens on the database's
   * default branch, which is `main`. This lane never moves it, so every read
   * sees committed `main`. Writes never commit to `main` outside their proven
   * `work-item-op/*` merge, so there is no dirty-main window for a reader to
   * observe. Reads remain available through residual branch evidence, which is
   * the bug.5358 guarantee, and they no longer pay to enumerate it.
   */
  /**
   * The pool reads run on, or `undefined` when there is none and reads must
   * take the shared write lane.
   *
   * `recreateClient` is the caller's own factory for a work-items connection,
   * so a pool built from it has the right URL, the right `application_name`
   * shape, and the right driver options by construction — nothing here has to
   * guess a DSN. Reads need their OWN pool rather than a second checkout from
   * the write pool because that pool is `max: 1` on every node in the fleet:
   * sharing it would put every read back behind the in-flight write.
   */
  private resolveReadPool(): Sql | undefined {
    if (this.providedReadClient) return this.providedReadClient;
    if (this.derivedReadClient) return this.derivedReadClient;
    if (!this.recreateClient) return undefined;
    try {
      this.derivedReadClient = this.recreateClient();
    } catch (error) {
      // Never let pool construction fail a read: the shared lane still works.
      this.logger.warn(
        {
          event: "adapter.work_items.read_pool_derive_failed",
          ...errorFields(error),
        },
        "work_items could not derive a read pool; reads use the shared lane"
      );
      return undefined;
    }
    this.logger.info(
      { event: "adapter.work_items.read_pool_derived" },
      "work_items derived a dedicated read pool from recreateClient"
    );
    return this.derivedReadClient;
  }

  private async readOnCleanMain<T>(
    fn: (conn: WorkItemConnection) => Promise<T>
  ): Promise<T> {
    const readPool = this.resolveReadPool();
    if (!readPool) {
      // Legacy shared lane — unchanged for consumers that pass no read client.
      return this.withOperationQueue("read work items", (context) =>
        this.withGlobalLock(context, fn, { reconcile: "best_effort" })
      );
    }
    const context = { operationId: randomUUID(), operation: "read work items" };
    try {
      // No reserve(): a read pins no session state, so it does not need a
      // dedicated connection. postgres.js hands each concurrent query its own
      // pooled connection, which is exactly the bounded concurrency we want —
      // and is why this needs no hand-rolled semaphore. `executeQuery` only
      // uses `pool` for termination; the query itself goes through `.unsafe`,
      // which a pool exposes identically to a reserved connection.
      return await fn(
        this.instrumentConnection(
          readPool,
          readPool as unknown as ReservedSql,
          context
        )
      );
    } catch (error) {
      // A query timeout terminates the pool it ran on. A DERIVED pool is ours
      // to rebuild, so drop it and the next read builds a fresh one; a pool
      // the caller provided is not, so that one stays as given. Either way
      // this call falls back to the shared lane rather than failing a read the
      // legacy path could still serve — slow beats unavailable, and bug.5358's
      // whole point is that reads stay available.
      if (readPool === this.derivedReadClient) {
        this.derivedReadClient = undefined;
      }
      this.logger.warn(
        { event: "adapter.work_items.read_lane_fallback", ...errorFields(error) },
        "work_items read lane failed; retrying on the shared lane"
      );
      return this.withOperationQueue("read work items", (ctx) =>
        this.withGlobalLock(ctx, fn, { reconcile: "best_effort" })
      );
    }
  }

  private async getWith(conn: WorkItemConnection, id: WorkItemId) {
    const rows = await conn.unsafe(
      `SELECT *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active FROM work_items WHERE id = ${escapeValue(id as string)} LIMIT 1`
    );
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : undefined;
  }

  async get(id: WorkItemId): Promise<WorkItem | null> {
    return this.readOnCleanMain(async (conn) => {
      const row = await this.getWith(conn, id);
      return row ? rowToWorkItem(row) : null;
    });
  }

  async list(query: WorkQuery = {}): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }> {
    const conditions: string[] = [];
    if (query.ids?.length) {
      conditions.push(
        `id IN (${query.ids.map((id) => escapeValue(id as string)).join(", ")})`
      );
    }
    if (query.types?.length) {
      conditions.push(`type IN (${query.types.map(escapeValue).join(", ")})`);
    }
    if (query.statuses?.length) {
      conditions.push(
        `status IN (${query.statuses.map(escapeValue).join(", ")})`
      );
    }
    if (query.actor && query.actor !== "either") conditions.push("FALSE");
    if (query.projectId) {
      conditions.push(`project_id = ${escapeValue(query.projectId as string)}`);
    }
    if (query.node) {
      const nodes = Array.isArray(query.node) ? query.node : [query.node];
      conditions.push(`node IN (${nodes.map(escapeValue).join(", ")})`);
    }
    if (query.text) {
      const escaped = query.text.toLowerCase().replace(/[%_\\]/g, "\\$&");
      const pattern = escapeValue(`%${escaped}%`);
      conditions.push(
        `(LOWER(title) LIKE ${pattern} OR LOWER(COALESCE(summary,'')) LIKE ${pattern})`
      );
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const priority = cursor.p ?? 999;
      const rank = cursor.r ?? 999;
      conditions.push(
        `(COALESCE(priority,999) > ${priority}` +
          ` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) > ${rank})` +
          ` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at < ${escapeValue(cursor.ts)})` +
          ` OR (COALESCE(priority,999) = ${priority} AND COALESCE(rank,999) = ${rank} AND created_at = ${escapeValue(cursor.ts)} AND id > ${escapeValue(cursor.id)}))`
      );
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const rows = await this.readOnCleanMain(
      async (conn) =>
        (await conn.unsafe(
          `SELECT *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active FROM work_items ${where} ORDER BY COALESCE(priority, 999) ASC, COALESCE(rank, 999) ASC, created_at DESC, id ASC LIMIT ${limit + 1}`
        )) as ReadonlyArray<Record<string, unknown>>
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(rowToWorkItem);
    let endCursor: string | null = null;
    if (hasMore && pageRows.length) {
      const last = pageRows[pageRows.length - 1];
      if (!last) throw new Error("cursor row missing");
      const cursor: WorkItemCursor = {
        p: optionalNumber(last.priority) ?? null,
        r: optionalNumber(last.rank) ?? null,
        ts:
          last.created_at instanceof Date
            ? last.created_at.toISOString()
            : String(last.created_at ?? ""),
        id: String(last.id),
      };
      endCursor = encodeCursor(cursor);
    }
    return {
      items,
      pageInfo: { endCursor, hasMore },
      ...(endCursor && { nextCursor: endCursor }),
    };
  }

  async create(
    input: WorkItemsCreateInput,
    principalId: string
  ): Promise<WorkItem> {
    const principal = requirePrincipal(principalId);
    const createOnce = (allocatedId?: string) =>
      this.mutate("create work item", principal, async (conn, proof) => {
        const insert = async (allocatedId: string) => {
          const columns = [
            "id",
            "type",
            "title",
            "status",
            "node",
            "created_by_principal_id",
          ];
          const values = [
            escapeValue(allocatedId),
            escapeValue(input.type),
            escapeValue(input.title),
            escapeValue(input.status ?? "needs_triage"),
            escapeValue(input.node ?? "shared"),
            escapeValue(principal),
          ];
          const add = (column: string, value: unknown) => {
            if (value === undefined) return;
            columns.push(column);
            values.push(escapeValue(value));
          };
          add("summary", input.summary);
          add("outcome", input.outcome);
          add("project_id", input.projectId);
          add("parent_id", input.parentId);
          add("priority", input.priority);
          add("rank", input.rank);
          add("estimate", input.estimate);
          add("assignees", input.assignees);
          add("labels", input.labels);
          add("spec_refs", input.specRefs);
          const rows = await conn.unsafe(
            `INSERT INTO work_items (${columns.join(", ")}) VALUES (${values.join(", ")}) RETURNING *, FALSE AS claim_active`
          );
          const row = rows[0] as Record<string, unknown> | undefined;
          if (!row) throw new Error("INSERT returned no row");
          proof.itemId = allocatedId;
          proof.afterRow = row;
          return rowToWorkItem(row);
        };

        if (allocatedId) return insert(allocatedId);

        const idRows = await conn.unsafe(
          `SELECT id FROM work_items WHERE type = ${escapeValue(input.type)}`
        );
        let maxSuffix = this.idFloor - 1;
        for (const row of idRows as ReadonlyArray<Record<string, unknown>>) {
          const suffix = parseSuffix(String(row.id), input.type);
          if (suffix !== null && suffix > maxSuffix) maxSuffix = suffix;
        }
        const nextId = `${input.type}.${String(maxSuffix + 1).padStart(4, "0")}`;
        try {
          return await insert(nextId);
        } catch (error) {
          if (isDuplicateError(error)) {
            throw new WorkItemAlreadyExistsError(nextId);
          }
          throw error;
        }
      }, {
        proof: { verb: "create", principal },
      });

    if (input.id) {
      const requested = String(input.id);
      if (!requested.startsWith(`${input.type}.`)) {
        throw new Error(
          `Provided id '${requested}' does not match type '${input.type}'`
        );
      }
      try {
        return await createOnce(requested);
      } catch (error) {
        if (isDuplicateError(error)) {
          throw new WorkItemAlreadyExistsError(requested);
        }
        throw error;
      }
    }

    let lastCollisionId = `${input.type}.${this.idFloor}`;
    for (let attempt = 0; attempt < AUTO_ID_RETRIES; attempt += 1) {
      try {
        return await createOnce();
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        const match = /work item id '([^']+)'/.exec(
          error instanceof Error ? error.message : ""
        );
        if (match?.[1]) lastCollisionId = match[1];
      }
    }
    throw new WorkItemAlreadyExistsError(lastCollisionId);
  }

  async patch(
    input: WorkItemsPatchInput,
    principalId: string
  ): Promise<WorkItem> {
    const principal = requirePrincipal(principalId);
    const clauses: string[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [
      keyof WorkItemsPatchSet,
      string,
    ][]) {
      const value = input.set[key];
      if (value !== undefined)
        clauses.push(`${column} = ${escapeValue(value)}`);
    }
    if (!clauses.length) {
      return this.readOnCleanMain(async (conn) => {
        const current = await this.getWith(conn, input.id);
        if (!current)
          throw new Error(`Work item not found: ${input.id as string}`);
        if (!mayMutate(current, principal)) {
          throw new WorkItemAuthorizationError(input.id as string);
        }
        return rowToWorkItem(current);
      });
    }

    return this.mutate(
      `patch ${input.id as string}`,
      principal,
      async (conn, proof) => {
        clauses.push("revision = revision + 1", "updated_at = NOW()");
        const rows = await conn.unsafe(
          `UPDATE work_items SET ${clauses.join(", ")} WHERE id = ${escapeValue(input.id as string)} AND (created_by_principal_id IS NULL OR created_by_principal_id = ${escapeValue(principal)}) RETURNING *, (claim_expires_at IS NOT NULL AND claim_expires_at > NOW()) AS claim_active`
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) await this.throwMissingOrUnauthorized(conn, input.id);
        proof.afterRow = row as Record<string, unknown>;
        return rowToWorkItem(row as Record<string, unknown>);
      },
      {
        proof: {
          verb: "patch",
          principal,
          itemId: input.id as string,
          patchValues: Object.fromEntries(
            (Object.entries(PATCH_COLUMNS) as [
              keyof WorkItemsPatchSet,
              string,
            ][])
              .filter(([key]) => input.set[key] !== undefined)
              .map(([key, column]) => [column, input.set[key]])
          ),
        },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, input.id);
          if (!current)
            throw new Error(`Work item not found: ${input.id as string}`);
          if (!mayMutate(current, principal)) {
            throw new WorkItemAuthorizationError(input.id as string);
          }
          proof.beforeRow = current;
        },
      }
    );
  }

  async delete(id: WorkItemId, principalId: string): Promise<boolean> {
    const principal = requirePrincipal(principalId);
    return this.mutate(
      `delete ${id as string}`,
      principal,
      async (conn) => {
        const rows = await conn.unsafe(
          `DELETE FROM work_items WHERE id = ${escapeValue(id as string)} AND (created_by_principal_id IS NULL OR created_by_principal_id = ${escapeValue(principal)}) RETURNING id`
        );
        if (rows.length) return true;
        const current = await this.getWith(conn, id);
        if (current) throw new WorkItemAuthorizationError(id as string);
        return false;
      },
      {
        proof: { verb: "delete", principal, itemId: id as string },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, id);
          if (!current) return;
          if (!mayMutate(current, principal)) {
            throw new WorkItemAuthorizationError(id as string);
          }
          proof.beforeRow = current;
        },
        shouldCommit: Boolean,
      }
    );
  }

  private async throwMissingOrUnauthorized(
    conn: WorkItemConnection,
    id: WorkItemId
  ): Promise<never> {
    if (await this.getWith(conn, id)) {
      throw new WorkItemAuthorizationError(id as string);
    }
    throw new Error(`Work item not found: ${id as string}`);
  }

  async claim(input: {
    id: WorkItemId;
    runId: string;
    command: string;
    principalId: string;
  }): Promise<WorkItem> {
    const principal = requirePrincipal(input.principalId);
    return this.mutate(
      `claim ${input.id as string}`,
      principal,
      async (conn, proof) => {
        const rows = await conn.unsafe(
          `UPDATE work_items SET claimed_by_run = ${escapeValue(input.runId)}, claim_owner_principal_id = ${escapeValue(principal)}, claimed_at = NOW(), claim_expires_at = NOW() + INTERVAL '${CLAIM_TTL_SECONDS} seconds', last_command = ${escapeValue(input.command)}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND (claim_expires_at IS NULL OR claim_expires_at <= NOW() OR (claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)})) RETURNING *, TRUE AS claim_active`
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
        proof.afterRow = row as Record<string, unknown>;
        return rowToWorkItem(row as Record<string, unknown>);
      },
      {
        proof: {
          verb: "claim",
          principal,
          itemId: input.id as string,
          runId: input.runId,
          command: input.command,
          commandProvided: true,
        },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, input.id);
          if (!current)
            throw new Error(`Work item not found: ${input.id as string}`);
          const sameLease =
            String(current.claim_owner_principal_id ?? "") === principal &&
            String(current.claimed_by_run ?? "") === input.runId;
          if (current.claim_active !== false && !sameLease) {
            throw new WorkItemLeaseConflictError(input.id as string);
          }
          proof.beforeRow = current;
        },
      }
    );
  }

  async heartbeat(input: {
    id: WorkItemId;
    runId: string;
    command?: string;
    principalId: string;
  }): Promise<WorkItem> {
    const principal = requirePrincipal(input.principalId);
    return this.mutate(
      `heartbeat ${input.id as string}`,
      principal,
      async (conn, proof) => {
        const command =
          input.command === undefined
            ? ""
            : `, last_command = ${escapeValue(input.command)}`;
        const rows = await conn.unsafe(
          `UPDATE work_items SET claim_expires_at = NOW() + INTERVAL '${CLAIM_TTL_SECONDS} seconds'${command}, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)} AND claim_expires_at > NOW() RETURNING *, TRUE AS claim_active`
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
        proof.afterRow = row as Record<string, unknown>;
        return rowToWorkItem(row as Record<string, unknown>);
      },
      {
        proof: {
          verb: "heartbeat",
          principal,
          itemId: input.id as string,
          runId: input.runId,
          command: input.command,
          commandProvided: input.command !== undefined,
        },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, input.id);
          if (!current)
            throw new Error(`Work item not found: ${input.id as string}`);
          const leaseMatches =
            current.claim_active !== false &&
            String(current.claim_owner_principal_id ?? "") === principal &&
            String(current.claimed_by_run ?? "") === input.runId;
          if (!leaseMatches) {
            throw new WorkItemLeaseConflictError(input.id as string);
          }
          proof.beforeRow = current;
        },
      }
    );
  }

  async release(input: {
    id: WorkItemId;
    runId: string;
    principalId: string;
  }): Promise<WorkItem> {
    const principal = requirePrincipal(input.principalId);
    return this.mutate(
      `release ${input.id as string}`,
      principal,
      async (conn, proof) => {
        const rows = await conn.unsafe(
          `UPDATE work_items SET claimed_by_run = NULL, claim_owner_principal_id = NULL, claimed_at = NULL, claim_expires_at = NULL, revision = revision + 1, updated_at = NOW() WHERE id = ${escapeValue(input.id as string)} AND claim_owner_principal_id = ${escapeValue(principal)} AND claimed_by_run = ${escapeValue(input.runId)} RETURNING *, FALSE AS claim_active`
        );
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row) await this.throwLeaseConflictOrMissing(conn, input.id);
        proof.afterRow = row as Record<string, unknown>;
        return rowToWorkItem(row as Record<string, unknown>);
      },
      {
        proof: {
          verb: "release",
          principal,
          itemId: input.id as string,
          runId: input.runId,
        },
        preflight: async (conn, proof) => {
          const current = await this.getWith(conn, input.id);
          if (!current)
            throw new Error(`Work item not found: ${input.id as string}`);
          const leaseMatches =
            String(current.claim_owner_principal_id ?? "") === principal &&
            String(current.claimed_by_run ?? "") === input.runId;
          if (!leaseMatches) {
            throw new WorkItemLeaseConflictError(input.id as string);
          }
          proof.beforeRow = current;
        },
      }
    );
  }

  private async throwLeaseConflictOrMissing(
    conn: WorkItemConnection,
    id: WorkItemId
  ): Promise<never> {
    if (await this.getWith(conn, id)) {
      throw new WorkItemLeaseConflictError(id as string);
    }
    throw new Error(`Work item not found: ${id as string}`);
  }

  async listRelations(id: WorkItemId): Promise<WorkRelation[]> {
    const rows = await this.readOnCleanMain(
      async (conn) =>
        (await conn.unsafe(
          `SELECT id, parent_id, blocked_by FROM work_items WHERE id = ${escapeValue(id as string)} OR parent_id = ${escapeValue(id as string)} OR blocked_by = ${escapeValue(id as string)}`
        )) as ReadonlyArray<Record<string, unknown>>
    );
    const relations: WorkRelation[] = [];
    for (const row of rows) {
      const rowId = toWorkItemId(String(row.id));
      if (row.parent_id) {
        relations.push({
          fromId: toWorkItemId(String(row.parent_id)),
          toId: rowId,
          type: "parent_of",
        });
      }
      if (row.blocked_by) {
        relations.push({
          fromId: toWorkItemId(String(row.blocked_by)),
          toId: rowId,
          type: "blocks",
        });
      }
    }
    return relations;
  }
}
