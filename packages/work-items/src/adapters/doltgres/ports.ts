// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/adapters/doltgres/ports`
 * Purpose: Port + input shapes for the Doltgres-backed `work_items` API surface every node serves.
 * Scope: Types only, derived from `WorkItemCommandPort`. Does not contain implementation, IO, or container wiring.
 * Invariants:
 *   - DEPEND_ON_THE_PORT, routes and facades import these types, never the concrete adapter.
 *   - NOT_CONFIGURED_IS_WIRED, the container substitutes a throwing impl when the node has no Doltgres URL.
 * Side-effects: none
 * Links: docs/spec/work-items-port.md, docs/guides/agent-api-validation.md
 * @public
 */

import type {
  Revision,
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkQuery,
} from "../../index.js";

export type WorkItemsCreateInput = Parameters<WorkItemCommandPort["create"]>[0];

export type WorkItemsPatchSet = NonNullable<
  Parameters<WorkItemCommandPort["patch"]>[0]["set"]
> & {
  readonly deployVerified?: boolean;
  readonly projectId?: string | null;
  readonly parentId?: string | null;
  readonly blockedBy?: string | null;
};

export interface WorkItemsPatchInput {
  readonly id: WorkItemId;
  readonly set: WorkItemsPatchSet;
}

/**
 * Input for the narrow `setPriorityRank` collaboration op (story.5096).
 *
 * - CAS_ON_REVISION: applied only if the row's current `revision` equals
 *   `expectedRevision`; otherwise `WorkItemRevisionConflictError` and no write.
 * - `expectedRevision` is the Doltgres row version (`WorkItem.revision`); a
 *   numeric string is accepted for `Revision` callers.
 * - `rank: null` clears the rank.
 */
export interface WorkItemsSetPriorityRankInput {
  readonly id: WorkItemId;
  readonly expectedRevision: Revision | number;
  readonly priority: number;
  readonly rank: number | null;
}

export interface WorkItemsDoltgresPort {
  get(id: WorkItemId): Promise<WorkItem | null>;
  list(query?: WorkQuery): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }>;
  create(input: WorkItemsCreateInput, principalId: string): Promise<WorkItem>;
  patch(input: WorkItemsPatchInput, principalId: string): Promise<WorkItem>;
  delete(id: WorkItemId, principalId: string): Promise<boolean>;
  /**
   * Compare-and-set priority + rank. COLLABORATOR_AUTHZ: any authenticated
   * principal may call it — unlike `patch`/`delete` it is NOT creator-bound; the
   * caller enforces node policy upstream. Writes exactly `priority`, `rank`,
   * `revision`, `updated_at` as one attributable Dolt commit.
   */
  setPriorityRank(
    input: WorkItemsSetPriorityRankInput,
    principalId: string
  ): Promise<WorkItem>;
  claim(input: {
    id: WorkItemId;
    runId: string;
    command: string;
    principalId: string;
  }): Promise<WorkItem>;
  heartbeat(input: {
    id: WorkItemId;
    runId: string;
    command?: string;
    principalId: string;
  }): Promise<WorkItem>;
  release(input: {
    id: WorkItemId;
    runId: string;
    principalId: string;
  }): Promise<WorkItem>;
}
