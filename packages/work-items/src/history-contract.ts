// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/history-contract`
 * Purpose: Zod wire schemas for change reasons and one work item's row history (task.0052, story.0023).
 * Scope: Schemas and types only. No I/O, no store access.
 * Invariants:
 *   - ONE_HISTORY_SHAPE: `@cogni-dao/knowledge-store/contracts` declares the same item shape.
 *   - REASON_REQUIRED: `ChangeReasonSchema` applies the `checkChangeReason` rule the adapter applies (line breaks become spaces, then 1-240 chars, at most 25 words, no NUL); a missing reason says what to send.
 *   - NOTE_NOT_BODY: the reason comes from Dolt history, never from the row.
 *   - BOUNDED_READ: newest first, at most 50 versions; values over 4 KB are truncated and flagged.
 * Side-effects: none
 * Links: hub change-history-design, change-history-fleet-adoption
 * @public
 */

import { z } from "zod";

import { WRITE_RUN_KINDS } from "./attribution.js";
import { CHANGE_REASON_REQUIRED_MESSAGE, checkChangeReason } from "./history.js";

/**
 * The change reason every work-item patch carries (task.0086). The adapter turns
 * line breaks into spaces and trims; this checks the result fits the same caps
 * and says what to send when the reason is missing.
 */
export const ChangeReasonSchema = z
  .string({
    error: (issue) =>
      issue.input === undefined ? CHANGE_REASON_REQUIRED_MESSAGE : undefined,
  })
  .superRefine((value, ctx) => {
    const checked = checkChangeReason(value);
    if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.message });
  })
  .describe(
    "Why this change happens: one line, at most 25 words and 240 characters. It is stored in the item's history, never in the item."
  );

export const HistoryEntrySchema = z.object({
  version: z.string(),
  commit: z.string(),
  at: z.string(),
  actor: z.string().nullable(),
  /** The node run's subject (`Requested-by:`); absent for a write no run made. */
  requestedBy: z.string().optional(),
  /** The run that wrote it (`Run:`); absent for a direct write. */
  run: z.object({ id: z.string(), kind: z.enum(WRITE_RUN_KINDS) }).optional(),
  reason: z.string().nullable(),
  cites: z.array(
    z.object({
      id: z.string(),
      commit: z.string(),
      contribution: z.string().optional(),
    })
  ),
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

/** Refs per page of the history refs view (`?view=refs`) and of the item read's `historyRefs`. */
export const HISTORY_REFS_PAGE = 20;

/** A history ref: one version without `diff`. It is complete as listed (hub change-history-design). */
export const HistoryRefSchema = HistoryEntrySchema.omit({ diff: true });
export type HistoryRef = z.infer<typeof HistoryRefSchema>;

/** One page of history refs, newest first. `nextCursor` is a commit: send it back as `cursor` for older versions. */
export const HistoryRefsPageSchema = z.object({
  refs: z.array(HistoryRefSchema).max(HISTORY_REFS_PAGE),
  nextCursor: z.string().nullable(),
  unavailable: z.literal(true).optional(),
});
export type HistoryRefsPage = z.infer<typeof HistoryRefsPageSchema>;

export const workItemsHistoryOperation = {
  id: "work.items.history.v1",
  summary: "Read a work item's history",
  description:
    "Returns the item's versions, newest first, each with its change reason, the atoms it cited (pinned to commits), actor, the requester and run when a node run wrote it, and changed fields. The reason and cites are the PATCH `reason` and `cites`, stored in Dolt history. With `view=refs`: one page of 20 versions without `diff` and `nextCursor`; send it back as `cursor` for older versions.",
  input: z.object({ id: z.string(), view: z.literal("refs").optional(), cursor: z.string().optional() }),
  output: z.union([HistoryOutputSchema, HistoryRefsPageSchema]),
} as const;

export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;
