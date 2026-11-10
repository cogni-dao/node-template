// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-update`
 * Purpose: AI tool that mirrors `PATCH /api/v1/work/items/{id}` one to one: same input, same backend patch, same scope.
 * Scope: One state-changing work item patch via WorkItemCapability. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_update`
 *   - ONE_PATCH_SCHEMA: the input schema IS `WorkItemPatchInputSchema` from `@cogni-dao/work-items`, the schema the route parses. Never re-declared.
 *   - SAME_DOOR: requires `work_item:transition`, the scope the route declares through `sameDoor`.
 *   - STORE_AUTHORITY: the node's capability and store authorize and validate the write; this tool adds no authority.
 *   - CONFLICT_IS_A_RESULT: a lost compare-and-set returns `{success:false, code:"revision_conflict", currentRevision}`
 *     (the route answers 409 with the same facts), so a graph can re-read and retry.
 * Side-effects: IO (mutates a work item via capability)
 * Links: packages/work-items/src/patch-contract.ts, app/src/app/api/v1/work/items/[id]/route.ts
 * @public
 */

import { type WorkItemPatchInput, WorkItemPatchInputSchema } from "@cogni-dao/work-items";
import { z } from "zod";

import {
  type WorkItemCapability,
  WorkItemPatchConflictError,
} from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_UPDATE_NAME = "core__work_item_update" as const;

export const WorkItemUpdateOutputSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  message: z.string(),
  status: z.string().optional(),
  /** Item revision after a successful patch. */
  revision: z.number().int().optional(),
  /** Package-derived rank after the write; absent when evaluation is incomplete. */
  rankScore: z.number().optional(),
  /** Set when success=false: `revision_conflict` = the compare-and-set lost, nothing written. */
  code: z.literal("revision_conflict").optional(),
  /** On `revision_conflict`: the revision the item is actually at. */
  currentRevision: z.number().int().optional(),
});
export type WorkItemUpdateInput = WorkItemPatchInput;
export type WorkItemUpdateOutput = z.infer<typeof WorkItemUpdateOutputSchema>;

export const workItemUpdateContract: ToolContract<
  typeof WORK_ITEM_UPDATE_NAME,
  WorkItemUpdateInput,
  WorkItemUpdateOutput,
  WorkItemUpdateOutput
> = {
  name: WORK_ITEM_UPDATE_NAME,
  description:
    "Update a work item: the same operation as PATCH /api/v1/work/items/{id}. " +
    "Input { id, expectedRevision?, reason?, set }. `set` holds the fields to change (status, scores, labels, ...); " +
    "`scores` replaces the whole object. With expectedRevision the write lands only if the item is still at that " +
    "revision; otherwise nothing is written and the result is success=false, code='revision_conflict'. " +
    "`reason` is one line stored in the item's history. Read the item first with core__work_item_read.",
  effect: "state_change",
  requires: {
    scope: "work_item:transition",
    kind: "node",
    subject: "member",
    label: "Update work items and their priority scores",
    description: "Move work items along and change their scores.",
  },
  inputSchema: WorkItemPatchInputSchema,
  outputSchema: WorkItemUpdateOutputSchema,
  redact: (output) => output,
  allowlist: [
    "success",
    "id",
    "message",
    "status",
    "revision",
    "rankScore",
    "code",
    "currentRevision",
  ] as const,
};

export interface WorkItemUpdateDeps {
  readonly workItemCapability: WorkItemCapability;
}

export function createWorkItemUpdateImplementation(
  deps: WorkItemUpdateDeps
): ToolImplementation<WorkItemUpdateInput, WorkItemUpdateOutput> {
  return {
    execute: async (input) => {
      try {
        const updated = await deps.workItemCapability.patch({
          id: input.id,
          ...(input.expectedRevision !== undefined && {
            expectedRevision: input.expectedRevision,
          }),
          ...(input.reason !== undefined && { reason: input.reason }),
          set: input.set,
        });
        return {
          success: true,
          id: updated.id,
          message: `Updated ${updated.id}: ${Object.keys(input.set).join(", ")}`,
          status: updated.status,
          ...(updated.revision !== undefined && { revision: updated.revision }),
          ...(updated.rankScore !== undefined && { rankScore: updated.rankScore }),
        };
      } catch (e) {
        if (!(e instanceof WorkItemPatchConflictError)) throw e;
        return {
          success: false,
          id: input.id,
          code: "revision_conflict",
          currentRevision: e.currentRevision,
          message: `Not updated: ${input.id} is at revision ${e.currentRevision}, expected ${e.expectedRevision}. Nothing was written; re-read and retry.`,
        };
      }
    },
  };
}

export const workItemUpdateBoundTool: BoundTool<
  typeof WORK_ITEM_UPDATE_NAME,
  WorkItemUpdateInput,
  WorkItemUpdateOutput,
  WorkItemUpdateOutput
> = {
  contract: workItemUpdateContract,
  implementation: {
    execute: async () => {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
