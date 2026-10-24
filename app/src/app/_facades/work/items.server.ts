// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations across the markdown + Doltgres surfaces.
 * Scope: Maps port results to contract DTOs and merges node-local Doltgres rows with legacy markdown rows.
 * Invariants: P0P1_IS_NODE_ADMIN (story.5101: priority <= 1 on create/patch requires node admin,
 *   checked before the store write), PORT_VIA_CONTAINER (no direct adapter imports), CONTRACTS_ARE_TRUTH, NODE_STORE_IS_LOCAL.
 * Evaluation: preserves scores in DTOs and normalizes package validation failures for HTTP400.
 * Side-effects: IO (filesystem read via port; database read/write via Doltgres port)
 * Links: contracts/work.items.{list,get,create,patch}.v1.contract
 * @internal
 */

import { createHash } from "node:crypto";
import {
  checkNodeAdmin,
  isPrivilegedPriority,
  NodeAdminRequiredError,
} from "@cogni/knowledge-store";
import type {
  WorkItemsCreateInput as ContractCreateInput,
  WorkItemsPatchInput as ContractPatchInput,
  WorkItemCoordinationOutput,
  WorkItemDto,
  WorkItemsListInput,
  WorkItemsListOutput,
  WorkItemsWorkflowInput,
} from "@cogni/node-contracts";
import { WorkflowRunSchema } from "@cogni/node-contracts";
import type { WorkItem, WorkItemId, WorkItemLease } from "@cogni/work-items";
import {
  canonicalJson,
  CICD_WORKFLOWS,
  WorkItemRevisionConflictError,
  WorkItemScoresInvalidError,
  WorkItemWriteOutcomeUnknownError,
  toWorkItemId,
  transitionWorkflow,
  WorkflowConflictError,
} from "@cogni/work-items";
import { checkpointFor } from "@/bootstrap/workflow-guidance";
import { getContainer } from "@/bootstrap/container";

/**
 * Thrown when the opaque pagination cursor cannot be decoded — translated
 * to HTTP 400 in the route layer instead of the wrapper's generic 500.
 * The adapter's cursor codec throws a structurally identical error
 * (`name === "InvalidCursorError"`); the facade detects by name and
 * rethrows its own copy so the app layer doesn't have to import from
 * `@/adapters/**` (forbidden by `no-restricted-imports`).
 */
export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export { NodeAdminRequiredError, WorkItemRevisionConflictError, WorkItemScoresInvalidError, WorkItemWriteOutcomeUnknownError };

export class WorkItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Work item not found: ${id}`);
    this.name = "WorkItemNotFoundError";
  }
}

export class WorkItemForbiddenError extends Error {
  constructor(id: string) {
    super(`Not authorized to mutate work item: ${id}`);
    this.name = "WorkItemForbiddenError";
  }
}

/**
 * P0P1_IS_NODE_ADMIN (story.5101): refuse a priority <= 1 write unless the caller
 * is node admin (the container's `nodeAdmin` authority), BEFORE any store write.
 * Throws `NodeAdminRequiredError` (403 `authz_denied` / 503 `authz_unavailable`).
 */
async function assertPriorityAuthority(
  priority: number | null | undefined,
  actor: WorkItemActor,
): Promise<void> {
  if (!isPrivilegedPriority(priority)) return;
  const decision = await checkNodeAdmin(getContainer().nodeAdmin, {
    userId: actor.id,
    walletAddress: actor.walletAddress ?? null,
  });
  if (!decision.ok) {
    const err = new NodeAdminRequiredError(
      decision,
      `work.items.priority.p${priority}`,
    );
    getContainer().log.warn(
      {
        errorCode: err.errorCode,
        reason: err.reason,
        action: err.action,
        userId: actor.id,
      },
      "work.items.priority_node_admin_refused",
    );
    throw err;
  }
}

/** The caller of a work-item write; `walletAddress` is null for agent keys. */
export interface WorkItemActor {
  id: string;
  walletAddress?: string | null;
}

export class WorkItemLeaseConflictError extends Error {
  constructor(id: string) {
    super(`Work item is claimed by another principal or lease: ${id}`);
    this.name = "WorkItemLeaseConflictError";
  }
}

export class WorkItemsBackendNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemsBackendNotReadyError";
  }
}

export { WorkflowConflictError };

function toDto(item: WorkItem): WorkItemDto {
  return {
    id: item.id as string,
    type: item.type,
    title: item.title,
    status: item.status,
    ...(item.actor !== "either" && { actor: item.actor }),
    priority: item.priority,
    rank: item.rank,
    estimate: item.estimate,
    ...(item.scores !== undefined && { scores: item.scores }),
    summary: item.summary,
    outcome: item.outcome,
    ...(item.workflowRun
      ? {
          workflowRun: WorkflowRunSchema.parse(item.workflowRun),
          nextCheckpoint: checkpointFor(item),
        }
      : {}),
    projectId: item.projectId as string | undefined,
    parentId: item.parentId as string | undefined,
    node: item.node,
    assignees: item.assignees as WorkItemDto["assignees"],
    externalRefs: item.externalRefs as WorkItemDto["externalRefs"],
    labels: item.labels as string[],
    specRefs: item.specRefs as string[],
    branch: item.branch,
    pr: item.pr,
    reviewer: item.reviewer,
    revision: item.revision,
    blockedBy: item.blockedBy as string | undefined,
    deployVerified: item.deployVerified,
    claimedByRun: item.claimedByRun,
    claimedAt: item.claimedAt,
    lastCommand: item.lastCommand,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function nextActionForWorkItem(item: WorkItem): string | null {
  if (item.blockedBy) return "blocked";
  if (item.workflowRun)
    return item.workflowRun.checkpointId
      ? `workflow:${item.workflowRun.checkpointId}`
      : null;
  switch (item.status) {
    case "needs_triage":
      return "/triage";
    case "needs_research":
      return "/research";
    case "needs_design":
      return "/design";
    case "needs_implement":
      return "/implement";
    case "needs_closeout":
      return "/closeout";
    case "needs_merge":
      return item.deployVerified ? "/merge" : "/validate-candidate";
    case "blocked":
      return "blocked";
    case "done":
    case "cancelled":
      return null;
  }
}

type StripUndefined<T> = {
  [K in keyof T]?: Exclude<T[K], undefined>;
};

function dropUndefined<T extends Record<string, unknown>>(
  obj: T,
): StripUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as StripUndefined<T>;
}

function rethrowBackendError(error: unknown): never {
  const message = (error as Error)?.message ?? "";
  const notFound = /^Work item not found: (.+)$/.exec(message);
  if (notFound?.[1]) throw new WorkItemNotFoundError(notFound[1]);
  if ((error as Error)?.name === "WorkItemRevisionConflictError") {
    // Root and adapter entrypoints may bundle separate copies of the class.
    // Normalize to the public constructor used by the HTTP boundary.
    const conflict = error as {
      id?: unknown;
      expectedRevision?: unknown;
      currentRevision?: unknown;
    };
    if (
      typeof conflict.id === "string" &&
      typeof conflict.expectedRevision === "number" &&
      typeof conflict.currentRevision === "number"
    ) {
      throw new WorkItemRevisionConflictError(
        conflict.id,
        conflict.expectedRevision,
        conflict.currentRevision
      );
    }
  }
  if ((error as Error)?.name === "WorkItemScoresInvalidError") {
    // SCORES_ONE_ENFORCER (story.5111): the adapter's parseWorkItemScores is
    // the only bounds check; a rejection is the caller's error (400), never 500.
    const issues = (error as { issues?: unknown }).issues;
    throw new WorkItemScoresInvalidError(
      Array.isArray(issues)
        ? (issues as WorkItemScoresInvalidError["issues"])
        : []
    );
  }
  if ((error as Error)?.name === "WorkItemWriteOutcomeUnknownError") {
    const receipt = error as WorkItemWriteOutcomeUnknownError;
    throw new WorkItemWriteOutcomeUnknownError(
      receipt.operationId,
      receipt.branch,
      receipt.commitHash,
      receipt.itemId
    );
  }
  if (
    (error as Error)?.name === "DoltgresNotConfiguredError" ||
    (error as Error)?.name === "WorkItemsBusyError" ||
    (error as Error)?.name === "DoltMergeOutcomeUnknownError"
  ) {
    throw new WorkItemsBackendNotReadyError(message);
  }
  if ((error as Error)?.name === "WorkItemAuthorizationError") {
    const id = (error as { id?: string }).id ?? "unknown";
    throw new WorkItemForbiddenError(id);
  }
  if ((error as Error)?.name === "WorkItemLeaseConflictError") {
    const id = (error as { id?: string }).id ?? "unknown";
    throw new WorkItemLeaseConflictError(id);
  }
  throw error;
}

export async function listWorkItems(
  input: WorkItemsListInput,
): Promise<WorkItemsListOutput> {
  const container = getContainer();
  const queryShared = {
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.node && { node: input.node }),
    ...(input.limit && { limit: input.limit }),
    ...(input.cursor && { cursor: input.cursor }),
  };

  // Pagination strategy:
  //   - Doltgres is the cursor-paginated source of truth (post-#1144 importer
  //     back-fills markdown items into Doltgres at their original IDs).
  //   - On the first page (no cursor) we ALSO query the markdown adapter so
  //     any items that haven't been imported yet still appear. Doltgres rows
  //     win on id conflict (single-source dedup).
  //   - Merged page is truncated to `limit` so the response never overflows.
  //   - hasMore tracks Doltgres only — markdown is finite/small and only
  //     contributes to page 1; once Doltgres exhausts pagination ends.
  //   - Markdown-only items that overflow page 1 are dropped from the response;
  //     this is acceptable because markdown is being deprecated and the
  //     importer back-fill closes the gap.
  let dgItems: WorkItem[] = [];
  let endCursor: string | null = null;
  let hasMore = false;

  try {
    const dgResult = await container.doltgresWorkItems.list(queryShared);
    dgItems = [...dgResult.items];
    endCursor = dgResult.pageInfo.endCursor;
    hasMore = dgResult.pageInfo.hasMore;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "InvalidCursorError") {
      throw new InvalidCursorError((e as Error).message);
    }
    if (name !== "DoltgresNotConfiguredError") rethrowBackendError(e);
  }

  let merged: WorkItem[] = dgItems;
  if (!input.cursor) {
    const mdResult = await container.workItemQuery.list(queryShared);
    const dgIds = new Set(dgItems.map((i) => i.id as string));
    const mdOnly = mdResult.items.filter((i) => !dgIds.has(i.id as string));
    merged = [...dgItems, ...mdOnly];
  }

  const requestedLimit = input.limit ?? 100;
  if (merged.length > requestedLimit) {
    merged = merged.slice(0, requestedLimit);
  }

  return {
    items: merged.map(toDto),
    pageInfo: { endCursor, hasMore },
    ...(endCursor !== null && { nextCursor: endCursor }),
  };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  // Doltgres-first: legacy markdown IDs (e.g. bug.0002) can also live in Doltgres
  // after the markdown→Doltgres import (task.5002). Fall back to markdown only when
  // Doltgres returns null, so unimported legacy IDs still resolve during transition.
  try {
    const item = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (item) return toDto(item);
  } catch (e) {
    if ((e as Error)?.name !== "DoltgresNotConfiguredError") {
      rethrowBackendError(e);
    }
  }
  const mdItem = await container.workItemQuery.get(id as WorkItemId);
  return mdItem ? toDto(mdItem) : null;
}

export async function createWorkItem(
  input: ContractCreateInput,
  sessionUser: WorkItemActor,
): Promise<WorkItemDto> {
  await assertPriorityAuthority(input.priority, sessionUser);
  const container = getContainer();
  try {
    const created = await container.doltgresWorkItems.create(
      {
        type: input.type,
        title: input.title,
        ...(input.id !== undefined && { id: toWorkItemId(input.id) }),
        ...(input.summary !== undefined && { summary: input.summary }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.specRefs !== undefined && { specRefs: input.specRefs }),
        ...(input.projectId !== undefined && {
          projectId: toWorkItemId(input.projectId),
        }),
        ...(input.parentId !== undefined && {
          parentId: toWorkItemId(input.parentId),
        }),
        ...(input.labels !== undefined && { labels: input.labels }),
        ...(input.assignees !== undefined && { assignees: input.assignees }),
        ...(input.node !== undefined && { node: input.node }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.rank !== undefined && { rank: input.rank }),
        ...(input.estimate !== undefined && { estimate: input.estimate }),
        ...(input.scores !== undefined && { scores: input.scores }),
      },
      sessionUser.id,
    );
    return toDto(created);
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function patchWorkItem(
  input: ContractPatchInput,
  sessionUser: WorkItemActor,
): Promise<WorkItemDto> {
  await assertPriorityAuthority(input.set.priority, sessionUser);
  const container = getContainer();
  try {
    const patched = await container.doltgresWorkItems.patch(
      {
        id: toWorkItemId(input.id),
        ...(input.expectedRevision !== undefined && {
          expectedRevision: input.expectedRevision,
        }),
        set: dropUndefined(input.set),
      },
      sessionUser.id,
    );
    if (!patched) throw new WorkItemNotFoundError(input.id);
    return toDto(patched);
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function deleteWorkItem(
  id: string,
  sessionUser: { id: string },
): Promise<boolean> {
  const container = getContainer();
  try {
    return await container.doltgresWorkItems.delete(
      toWorkItemId(id),
      sessionUser.id,
    );
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function claimWorkItem(input: {
  id: string;
  runId: string;
  command: string;
  principalId: string;
}): Promise<WorkItemLease> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.claim({
      id: toWorkItemId(input.id),
      runId: input.runId,
      command: input.command,
      principalId: input.principalId,
    });
    return item;
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function releaseWorkItem(input: {
  id: string;
  runId: string;
  leaseToken: string;
  principalId: string;
}): Promise<WorkItemLease> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.release({
      id: toWorkItemId(input.id),
      runId: input.runId,
      leaseToken: input.leaseToken,
      principalId: input.principalId,
    });
    return item;
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function heartbeatWorkItem(input: {
  id: string;
  runId: string;
  leaseToken: string;
  command?: string;
  principalId: string;
}): Promise<WorkItemLease> {
  const container = getContainer();
  try {
    const item = await container.doltgresWorkItems.heartbeat({
      id: toWorkItemId(input.id),
      runId: input.runId,
      leaseToken: input.leaseToken,
      ...(input.command !== undefined && { command: input.command }),
      principalId: input.principalId,
    });
    return item;
  } catch (error) {
    rethrowBackendError(error);
  }
}

export async function getWorkItemCoordination(
  id: string,
): Promise<WorkItemCoordinationOutput> {
  const container = getContainer();
  try {
    const current = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (!current) throw new WorkItemNotFoundError(id);
    return {
      nextAction: nextActionForWorkItem(current),
      ...(current.workflowRun
        ? { nextCheckpoint: checkpointFor(current) }
        : {}),
      session: {
        status: current.claimedByRun ? "active" : "none",
        claimedByRun: current.claimedByRun ?? null,
        claimedByDisplayName: current.claimedByRun ?? null,
        claimedAt: current.claimedAt ?? null,
        lastCommand: current.lastCommand ?? null,
      },
    };
  } catch (error) {
    if (error instanceof WorkItemNotFoundError) throw error;
    rethrowBackendError(error);
  }
}

/** Compose the pure transition with the existing node-local, claim-fenced CAS write. */
export async function recordWorkItemWorkflow(
  input: WorkItemsWorkflowInput,
  principalId: string,
) {
  const store = getContainer().doltgresWorkItems;
  const id = toWorkItemId(input.id);
  try {
    const current = await store.get(id);
    if (!current) throw new WorkItemNotFoundError(input.id);
    const profile = workflowProfile(input.event.workflowId);
    if (!profile) throw new WorkflowConflictError("workflow_not_found");
    const canonical = canonicalJson(input.event);
    const result = transitionWorkflow(
      current.workflowRun,
      input.event,
      profile.definition,
      profile.identity,
      sha256(canonical),
      new Date().toISOString(),
    );
    // A matching receipt is a readback, including after the lease/session changed.
    if (result.replayed) return { item: toDto(current), replayed: true };
    if (current.revision !== input.expectedRevision)
      throw new WorkflowConflictError("stale_revision");
    const item = await store.patch(
      {
        id,
        expectedRevision: input.expectedRevision,
        set: {
          workflowRun: result.run,
          ...(result.status ? { status: result.status } : {}),
        },
      },
      principalId,
    );
    return { item: toDto(item), replayed: false };
  } catch (error) {
    if (
      error instanceof WorkflowConflictError ||
      error instanceof WorkItemNotFoundError
    )
      throw error;
    rethrowBackendError(error);
  }
}
