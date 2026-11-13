// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item`
 * Purpose: Factory for WorkItemCapability — bridges ai-tools interface to WorkItemQueryPort + WorkItemCommandPort.
 * Scope: Creates WorkItemCapability that delegates to hexagonal ports. Does not implement transport.
 * Invariants:
 *   - PORTS_ARE_AUTHORITY: All operations delegate to WorkItemQueryPort/WorkItemCommandPort
 *   - TRANSITION_TABLE_ENFORCED: CommandPort validates transitions
 *   - PATCH_ON_THE_LIVE_BACKLOG (story.5096, mirrors cogni): when `backlogWriter` is wired, `patch`
 *     goes through the Doltgres `patch` attributed to `backlogWriter.principalId`; the store's own
 *     authority applies unchanged. A principal callback resolves the authenticated run actor at invocation
 *     time, never at singleton construction. Without it, `patch` stays on the markdown ports.
 *   - PATCH_REASON_AND_CITES (task.0086): the required `reason` and the optional `cites` are forwarded to the Doltgres store, the one enforcer;
 *     the markdown fallback (development only) has no history and ignores both, though the tool schema still requires a reason.
 *   - PATCH_CAS_PASSTHROUGH: a caller `expectedRevision` is forwarded as the Doltgres store's
 *     compare-and-set (absent => that store's unconditioned patch); its `WorkItemRevisionConflictError`
 *     becomes the ai-tools `WorkItemPatchConflictError`, nothing written. The markdown ports CAS on the
 *     revision they re-read (`current.revision`, a content hash, not the integer the tool exposes),
 *     so a caller `expectedRevision` there is refused, never silently dropped.
 *   - MOVES_READ_AT_READ_TIME (story.0033): a read that returns exactly one item (core__work_item_read) adds each move's baseline,
 *     current reading and verdict from `moveReadings`; a list read returns the stored moves only, so a page costs no metric lookup.
 *   - ONE_ITEM_ENVELOPE (task.0118): `read` is the single-item envelope: it also adds each move's metric, KPI and goal (`moveReadings.context`) and, on request, the first page of citation links (`links`); both through the package's `composeItemEnvelope`; `query` and `queryPage` never do.
 * Side-effects: none (factory only)
 * Links: docs/spec/development-lifecycle.md
 * @internal
 */

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
  type WorkItemQueryParams,
  type WorkItemTransitionResult,
} from "@cogni/ai-tools";
import { isPrivilegedPriority } from "@cogni/knowledge-store";
import type {
  ActorKind,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
} from "@cogni/work-items";
import type { EnvelopeDegradedEvent, ItemLinksPort, MoveReadingPort } from "@cogni/work-items";
import {
  composeItemEnvelope,
  judgeMoveSummaries,
  toWorkItemDto,
  toWorkItemId,
  toWorkItemsPatchInput,
} from "@cogni/work-items";
import {
  WorkItemRevisionConflictError,
  type WorkItemsDoltgresPort,
} from "@cogni/work-items/adapters/doltgres";

/**
 * Dependencies for creating the work item capability.
 */
export interface WorkItemCapabilityDeps {
  readonly workItemQuery: WorkItemQueryPort;
  readonly workItemCommand: WorkItemCommandPort;
  /**
   * QUERY_READS_THE_LIVE_BACKLOG: `query` lists through this when wired — the
   * node's Doltgres work items (the same read `GET /api/v1/work/items` uses).
   * The runtime image carries no `work/` tree, so a markdown-bound query always
   * saw an empty backlog. Writes are unchanged.
   */
  readonly backlogReader?: Pick<WorkItemQueryPort, "list">;
  /**
   * PATCH_ON_THE_LIVE_BACKLOG: the node's Doltgres work-item store. When set, `patch`
   * writes there as `principalId` (with caller compare-and-set) instead of the markdown ports.
   */
  /** Reads the metrics a single item moves; absent means no metrics service (every move reads `unknown`). */
  readonly moveReadings?: MoveReadingPort | undefined;
  /** First page of an item's citation links (`read` with `includeLinks`); absent reads `unavailable`. */
  readonly links?: ItemLinksPort | undefined;
  /** One event per degraded envelope part (chain or links). */
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    readonly principalId: string | (() => string);
  };
}

const toWorkItemInfo = toWorkItemDto;

/** The patch `set` without explicit-undefined keys (the route facade drops them the same way). */
const definedOnly = (set: object): object =>
  Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));

/**
 * Create a WorkItemCapability backed by hexagonal ports.
 */
export function createWorkItemCapability(
  deps: WorkItemCapabilityDeps,
): WorkItemCapability {
  const { workItemQuery, workItemCommand } = deps;

  function list(params: WorkItemQueryParams) {
    return (deps.backlogReader ?? workItemQuery).list({
      ...(params.sortBy !== undefined && { sortBy: params.sortBy }),
      ...(params.sortDirection !== undefined && {
        sortDirection: params.sortDirection,
      }),
      ...(params.statuses && {
        statuses: params.statuses as readonly WorkItemStatus[],
      }),
      ...(params.types && {
        types: params.types as readonly WorkItemType[],
      }),
      ...(params.text && { text: params.text }),
      ...(params.actor && { actor: params.actor as ActorKind }),
      ...(params.rankMin !== undefined && { rankMin: params.rankMin }),
      ...(params.rankMax !== undefined && { rankMax: params.rankMax }),
      ...(params.projectIds && {
        projectIds: params.projectIds.map(toWorkItemId),
      }),
      ...(params.projectId && {
        projectId: toWorkItemId(params.projectId),
      }),
      ...(params.labels && { labels: params.labels }),
      ...(params.labelPrefix !== undefined && {
        labelPrefix: params.labelPrefix,
      }),
      ...(params.scored !== undefined && { scored: params.scored }),
      ...(params.ids && { ids: params.ids.map((id) => toWorkItemId(id)) }),
      ...(params.cursor && { cursor: params.cursor }),
      ...(params.limit && { limit: params.limit }),
    });
  }

  /** A one-item read gets each move judged from its observations (bounded: at most 3 moves). */
  async function withMoveReadings(
    items: readonly WorkItemInfo[],
  ): Promise<readonly WorkItemInfo[]> {
    const only = items.length === 1 ? items[0] : undefined;
    if (!only?.moves?.length) return items;
    return judgeMoveSummaries([only], deps.moveReadings);
  }

  return {
    /**
     * THE single-item envelope (task.0118), the same shape `GET /api/v1/work/items/{id}` serves: the
     * item with each move's readings, verdict and metric → KPI → goal chain, and with `includeLinks`
     * the first page of citation links.
     */
    async read(id, options): Promise<WorkItemInfo | null> {
      const result = await list({ ids: [id], limit: 1 });
      const item = result.items.map(toWorkItemInfo).find((entry) => entry.id === id);
      if (!item) return null;
      // ONE_COMPOSITION: the same `composeItemEnvelope` the HTTP facade calls.
      return composeItemEnvelope(
        item,
        { readings: deps.moveReadings, links: deps.links, log: deps.log },
        { includeLinks: options?.includeLinks === true },
      );
    },

    async query(params): Promise<readonly WorkItemInfo[]> {
      const result = await list(params);
      return withMoveReadings(result.items.map(toWorkItemInfo));
    },

    /** Paginated read: a complete backlog snapshot follows `nextCursor` to the end. */
    async queryPage(params) {
      const result = await list(params);
      return {
        items: result.items.map(toWorkItemInfo),
        ...(result.nextCursor !== undefined && {
          nextCursor: result.nextCursor,
        }),
      };
    },

    async transitionStatus(input): Promise<WorkItemTransitionResult> {
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.transitionStatus({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        toStatus: input.toStatus as WorkItemStatus,
        ...(input.reason && { reason: input.reason }),
      });

      return {
        id: updated.id,
        previousStatus: current.status,
        newStatus: updated.status,
        revision: updated.revision as number,
      };
    },

    async patch(input): Promise<WorkItemInfo> {
      // P0P1_IS_NODE_ADMIN (story.5101): node admin is a wallet-bearing human
      // session (the container's `nodeAdmin`); a tool invocation carries no
      // wallet, so an AI patch to priority <= 1 is refused before any write.
      const priority = input.set.priority;
      if (priority != null && isPrivilegedPriority(priority)) {
        throw new Error(
          `authz_denied: priority ${priority} requires node admin — propose it instead`,
        );
      }
      const writer = deps.backlogWriter;
      if (writer) {
        try {
          const updated = await writer.store.patch(
            toWorkItemsPatchInput({
              id: input.id,
              expectedRevision: input.expectedRevision,
              reason: input.reason,
              cites: input.cites,
              set: input.set,
            }),
            typeof writer.principalId === "function"
              ? writer.principalId()
              : writer.principalId,
          );
          return toWorkItemInfo(updated);
        } catch (e) {
          if (e instanceof WorkItemRevisionConflictError) {
            throw new WorkItemPatchConflictError(
              e.id,
              e.expectedRevision,
              e.currentRevision,
            );
          }
          throw e;
        }
      }

      if (input.expectedRevision !== undefined) {
        throw new Error(
          "expectedRevision requires the Doltgres backlog writer (not wired)",
        );
      }
      const current = await workItemQuery.get(toWorkItemId(input.id));
      if (!current) {
        throw new Error(`Work item not found: ${input.id}`);
      }

      const updated = await workItemCommand.patch({
        id: toWorkItemId(input.id),
        expectedRevision: String(current.revision),
        set: definedOnly(input.set) as NonNullable<
          Parameters<typeof workItemCommand.patch>[0]["set"]
        >,
      });

      return toWorkItemInfo(updated);
    },
  };
}
