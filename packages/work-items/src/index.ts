// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items`
 * Purpose: Work item port interfaces, domain types, and status transition table.
 * Scope: Public barrel export. Does not contain I/O or adapter code.
 * Invariants: Domain types and injected-port composition; no runtime configuration.
 * Side-effects: none
 * Links: docs/spec/development-lifecycle.md, docs/spec/identity-model.md
 * @public
 */

export type { WorkItemCommandPort, WorkItemQueryPort } from "./ports.js";
export { isValidTransition, VALID_TRANSITIONS } from "./transitions.js";
export type {
  ActorKind,
  ExternalRef,
  RelationType,
  Revision,
  SubjectRef,
  WorkItem,
  WorkItemId,
  WorkItemScore,
  WorkItemScores,
  WorkItemStatus,
  WorkItemType,
  WorkQuery,
  WorkRelation,
} from "./types.js";
export { toWorkItemId } from "./types.js";

export type {
  WorkItemLease,
  WorkItemLeaseOwner,
  WorkItemLeasePort,
} from "./leases.js";

export type { WorkItemsContentPort, WorkItemsPort } from "./content.js";
export { withWorkItemLeases } from "./with-leases.js";

export { WorkItemWriteOutcomeUnknownError } from "./errors.js";
export { WorkItemsCapacityError } from "./errors.js";
