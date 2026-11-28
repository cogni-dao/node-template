// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { z } from "zod";
import { EpochSchema } from "./attribution.list-epochs.v1.contract";
import { IngestionReceiptSchema } from "./attribution.epoch-activity.v1.contract";
import { EPOCH_PAGE_MAX_LIMIT } from "../read/epoch-views";
export const ContributorSummarySchema = z.object({
  claimantKey: z.string(),
  claimantKind: z.enum(["user", "identity"]),
  isLinked: z.boolean(),
  displayName: z.string().nullable(),
  claimantLabel: z.string(),
  units: z.string(),
  receiptCount: z.number().int().nonnegative(),
  creditShare: z.number(),
});
export const EpochContributorSummaryPageSchema = z.object({
  epochId: z.string(),
  items: z.array(ContributorSummarySchema).max(EPOCH_PAGE_MAX_LIMIT),
  total: z.number().int().nonnegative(),
  totalUnits: z.string(),
  totalPoints: z.string(),
  totalReceiptCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  unresolvedActivityTotal: z.number().int().nonnegative(),
  unresolvedActivities: z
    .array(
      z.object({
        claimantKey: z.string(),
        source: z.string(),
        platformLogin: z.string().nullable(),
        eventCount: z.number().int().nonnegative(),
      })
    )
    .max(EPOCH_PAGE_MAX_LIMIT),
  limit: z.number().int().min(1).max(EPOCH_PAGE_MAX_LIMIT),
  offset: z.number().int().nonnegative(),
});
export const EpochOverviewSchema = z.object({
  current: EpochSchema.nullable(),
  epochs: z.array(EpochSchema).max(EPOCH_PAGE_MAX_LIMIT),
  total: z.number().int().nonnegative(),
});
export const ContributorActivityOutputSchema = z.object({
  epochId: z.string(),
  total: z.number().int().nonnegative(),
  events: z
    .array(
      IngestionReceiptSchema.extend({
        reviewOverride: z
          .object({
            originalUnits: z.string(),
            overrideUnits: z.string(),
            reason: z.string().nullable(),
          })
          .nullable()
          .optional(),
      })
    )
    .max(EPOCH_PAGE_MAX_LIMIT),
});
