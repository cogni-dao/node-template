// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/content`
 * Purpose: Port + input shapes for the versioned `work_items` API surface every node serves.
 * Scope: Types only, derived from `WorkItemCommandPort`. Does not contain implementation, IO, or container wiring.
 * Invariants:
 *   - DEPEND_ON_THE_PORT, routes and facades import these types, never the concrete adapter.
 *   - NOT_CONFIGURED_IS_WIRED, the container substitutes a throwing impl when the node has no Doltgres URL.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/work-items-port.md, https://cognidao.org/knowledge/prove-node-agent-api
 * @public
 */

import type { WorkItemArtifactStore } from "./artifacts.js";
import type { CiteRef } from "./cites.js";
import type { WorkItemSummary } from "./contracts.js";
import type { HistoryEntry } from "./history.js";
import type { WorkItemLeasePort } from "./leases.js";
import type { WorkBoardColumnPages } from "./board.js";
import type { WorkSummaryReadOptions } from "./summary-query.js";

import type {
  WorkItem,
  WorkItemCommandPort,
  WorkItemId,
  WorkQuery,
} from "./index.js";

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
  readonly expectedRevision?: number;
  readonly id: WorkItemId;
  readonly set: WorkItemsPatchSet;
  /**
   * Why this change happens (task.0086): required. One line, 1-240 chars, at most 25 words;
   * stored in the Dolt commit message, never in the item. The Doltgres adapter enforces it.
   */
  readonly reason: string;
  /** Hub atoms this change used, at most 8; the adapter pins each to a commit in the commit message. */
  readonly cites?: readonly CiteRef[];
}

/**
 * Whether the store's writer admits new writes (bug.0042). `held`: an earlier
 * operation's native outcome is still unsettled, so writes return 503 until
 * settlement proves the writer free. Deep readiness reports it.
 */
export type WorkItemWriterHealth =
  | { readonly state: "available" }
  | {
      readonly state: "held";
      readonly nativeState: "pending" | "unknown";
      readonly since: string;
      readonly heldMs: number;
      readonly reason: string;
      readonly stage: string;
      readonly operationId: string;
      readonly operation: string;
      readonly settleAttempts: number;
      readonly settling: boolean;
    };

export interface WorkItemsPort {
  get(id: WorkItemId): Promise<WorkItem | null>;
  list(query?: WorkQuery): Promise<{
    items: WorkItem[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean };
  }>;
  /** One bounded summary page (≤ `WORK_SUMMARY_PAGE_MAX` rows); `options` only tightens its read bounds. */
  listSummaries(
    query?: WorkQuery,
    options?: WorkSummaryReadOptions,
  ): Promise<{
    items: WorkItemSummary[];
    nextCursor?: string;
    pageInfo: { endCursor: string | null; hasMore: boolean; rowsScanned?: number };
  }>;
  /**
   * Optional composed board read: first page of every listed status column in
   * one store read (no text). Cursors equal the per-column `listSummaries` ones.
   */
  listBoardColumns?(
    query: WorkQuery,
    statuses: readonly string[],
    perColumn: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkBoardColumnPages>;
  create(input: WorkItemsCreateInput, principalId: string): Promise<WorkItem>;
  patch(input: WorkItemsPatchInput, principalId: string): Promise<WorkItem>;
  delete(id: WorkItemId, principalId: string): Promise<boolean>;
  /** Versions of one item, newest first, with their change reasons (task.0052). */
  history?(id: WorkItemId): Promise<HistoryEntry[]>;
  /** In-memory writer state for deep readiness; makes no database call. */
  writerHealth?(): WorkItemWriterHealth;
  /** Insert-only review and validation artifacts (task.0028). Absent on a store that does not serve them. */
  readonly artifacts?: WorkItemArtifactStore;
  claim: WorkItemLeasePort["claim"];
  heartbeat: WorkItemLeasePort["heartbeat"];
  release: WorkItemLeasePort["release"];
}

export type WorkItemsContentPort = Omit<
  WorkItemsPort,
  "claim" | "heartbeat" | "release"
>;
