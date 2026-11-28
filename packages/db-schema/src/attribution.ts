// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Bind the public attribution schema to this node's identity table. Migrations remain node-owned.
import { createAttributionSchema } from "@cogni/attribution-ledger/schema";
import { users } from "./refs";
export const {
  epochs,
  ingestionReceipts,
  epochSelection,
  epochUserProjections,
  ingestionCursors,
  epochPoolComponents,
  epochReceiptClaimants,
  epochEvaluations,
  epochReviewSubjectOverrides,
  epochFinalClaimantAllocations,
  epochStatements,
  epochStatementSignatures,
  epochDistributionManifests,
  epochDistributionLeaves,
  distributionSettlementRevisions,
  claimantLiabilities,
  distributionSettlementLeaves,
} = createAttributionSchema({ users });
