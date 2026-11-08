// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-reconcile`
 * Purpose: Steward-only host tool that rewrites the `summary` and `outcome` of one open work item.
 * Scope: One compare-and-set patch through WorkItemCapability. The brief steward's guard decides whether to
 *   call it; this tool re-checks only what must hold whatever the caller. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_reconcile`
 *   - EFFECT_TYPED: effect is `state_change`
 *   - STEWARD_ONLY: only the `brief-steward` catalog entry lists it; `core__work_item_transition` is unchanged and
 *     still cannot write `outcome`
 *   - TWO_FIELDS_ONLY: it writes `summary` and `outcome` and nothing else
 *   - APPROVED_LINES_BYTE_IDENTICAL: it refuses unless the `Goal =` and `Done when =` lines of the item as it is
 *     stored now equal those of the proposal in text, count and order, even after a guard passed. The parser is
 *     `APPROVED_LINE` from `@cogni-dao/metrics/briefs`, the one the scorer and the guard use
 *   - CAS_ALWAYS: `expectedRevision` is required; a moved row is a result, never a write
 *   - GUARD_STATES_WHY: `reason` must have the form `reconcile brief: <rule codes>`
 *   - STORE_AUTHORITY: the node's capability and store authorize the write; this tool adds no authority
 * Side-effects: IO (mutates one work item via capability)
 * Links: hub brief-steward-design
 * @public
 */

import { APPROVED_LINE } from "@cogni-dao/metrics/briefs";
import { z } from "zod";
import {
  type WorkItemCapability,
  WorkItemPatchConflictError,
} from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_RECONCILE_NAME = "core__work_item_reconcile" as const;
/** Largest `summary` or `outcome` the tool accepts; the scorer's `unbounded_text` limit. */
export const RECONCILE_FIELD_MAX_CHARS = 100_000;
/** The only reason shape the tool stores: `reconcile brief: long_sentences, log_block`. */
export const RECONCILE_REASON = /^reconcile brief: \w+(, \w+)*$/;
const CLOSED = new Set(["done", "cancelled"]);

/** The `Goal =` and `Done when =` lines of an outcome, in order, byte for byte. */
export function approvedLinesOf(outcome: string): string[] {
  return outcome
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => APPROVED_LINE.test(line));
}

export const WorkItemReconcileInputSchema = z.object({
  id: z.string().min(1).max(200).describe("Work item id, e.g. 'task.0054'"),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .describe("The item's revision you read; a moved row writes nothing"),
  summary: z.string().max(RECONCILE_FIELD_MAX_CHARS),
  outcome: z.string().max(RECONCILE_FIELD_MAX_CHARS),
  reason: z
    .string()
    .max(512)
    .regex(RECONCILE_REASON)
    .describe("Built by the steward guard from the removed rule codes"),
});
export type WorkItemReconcileInput = z.infer<
  typeof WorkItemReconcileInputSchema
>;

export const WorkItemReconcileOutputSchema = z.object({
  success: z.boolean(),
  action: z.literal("reconcile"),
  id: z.string(),
  message: z.string(),
  revision: z.number().int().optional(),
  /** Set when success=false and nothing was written. */
  code: z
    .enum([
      "revision_conflict",
      "approved_lines_changed",
      "item_closed",
      "not_found",
    ])
    .optional(),
  currentRevision: z.number().int().optional(),
});
export type WorkItemReconcileOutput = z.infer<
  typeof WorkItemReconcileOutputSchema
>;

export const workItemReconcileContract: ToolContract<
  typeof WORK_ITEM_RECONCILE_NAME,
  WorkItemReconcileInput,
  WorkItemReconcileOutput,
  WorkItemReconcileOutput
> = {
  name: WORK_ITEM_RECONCILE_NAME,
  description:
    "Brief steward only. Rewrite the summary and outcome of one open work item with compare-and-set. " +
    "Refuses unless the Goal = and Done when = lines are identical. Reason is built by the guard.",
  effect: "state_change",
  inputSchema: WorkItemReconcileInputSchema,
  outputSchema: WorkItemReconcileOutputSchema,
  redact: (output) => output,
  allowlist: [
    "success",
    "action",
    "id",
    "message",
    "revision",
    "code",
    "currentRevision",
  ] as const,
};

export function createWorkItemReconcileImplementation(deps: {
  readonly workItemCapability: WorkItemCapability;
}): ToolImplementation<WorkItemReconcileInput, WorkItemReconcileOutput> {
  const { workItemCapability } = deps;
  const refused = (
    input: WorkItemReconcileInput,
    code: NonNullable<WorkItemReconcileOutput["code"]>,
    message: string,
    currentRevision?: number,
  ): WorkItemReconcileOutput => ({
    success: false,
    action: "reconcile",
    id: input.id,
    code,
    message: `Not reconciled: ${message}. Nothing was written.`,
    ...(currentRevision !== undefined && { currentRevision }),
  });
  return {
    execute: async (raw) => {
      const input = WorkItemReconcileInputSchema.parse(raw);
      const [current] = (
        await workItemCapability.query({ ids: [input.id], limit: 1 })
      ).filter((item) => item.id === input.id);
      if (!current) return refused(input, "not_found", `${input.id} not found`);
      if (current.revision !== input.expectedRevision)
        return refused(
          input,
          "revision_conflict",
          `${input.id} is at revision ${current.revision}, expected ${input.expectedRevision}`,
          current.revision,
        );
      if (CLOSED.has(current.status))
        return refused(input, "item_closed", `${input.id} is ${current.status}`);
      const stored = approvedLinesOf(current.outcome ?? "");
      const proposed = approvedLinesOf(input.outcome);
      if (
        stored.length !== proposed.length ||
        stored.some((line, i) => line !== proposed[i])
      )
        return refused(
          input,
          "approved_lines_changed",
          "the Goal = or Done when = lines differ",
        );
      try {
        const result = await workItemCapability.patch({
          id: input.id,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          set: { summary: input.summary, outcome: input.outcome },
        });
        return {
          success: true,
          action: "reconcile",
          id: result.id,
          message: `Reconciled ${result.id}: updated summary, outcome`,
          ...(result.revision !== undefined && { revision: result.revision }),
        };
      } catch (e) {
        if (!(e instanceof WorkItemPatchConflictError)) throw e;
        return refused(
          input,
          "revision_conflict",
          `${input.id} is at revision ${e.currentRevision}, expected ${e.expectedRevision}`,
          e.currentRevision,
        );
      }
    },
  };
}

export const workItemReconcileBoundTool: BoundTool<
  typeof WORK_ITEM_RECONCILE_NAME,
  WorkItemReconcileInput,
  WorkItemReconcileOutput,
  WorkItemReconcileOutput
> = {
  contract: workItemReconcileContract,
  implementation: {
    execute: async () => {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
