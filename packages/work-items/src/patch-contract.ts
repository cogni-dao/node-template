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
 *   - REASON_REQUIRED: every patch carries a reason (one line, 1-240 chars, at most 25 words), stored in history, never in the item (task.0052, task.0086).
 *   - MOVES_SERVER_PINS_BASELINE (story.0033): `set.moves` is `[{ metricId, direction }]`, at most 3, or `[]`. Any other key on an entry (a read-only baseline, a reading) is dropped, never trusted; the store pins the baseline.
 *   - CITES_OPTIONAL: `cites` names at most 8 hub atoms the change used; the adapter pins each to a commit (task.0086).
 * Side-effects: none
 * @public
 */

import { z } from "zod";

import { CITE_CONTRIBUTION_PATTERN, CITE_ID_PATTERN, CITE_MAX } from "./cites.js";
import { ChangeReasonSchema } from "./history-contract.js";
import { MOVE_METRIC_ID_MAX, MOVES_MAX } from "./moves.js";

/**
 * Evaluation scores: configurable axis id -> { v, ev? }. Writes replace the whole object.
 * This transport outline retains unknown entry properties so the shared scores validator
 * rejects them. The adapter owns all bounds, safe HTTPS URL checks and Justification rules.
 */
export const WorkItemScoresInputSchema = z.record(
  z.string(),
  z.looseObject({ v: z.number(), ev: z.string().optional() }),
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

/** One cited hub atom: plain id = main; with `contribution` = the head of that open inbox. */
export const CiteRefSchema = z.strictObject({
  id: z
    .string()
    .regex(CITE_ID_PATTERN, `id must match ${CITE_ID_PATTERN.source}`)
    .describe("Hub atom id you read for this decision."),
  contribution: z
    .string()
    .regex(CITE_CONTRIBUTION_PATTERN, `contribution must match ${CITE_CONTRIBUTION_PATTERN.source}`)
    .optional()
    .describe("Open inbox id (contrib-...) when the atom exists only there."),
});

/**
 * One declared move. Plain `z.object` strips unknown keys on purpose: an agent that sends a
 * whole item back (with `baselineObservationId` or the read-time readings) must not fail,
 * and the server fills the baseline itself.
 */
export const MoveInputSchema = z.object({
  metricId: z
    .string()
    .min(1)
    .max(MOVE_METRIC_ID_MAX)
    .describe("Id of a registered metric (hub entry with a metric spec)."),
  direction: z
    .enum(["up", "down"])
    .nullable()
    .describe("The intended direction, or null for no directional claim. Null-direction storage writes remain disabled until compatible readers are deployed."),
});

/**
 * The `moves` list of a create or a patch: at most 3, ids unique, `[]` = moves nothing.
 * One schema for both writes (story.0033).
 */
export const WorkItemMovesInputSchema = z
  .array(MoveInputSchema)
  .max(MOVES_MAX)
  .superRefine((moves, ctx) => {
    const seen = new Set<string>();
    for (const [i, move] of moves.entries()) {
      if (seen.has(move.metricId))
        ctx.addIssue({
          code: "custom",
          path: [i, "metricId"],
          message: `metric id repeats: ${move.metricId}`,
        });
      seen.add(move.metricId);
    }
  })
  .describe(
    "Metrics this work moves: at most 3 of { metricId, direction: up|down|null }; [] means it moves none (say why in the reason on a patch). On a patch it replaces the whole list. The server resolves each new metric and pins its baseline; never send one.",
  );

export const WorkItemPatchInputSchema = z.object({
  id: z.string(),
  expectedRevision: z.number().int().min(0).optional(),
  // The adapter applies the same rule; this gives the 400 issue early.
  reason: ChangeReasonSchema,
  cites: z
    .array(CiteRefSchema)
    .max(CITE_MAX)
    .superRefine((cites, ctx) => {
      const seen = new Set<string>();
      for (const [i, cite] of cites.entries()) {
        if (seen.has(cite.id))
          ctx.addIssue({
            code: "custom",
            path: [i, "id"],
            message: `cite id repeats: ${cite.id}`,
          });
        seen.add(cite.id);
      }
    })
    .optional()
    .describe(
      "Hub atoms (at most 8, ids unique) that governed this decision. Each is pinned to its commit in history. Cite only atoms you read.",
    ),
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
      // [] = this item moves no metric (the edit reason says why). The server pins each baseline.
      moves: WorkItemMovesInputSchema.optional(),
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
