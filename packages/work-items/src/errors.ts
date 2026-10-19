// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export class WorkItemLeaseConflictError extends Error {
  constructor(public readonly id: string) {
    super(`Work item is claimed by another principal or lease: ${id}`);
    this.name = "WorkItemLeaseConflictError";
  }
}

export class WorkItemsBusyError extends Error {
  constructor(message = "Work-item store is busy; retry shortly") {
    super(message);
    this.name = "WorkItemsBusyError";
  }
}

/** Durable identities are never reused; cancel the versioned row instead. */
export class WorkItemDeletionRetiredError extends Error {
  constructor() {
    super(
      "Work-item hard deletion is retired; PATCH status=cancelled to preserve identity and provenance"
    );
    this.name = "WorkItemDeletionRetiredError";
  }
}
