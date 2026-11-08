// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/history-contract`
 * Purpose: Zod wire schemas for change reasons and one work item's row history (task.0052, story.0023).
 * Scope: Schemas and types only. No I/O, no store access.
 * Invariants:
 *   - ONE_HISTORY_SHAPE: `@cogni-dao/knowledge-store/contracts` declares the same item shape.
 *   - REASON_ONE_LINE: `ChangeReasonSchema` applies the `normalizeChangeReason` rule (line breaks become spaces, then 1-512 chars).
 *   - NOTE_NOT_BODY: the reason comes from Dolt history, never from the row.
 *   - BOUNDED_READ: newest first, at most 50 versions; values over 4 KB are truncated and flagged.
 * Side-effects: none
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { z } from "zod";

import { CHANGE_REASON_MAX_CHARS } from "./history.js";

/** One-line change reason. The adapter turns CR/LF into spaces and trims; this checks the result fits. */
export const ChangeReasonSchema = z.string().refine(
  (v) => {
    const n = v.replace(/[\r\n]+/g, " ").trim().length;
    return n >= 1 && n <= CHANGE_REASON_MAX_CHARS;
  },
  { message: "reason must be 1-512 characters on one line" }
);

export const HistoryEntrySchema = z.object({
  version: z.string(),
  commit: z.string(),
  at: z.string(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  changed: z.array(z.string()),
  diff: z.record(
    z.string(),
    z.object({
      before: z.unknown(),
      after: z.unknown(),
      truncated: z.boolean(),
    })
  ),
});

export const HistoryOutputSchema = z.object({
  items: z.array(HistoryEntrySchema),
});

export const workItemsHistoryOperation = {
  id: "work.items.history.v1",
  summary: "Read a work item's history",
  description:
    "Returns the item's versions, newest first, each with its change reason, actor and changed fields. The reason is the PATCH `reason`, stored in Dolt history.",
  input: z.object({ id: z.string() }),
  output: HistoryOutputSchema,
} as const;

export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;
