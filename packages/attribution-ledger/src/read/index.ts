// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/attribution/read`
 * Purpose: Barrel for the epoch read views and their wire mappers.
 * Scope: Re-exports only.
 * Invariants: PURE_READ_VIEWS (see epoch-views.ts).
 * Side-effects: none
 * Links: src/read/epoch-views.ts, src/read/dto.ts
 * @public
 */

export {
  toEpochDto,
  toIngestionReceiptDto,
  toPoolComponentDto,
  toSelectionDto,
  toStatementDto,
  toUserProjectionDto,
} from "./dto";
export {
  buildEpochActivityView,
  type EpochActivityEvent,
  type EpochActivityResult,
  type EpochActivityView,
  type EpochPage,
  type EpochReadStore,
  listEpochsView,
  type PendingSelectionUpdate,
  persistSelectionUpdates,
  type SelectionUserIdWriter,
} from "./epoch-views";
