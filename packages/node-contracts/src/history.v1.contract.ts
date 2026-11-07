// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/history.v1.contract`
 * Purpose: Read the versions of one work item or knowledge entry, each with its change reason (task.0052).
 * Scope: Zod schemas and types for both history routes. Does not contain business logic.
 * Invariants:
 *   - ONE_HISTORY_SHAPE: work items and knowledge return the same item schema.
 *   - NOTE_NOT_BODY: the reason comes from Dolt history, never from the row.
 *   - BOUNDED_READ: newest first, at most 50 versions; values over 4 KB are truncated and flagged.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

import { z } from "zod";

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

export const knowledgeHistoryOperation = {
  id: "knowledge.history.v1",
  summary: "Read a knowledge entry's history",
  description:
    "Returns the entry's versions, newest first, each with its change reason (the contribution commit message), actor and changed fields.",
  input: z.object({ id: z.string() }),
  output: HistoryOutputSchema,
} as const;

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;
