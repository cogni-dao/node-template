// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/attribution/contracts/attribution.settlement-lifecycle.v1.contract`
 * Purpose: Defines the authenticated read contract for global settlement progress by epoch.
 * Scope: Zod schemas and wire types only. Does not read settlement state or chain evidence.
 * Invariants: ALL_MATH_BIGINT, REVISION_SEQUENCE_COVERAGE, UNKNOWN_PUBLICATION_FAILS_CLOSED.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/settlement-lifecycle.ts
 * @public
 */

import { z } from "zod";
import { EpochSchema } from "./attribution.list-epochs.v1.contract";

export const SettlementRevisionSummarySchema = z.object({
  sequence: z.string().regex(/^\d+$/),
  merkleRoot: z.string(),
  cumulativeTotal: z.string().regex(/^\d+$/),
});

export const EpochSettlementLifecycleSchema = z.object({
  epochId: z.string().regex(/^\d+$/),
  liabilityCount: z.number().int().nonnegative(),
  settledLiabilityCount: z.number().int().nonnegative(),
  publishedLiabilityCount: z.number().int().nonnegative().nullable(),
});

export const SettlementLifecycleOutputSchema = z.object({
  finishSelection: z
    .object({
      kind: z.enum(["open_review", "finalize", "publish"]),
      epoch: EpochSchema,
      lifecycle: EpochSettlementLifecycleSchema.nullable(),
    })
    .nullable()
    .optional(),
  publicationEvidence: z.enum(["matched", "not_published", "unknown"]),
  liveRevision: SettlementRevisionSummarySchema.nullable(),
  latestRevision: SettlementRevisionSummarySchema.nullable(),
  epochs: z.array(EpochSettlementLifecycleSchema),
});

export const settlementLifecycleOperation = {
  id: "ledger.settlement-lifecycle.v1",
  summary: "Read settlement lifecycle progress",
  description:
    "Returns authenticated per-epoch liability, settlement, and chain-proven publication coverage for the current node.",
  input: z.object({}),
  output: SettlementLifecycleOutputSchema,
} as const;

export type SettlementRevisionSummaryDto = z.infer<
  typeof SettlementRevisionSummarySchema
>;
export type EpochSettlementLifecycleDto = z.infer<
  typeof EpochSettlementLifecycleSchema
>;
export type SettlementLifecycleOutput = z.infer<
  typeof SettlementLifecycleOutputSchema
>;
