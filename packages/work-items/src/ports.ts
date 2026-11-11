// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/ports`
 * Purpose: WorkItemQueryPort and WorkItemCommandPort interfaces for work item management.
 * Scope: Pure interfaces only. Does not contain I/O or implementations.
 * Invariants: Command/query separation — reads via QueryPort, writes via CommandPort.
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md
 * @public
 */

import type {
  ExternalRef,
  RelationType,
  Revision,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation,
} from "./types.js";
import type { MoveInput } from "./moves.js";

// ── Query Port ────────────────────────────────────────

export interface WorkItemQueryPort {
  get(id: WorkItemId): Promise<WorkItem | null>;
  list(query?: WorkQuery): Promise<{ items: WorkItem[]; nextCursor?: string }>;
  listRelations(id: WorkItemId): Promise<WorkRelation[]>;
}

// ── Command Port ──────────────────────────────────────

export interface WorkItemCommandPort {
  create(input: {
    id?: WorkItemId;
    type: WorkItemType;
    title: string;
    summary?: string;
    outcome?: string;
    specRefs?: string[];
    projectId?: WorkItemId;
    parentId?: WorkItemId;
    labels?: string[];
    assignees?: SubjectRef[];
    node?: string;
    status?: WorkItemStatus;
    priority?: number;
    rank?: number;
    estimate?: number;
    /**
     * Doltgres-only (story.5111): validated by `parseWorkItemScores`; the
     * markdown adapter throws `UnsupportedWorkItemFieldError`.
     */
    scores?: WorkItemScores;
    /**
     * Doltgres-only (story.0033): the metrics the new item moves; the adapter resolves each id
     * and pins its baseline. `[]` declares none. The markdown adapter throws `UnsupportedWorkItemFieldError`.
     */
    moves?: readonly MoveInput[];
  }): Promise<WorkItem>;

  patch(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    set?: Partial<
      Pick<
        WorkItem,
        | "title"
        | "summary"
        | "outcome"
        | "estimate"
        | "priority"
        | "rank"
        | "status"
        | "specRefs"
        | "labels"
        | "branch"
        | "pr"
        | "reviewer"
        | "node"
      >
    > & {
      /**
       * Replaces the whole scores object; `null` clears it to SQL NULL.
       * Doltgres-only (story.5111): validated by `parseWorkItemScores`; the
       * markdown adapter throws `UnsupportedWorkItemFieldError`.
       */
      scores?: WorkItemScores | null;
      /**
       * Replaces the whole `moves` list (story.0033); `[]` declares none. The Doltgres
       * adapter resolves each metric id and pins the baseline; the markdown adapter
       * throws `UnsupportedWorkItemFieldError`.
       */
      moves?: readonly MoveInput[];
    };
  }): Promise<WorkItem>;

  transitionStatus(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    toStatus: WorkItemStatus;
    reason?: string;
    blockedBy?: WorkItemId;
  }): Promise<WorkItem>;

  setAssignees(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    assignees: SubjectRef[];
  }): Promise<WorkItem>;

  upsertRelation(rel: WorkRelation): Promise<void>;
  removeRelation(rel: {
    fromId: WorkItemId;
    toId: WorkItemId;
    type: RelationType;
  }): Promise<void>;

  upsertExternalRef(input: {
    id: WorkItemId;
    expectedRevision: Revision;
    ref: ExternalRef;
  }): Promise<WorkItem>;

  claim(input: {
    id: WorkItemId;
    runId: string;
    command: string;
  }): Promise<WorkItem>;

  release(input: { id: WorkItemId; runId: string }): Promise<WorkItem>;
}
