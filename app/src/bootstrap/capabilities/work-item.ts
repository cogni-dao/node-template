// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item`
 * Purpose: Factory for WorkItemCapability — bridges ai-tools interface to WorkItemQueryPort + WorkItemCommandPort.
 * Scope: Creates WorkItemCapability that delegates to hexagonal ports. Does not implement transport.
 * Invariants:
 *   - PORTS_ARE_AUTHORITY: All operations delegate to WorkItemQueryPort/WorkItemCommandPort
 *   - STATUS_GATES_ARE_THE_STORE'S (task.0122): a status write is `patch`; the Doltgres store runs the one gate predicate, so this capability has no separate transition (`core__work_item_transition` is removed)
 *   - PATCH_ON_THE_LIVE_BACKLOG (story.5096, mirrors cogni): when `backlogWriter` is wired, `patch`
 *     goes through the Doltgres `patch` attributed to `backlogWriter.attribution()`; the store's own
 *     authority applies unchanged. The callback builds the run's attribution (acting principal, requester, run) at invocation
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
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/development-lifecycle.md
 * @internal
 */

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
  type WorkItemQueryParams,
} from "@cogni/ai-tools";
import { isPrivilegedPriority } from "@cogni/knowledge-store";
import type {
  ActorKind,
  WorkItemCommandPort,
  WorkItemQueryPort,
  WorkItemStatus,
  WorkItemType,
  WriteAttribution,
} from "@cogni/work-items";
import type {
  EnvelopeDegradedEvent,
  ItemEnvelopeParts,
  ItemLinksPort,
  MoveReadingPort,
  WorkItemHistoryStore,
} from "@cogni/work-items";
import {
  type ArtifactLog,
  type WorkItemArtifactDeps,
  artifactsNotConfigured,
  recordWorkItemArtifact,
} from "@cogni/work-items";
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

import { createItemRefPorts } from "./work-item-refs";

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
   * writes there with the run's `attribution` (with caller compare-and-set) instead of the markdown ports.
   */
  /** Reads the metrics a single item moves; absent means no metrics service (every move reads `unknown`). */
  readonly moveReadings?: MoveReadingPort | undefined;
  /** First page of an item's citation links (`read` with `includeLinks`); absent reads `unavailable`. */
  readonly links?: ItemLinksPort | undefined;
  /** One event per degraded envelope part (chain or links). */
  readonly log?: ((event: EnvelopeDegradedEvent) => void) | undefined;
  /**
   * ARTIFACTS_ARE_THE_ROUTES (task.0122): `recordArtifact` is the `POST /api/v1/work/items/{id}/artifacts` handler, called with the
   * run's attribution (resolved at invocation, never at construction). `deps` is read at call time because the artifact store is
   * built after this capability; undefined means this node serves no artifacts (a 503, nothing written).
   */
  readonly artifacts?: {
    readonly deps: () => WorkItemArtifactDeps | undefined;
    readonly attribution: () => WriteAttribution;
    /** The one terminal record of the call, the same one the route logs (no body, no row, no url), with the attribution when one was built (task.0133). */
    readonly log?: (log: ArtifactLog, attribution?: WriteAttribution) => void;
  };
  /** The item's history pages for `read` with `includeHistory` (story.0058); read at call time, like `artifacts`. */
  readonly history?: () => Pick<WorkItemHistoryStore, "historyPage"> | undefined;
  readonly backlogWriter?: {
    readonly store: Pick<WorkItemsDoltgresPort, "patch">;
    /** Host-built at invocation: the run's acting principal, its requester and the run (task.0133). */
    readonly attribution: () => WriteAttribution;
    /** One terminal refusal when the attribution could not be built (a run with no acting principal): nothing was written. */
    readonly attributionDenied?: (event: { workItemId: string; error: unknown }) => void;
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
    async read(id, options): Promise<(WorkItemInfo & ItemEnvelopeParts) | null> {
      const result = await list({ ids: [id], limit: 1 });
      const item = result.items.map(toWorkItemInfo).find((entry) => entry.id === id);
      if (!item) return null;
      // ONE_COMPOSITION: the same `composeItemEnvelope` and the same ports the HTTP facade wires.
      const store = deps.artifacts?.deps()?.artifacts;
      return composeItemEnvelope(
        item,
        {
          readings: deps.moveReadings,
          links: deps.links,
          artifacts: store ? { latest: (itemId) => store.latest(itemId) } : undefined,
          ...createItemRefPorts({ artifacts: store, history: deps.history?.() }),
          log: deps.log,
        },
        {
          includeLinks: options?.includeLinks === true,
          includeArtifacts: options?.includeArtifacts === true,
          includeHistory: options?.includeHistory === true,
          ...(options?.artifactId !== undefined ? { artifactId: options.artifactId } : {}),
        },
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

    ...(deps.artifacts && {
      async recordArtifact(input: { id: string; body: unknown }) {
        const artifacts = deps.artifacts as NonNullable<typeof deps.artifacts>;
        const stores = artifacts.deps();
        let attribution: WriteAttribution;
        try {
          attribution = artifacts.attribution();
        } catch (error) {
          // Fail closed, and say so in the same terminal event a refusal always uses.
          artifacts.log?.({
            event: "work.items.artifact_refused",
            status: 403,
            outcome: "refused",
            workItemId: input.id,
            errorCode: "attribution_denied",
            errorName: error instanceof Error ? error.name : "unknown",
          });
          throw error;
        }
        const result = stores
          ? await recordWorkItemArtifact(stores, input.id, attribution, input.body)
          : artifactsNotConfigured(input.id, "write");
        artifacts.log?.(result.log, attribution);
        return { status: result.status, body: result.body };
      },
    }),

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
        let attribution: WriteAttribution;
        try {
          attribution = writer.attribution();
        } catch (error) {
          // Fail closed, and say so in the same terminal event a refused patch always uses.
          writer.attributionDenied?.({ workItemId: input.id, error });
          throw error;
        }
        try {
          const updated = await writer.store.patch(
            toWorkItemsPatchInput({
              id: input.id,
              expectedRevision: input.expectedRevision,
              reason: input.reason,
              cites: input.cites,
              set: input.set,
            }),
            attribution,
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
