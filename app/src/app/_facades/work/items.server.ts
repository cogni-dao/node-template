// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/work/items.server`
 * Purpose: Server-side facade for work item read/write operations across the markdown + Doltgres surfaces.
 * Scope: Maps one authoritative backend to contract DTOs; Markdown only when Doltgres is unconfigured.
 * Invariants: P0P1_IS_NODE_ADMIN (story.5101: priority <= 1 on create/patch requires node admin,
 *   checked before the store write), PORT_VIA_CONTAINER (no direct adapter imports), CONTRACTS_ARE_TRUTH, NODE_STORE_IS_LOCAL.
 * Evaluation: preserves scores in DTOs. Write errors pass through unchanged; `workItemWriteErrorResponse` (@cogni/work-items) maps them to HTTP in the route (task.0097).
 * Moves (story.0033): create and patch resolve new metric links and pin baselines. Detail and bounded summary reads add authorized observations and directional verdicts. Null-direction writes remain gated until reader rollout completes.
 * Side-effects: IO (filesystem read via port; database read/write via Doltgres port)
 * Links: contracts/work.items.{list,get,create,patch}.v1.contract
 * @internal
 */

import type {
  WorkItemsCreateInput as ContractCreateInput,
  WorkItemsPatchInput as ContractPatchInput,
  WorkItemCoordinationOutput,
  WorkItemDto,
  WorkItemsListInput,
  WorkItemsListOutput,
  WorkItemSummariesListInput,
  WorkItemSummariesListOutput,
} from "@cogni/node-contracts";
import { WorkItemSummarySchema } from "@cogni/node-contracts";
import type {
  WorkItem,
  WorkItemId,
  WorkBoardColumnPages,
  WorkItemLease,
  WorkSummaryReadOptions,
} from "@cogni/work-items";
import {
  judgeMoveSummaries,
  toWorkItemId,
  toWorkItemsCreateInput,
  toWorkItemsPatchInput,
} from "@cogni/work-items";

import {
  checkNodeAdmin,
  isPrivilegedPriority,
  NodeAdminRequiredError,
} from "@cogni/knowledge-store";
import { createMoveMetricPorts } from "@/bootstrap/capabilities/work-item-moves";
import { getContainer } from "@/bootstrap/container";
import { toHttpWorkItem } from "../read-envelopes.server";

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

export { NodeAdminRequiredError };

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
    const err = new NodeAdminRequiredError(decision, `work.items.priority.p${priority}`);
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

const toDto = toHttpWorkItem;

/**
 * MOVES_READ_AT_READ_TIME: add each move's baseline, current reading and verdict to a
 * single item. Never throws: a lookup that fails reads `unknown`. A list read does not call this.
 */
async function withMoveReadings(dto: WorkItemDto): Promise<WorkItemDto> {
  if (!dto.moves?.length) return dto;
  const container = getContainer();
  // No metrics service on this node: every move reads `unknown` (metrics_unavailable).
  const readings = container.goalMetrics
    ? createMoveMetricPorts(() => container.goalMetrics).readings
    : undefined;
  return (await judgeMoveSummaries([dto], readings))[0] ?? dto;
}

async function withSummaryReadings<T extends { moves?: WorkItemDto["moves"] }>(
  items: readonly T[],
): Promise<T[]> {
  const container = getContainer();
  const readings = container.goalMetrics
    ? createMoveMetricPorts(() => container.goalMetrics).readings
    : undefined;
  return judgeMoveSummaries(items, readings);
}

function nextActionForWorkItem(item: WorkItem): string | null {
  if (item.blockedBy) return "blocked";
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

function rethrowBackendError(error: unknown): never {
  const message = (error as Error)?.message ?? "";
  const notFound = /^Work item not found: (.+)$/.exec(message);
  if (notFound?.[1]) throw new WorkItemNotFoundError(notFound[1]);
  // Errors the package owns (revision conflict, scores, reason, cites, moves, resolver and
  // baseline failures, write-outcome-unknown) pass through: the route maps them with
  // `workItemWriteErrorResponse`, which matches by name across bundled copies (task.0097).
  // `WorkItemsCapacityError` subclasses `WorkItemsBusyError` and keeps its
  // name, so held native capacity is also a retryable 503, never a 500.
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

function workQuery(input: WorkItemsListInput) {
  return {
    ...(input.sortBy !== undefined && { sortBy: input.sortBy }),
    ...(input.sortDirection !== undefined && {
      sortDirection: input.sortDirection,
    }),
    ...(input.types && { types: input.types as WorkItem["type"][] }),
    ...(input.statuses && { statuses: input.statuses as WorkItem["status"][] }),
    ...(input.text && { text: input.text }),
    ...(input.actor && { actor: input.actor as WorkItem["actor"] }),
    ...(input.projectId && { projectId: toWorkItemId(input.projectId) }),
    ...(input.projectIds && { projectIds: input.projectIds.map(toWorkItemId) }),
    ...(input.rankMin !== undefined && { rankMin: input.rankMin }),
    ...(input.rankMax !== undefined && { rankMax: input.rankMax }),
    ...(input.node && { node: input.node }),
    ...(input.labels && { labels: input.labels }),
    ...(input.labelPrefix !== undefined && { labelPrefix: input.labelPrefix }),
    ...(input.scored !== undefined && { scored: input.scored }),
    limit: input.limit ?? 100,
    ...(input.cursor && { cursor: input.cursor }),
  };
}

export async function listWorkItems(input: WorkItemsListInput): Promise<WorkItemsListOutput> {
  const container = getContainer();
  const queryShared = workQuery(input);

  // Exactly one backend owns the total order and its cursor. Configured Dolt
  // failures stay errors; only genuinely absent configuration selects Markdown.
  try {
    const result = await container.doltgresWorkItems.list(queryShared);
    return {
      items: result.items.map(toDto),
      pageInfo: result.pageInfo,
      ...(result.pageInfo.endCursor !== null && {
        nextCursor: result.pageInfo.endCursor,
      }),
    };
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursorError")
      throw new InvalidCursorError((error as Error).message);
    if ((error as Error)?.name !== "DoltgresNotConfiguredError") rethrowBackendError(error);
  }
  try {
    const result = await container.workItemQuery.list(queryShared);
    return {
      items: result.items.map(toDto),
      pageInfo: {
        endCursor: result.nextCursor ?? null,
        hasMore: result.nextCursor !== undefined,
      },
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    };
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursorError")
      throw new InvalidCursorError((error as Error).message);
    throw error;
  }
}

/** One bounded summary page; `options` (signal, shared deadline, scan budget) only tightens the read. */
export async function listWorkSummaries(
  input: WorkItemSummariesListInput,
  options?: WorkSummaryReadOptions,
): Promise<WorkItemSummariesListOutput> {
  const container = getContainer();
  const query = workQuery(input);
  try {
    const page = await container.doltgresWorkItems.listSummaries(query, options);
    return { ...page, items: await withSummaryReadings(page.items) };
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursorError")
      throw new InvalidCursorError((error as Error).message);
    if ((error as Error)?.name !== "DoltgresNotConfiguredError") rethrowBackendError(error);
  }
  try {
    const result = await container.workItemQuery.list(query);
    return {
      items: await withSummaryReadings(
        result.items.map((item) => WorkItemSummarySchema.parse(toDto(item))),
      ),
      pageInfo: { endCursor: result.nextCursor ?? null, hasMore: result.nextCursor !== undefined },
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    };
  } catch (error) {
    if ((error as Error)?.name === "InvalidCursorError")
      throw new InvalidCursorError((error as Error).message);
    throw error;
  }
}

/**
 * First page of every listed board column in ONE store read when the Doltgres
 * port composes it (task.0055); otherwise (Markdown) one summary read per
 * column. Text queries never reach here (the package keeps them per-column).
 */
export async function listWorkBoardColumns(
  input: WorkItemSummariesListInput,
  statuses: readonly string[],
  perColumn: number,
  options?: { readonly signal?: AbortSignal },
): Promise<WorkBoardColumnPages> {
  const container = getContainer();
  const port = container.doltgresWorkItems;
  if (port.listBoardColumns) {
    try {
      const page = await port.listBoardColumns(workQuery(input), statuses, perColumn, options);
      const items = await withSummaryReadings(page.columns.flatMap((column) => column.items));
      let offset = 0;
      return {
        ...page,
        columns: page.columns.map((column) => {
          const start = offset;
          offset += column.items.length;
          return { ...column, items: items.slice(start, offset) };
        }),
      };
    } catch (error) {
      if ((error as Error)?.name === "InvalidCursorError")
        throw new InvalidCursorError((error as Error).message);
      if ((error as Error)?.name !== "DoltgresNotConfiguredError") rethrowBackendError(error);
    }
  }
  const columns = [];
  for (const status of statuses) {
    const page = await listWorkSummaries(
      { ...input, statuses: [status], limit: perColumn },
      options,
    );
    columns.push({ status, items: page.items, pageInfo: page.pageInfo });
  }
  return { columns, queryCount: columns.length };
}

export async function getWorkItem(id: string): Promise<WorkItemDto | null> {
  const container = getContainer();
  // Doltgres-first: legacy markdown IDs (e.g. bug.0002) can also live in Doltgres
  // after the markdown→Doltgres import (task.5002). Fall back to markdown only when
  // Doltgres returns null, so unimported legacy IDs still resolve during transition.
  try {
    const item = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (item) return await withMoveReadings(toDto(item));
  } catch (e) {
    if ((e as Error)?.name !== "DoltgresNotConfiguredError") {
      rethrowBackendError(e);
    }
  }
  const mdItem = await container.workItemQuery.get(id as WorkItemId);
  return mdItem ? withMoveReadings(toDto(mdItem)) : null;
}

export async function createWorkItem(
  input: ContractCreateInput,
  sessionUser: WorkItemActor,
): Promise<WorkItemDto> {
  await assertPriorityAuthority(input.priority, sessionUser);
  const container = getContainer();
  try {
    const created = await container.doltgresWorkItems.create(
      toWorkItemsCreateInput(input),
      sessionUser.id,
    );
    return await withMoveReadings(toDto(created));
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
      toWorkItemsPatchInput(input),
      sessionUser.id,
    );
    if (!patched) throw new WorkItemNotFoundError(input.id);
    return await withMoveReadings(toDto(patched));
  } catch (e) {
    rethrowBackendError(e);
  }
}

export async function deleteWorkItem(id: string, sessionUser: { id: string }): Promise<boolean> {
  const container = getContainer();
  try {
    return await container.doltgresWorkItems.delete(toWorkItemId(id), sessionUser.id);
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

export async function getWorkItemCoordination(id: string): Promise<WorkItemCoordinationOutput> {
  const container = getContainer();
  try {
    const current = await container.doltgresWorkItems.get(toWorkItemId(id));
    if (!current) throw new WorkItemNotFoundError(id);
    return {
      nextAction: nextActionForWorkItem(current),
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
