// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

export {
  acquireDoltWriterLocks,
  assertDoltWriterLock,
  doltWriterLockKey,
  DoltWriterAdmissionError,
} from "./locks.js";
export type {
  DoltWriterConnection,
  DoltWriterLock,
  DoltWriterProtocol,
} from "./locks.js";
export {
  runDoltBranchMutation,
  reconcileAbandonedDoltOperation,
  DoltBranchMutationUncertainError,
} from "./branch-mutation.js";
export type {
  DoltBranchMutationOptions,
  DoltBranchMutationResult,
  DoltAbandonedOperationProof,
} from "./branch-mutation.js";
