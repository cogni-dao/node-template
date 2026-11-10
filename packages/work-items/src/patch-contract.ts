// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/patch-contract`
 * Purpose: The one input schema for patching a work item. The HTTP route and the agent tool both use it (task.0065).
 * Scope: Schemas and types only. No I/O, no store access.
 * Invariants:
 *   - ONE_PATCH_SCHEMA: `PATCH /api/v1/work/items/{id}` and `core__work_item_update` share `WorkItemPatchInputSchema`; no second copy.
 *   - PATCH_ALLOWLIST: only fields in `set` are mutable. id/created_at/updated_at are server-managed.
 *   - Optional expectedRevision enables compare-and-set; omission preserves unconditional patches.
 *   - Optional reason is one line, 1-512 chars, stored in history, never in the item (task.0052).
 * Side-effects: none
 * @public
 */

import { z } from "zod";

import { ChangeReasonSchema } from "./history-contract.js";

/**
 * Evaluation scores: configurable axis id -> { v, ev? }. Writes replace the whole object.
 * This transport outline retains unknown entry properties so the shared scores validator
 * rejects them. The adapter owns all bounds, safe HTTPS URL checks and Justification rules.
 */
export const WorkItemScoresInputSchema = z.record(
  z.string(),
  z.looseObject({ v: z.number(), ev: z.string().optional() })
);

export const WorkItemPatchStatusSchema = z.enum([
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "done",
  "blocked",
  "cancelled",
]);

export const WorkItemPatchInputSchema = z.object({
  id: z.string(),
  expectedRevision: z.number().int().min(0).optional(),
  // The adapter turns CR/LF into spaces and trims; this checks the result fits.
  reason: ChangeReasonSchema.optional(),
  set: z
    .strictObject({
      title: z.string().min(1).max(500).optional(),
      summary: z.string().optional(),
      outcome: z.string().optional(),
      status: WorkItemPatchStatusSchema.optional(),
      priority: z.number().int().min(0).max(99).optional(),
      rank: z.number().int().optional(),
      estimate: z.number().int().optional(),
      // null clears the column back to SQL NULL (scores read as absent).
      scores: WorkItemScoresInputSchema.nullable().optional(),
      labels: z.array(z.string()).optional(),
      specRefs: z.array(z.string()).optional(),
      branch: z.string().optional(),
      pr: z.string().optional(),
      reviewer: z.string().optional(),
      node: z.string().optional(),
      deployVerified: z.boolean().optional(),
      projectId: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      blockedBy: z.string().nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
      message: "set must contain at least one field",
    }),
});

export type WorkItemPatchInput = z.infer<typeof WorkItemPatchInputSchema>;
