// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-update`
 * Purpose: AI tool that mirrors `PATCH /api/v1/work/items/{id}` one to one: same input, same backend patch, same scope, same output.
 * Scope: One state-changing work item patch via WorkItemCapability. Does not import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_update`
 *   - ONE_PATCH_SCHEMA: the input schema IS `WorkItemPatchInputSchema` from `@cogni-dao/work-items`, the schema the route parses. Never re-declared.
 *   - SAME_DOOR: requires `work_item:transition`, the scope the route declares through `sameDoor`.
 *   - STORE_AUTHORITY: the node's capability and store authorize and validate the write; this tool adds no authority.
 *   - OUTPUT_IS_THE_ROUTE_DTO: success returns `WorkItemDtoSchema`, the route's `workItemsPatchOperation.output`, with no field dropped
 *     and no bound: the write has already landed (agent-tool-context-envelope rules 1 and 4).
 *   - MOVES_SERVER_PINS_BASELINE (story.0033): `set.moves` is `[{ metricId, direction }]`; the shared schema drops any baseline an agent sends and the store pins it.
 *   - REASON_REQUIRED (task.0086): `reason` is required by the shared schema, so the tool fails without one and nothing is written; `cites` is forwarded unchanged and the store pins it.
 *   - CONFLICT_IS_A_RESULT: a lost compare-and-set returns `{success:false, code:"revision_conflict", currentRevision}`
 *     (the route answers 409 with the same facts), so a graph can re-read and retry.
 * Side-effects: IO (mutates a work item via capability)
 * Links: packages/work-items/src/patch-contract.ts, app/src/app/api/v1/work/items/[id]/route.ts
 * @public
 */

import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  type WorkItemPatchInput,
  WorkItemDtoSchema,
  WorkItemPatchInputSchema,
} from "@cogni-dao/work-items";
import { z } from "zod";

import {
  type WorkItemCapability,
  WorkItemPatchConflictError,
} from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_UPDATE_NAME = "core__work_item_update" as const;

/** Success: the same `WorkItemDto` the PATCH route returns (pass-through). */
export const WorkItemUpdateSuccessSchema = WorkItemDtoSchema;
/** The tool's version of the route's 409: a lost compare-and-set, nothing written. */
export const WorkItemUpdateConflictSchema = z.object({
  success: z.literal(false),
  id: z.string(),
  code: z.literal("revision_conflict"),
  currentRevision: z.number().int(),
  message: z.string(),
});
/**
 * The tool's version of the route's 409 `gate_unmet` and 503 `gate_facts_unavailable` (task.0122): the status step lacks
 * the artifact or fact it needs, and nothing was written. `missing` names it (an artifact kind such as design_review,
 * implementation_review or validation, or pr, pr_merged, children, brief_edit ...), so the agent knows what to obtain.
 */
export const WorkItemUpdateGateSchema = z.object({
  success: z.literal(false),
  id: z.string(),
  code: z.enum(["gate_unmet", "gate_facts_unavailable"]),
  from: z.string(),
  to: z.string(),
  missing: z.string(),
  message: z.string(),
});
export const WorkItemUpdateOutputSchema = z.union([
  WorkItemUpdateSuccessSchema,
  WorkItemUpdateConflictSchema,
  WorkItemUpdateGateSchema,
]);
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
    "Update a work item: the same operation as PATCH /api/v1/work/items/{id}; it returns the updated item. " +
    "Input { id, expectedRevision?, reason, cites?, set }. `set` holds the fields to change (status, scores, labels, ...); " +
    "`scores` replaces the whole object. " +
    "A status moves forward one stage at a time and only with the exit artifact of the stage it leaves, recorded by someone other than the author (triage: a triage artifact, six scores, a goal label, moves or a gap; design review: an approve; implement: pr; implementation review: an approve at the current head; validation: PASS-grade at the approved head; merge: the PR merged at the approved head). Without it the result is success=false, code='gate_unmet' with from, to and missing (the artifact kind or fact to obtain), and nothing is written; code='gate_facts_unavailable' means a fact could not be read, so retry. Moving back (to needs_triage or an earlier stage on the item's path) or cancelling needs only a reason; blocked is not a stage. " +
    "`set.moves` (optional) names the metrics this work moves: at most 3 of { metricId, direction: 'up'|'down' }; it replaces the whole list and [] means the item moves no metric (say why in the reason). " +
    "Use a metric id from core__metric_list or core__goal_progress; an unknown or deprecated NEW id fails the write, while an entry already on the item is kept. Set moves when you file an item too (POST create takes the same `moves`). Never send a baseline: the server pins each new metric's baseline once and keeps it. " +
    "With expectedRevision the write lands only if the item is still at that " +
    "revision; otherwise nothing is written and the result is success=false, code='revision_conflict'. " +
    `${CHANGE_REASON_REQUIRED_MESSAGE}. Keep it to 25 words; never put the reason in summary or outcome. ` +
    "`cites` (optional, at most 8) lists hub atoms you read for this decision, each as { id } or { id, contribution }; each is pinned to its commit in history; an unknown id fails the write. " +
    "Read the item first with core__work_item_read.",
  effect: "state_change",
  requires: {
    scope: "work_item:transition",
    kind: "node",
    subject: "member",
    label: "Update work items and record their reviews",
    description: "Change a work item's status, scores and labels, and record its triage and reviews.",
  },
  inputSchema: WorkItemPatchInputSchema,
  outputSchema: WorkItemUpdateOutputSchema,
  redact: (output) => output,
  // Every top-level key of the DTO the route returns, plus the conflict result's keys.
  allowlist: [
    ...Object.keys(WorkItemDtoSchema.shape),
    "success",
    "code",
    "currentRevision",
    "from",
    "to",
    "missing",
    "message",
  ] as never,
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
          reason: input.reason,
          ...(input.cites !== undefined && { cites: input.cites }),
          set: input.set,
        });
        return WorkItemUpdateSuccessSchema.parse(updated);
      } catch (e) {
        // By name: the package error may come from a second bundled copy of the class.
        const name = (e as { name?: unknown } | null)?.name;
        if (name === "WorkItemGateUnmetError" || name === "WorkItemGateFactsUnavailableError") {
          const gate = e as { from?: unknown; to?: unknown; missing?: unknown };
          const unmet = name === "WorkItemGateUnmetError";
          const to = String(gate.to ?? input.set.status ?? "");
          return {
            success: false as const,
            id: input.id,
            code: unmet ? ("gate_unmet" as const) : ("gate_facts_unavailable" as const),
            from: String(gate.from ?? ""),
            to,
            missing: String(gate.missing ?? ""),
            message: unmet
              ? `Not updated: ${input.id} cannot move from ${String(gate.from ?? "its stage")} to ${to}; ${String(gate.missing ?? "its artifact")} is missing or stale. Nothing was written; obtain it (recorded by someone other than the author) and retry, or move back.`
              : `Not updated: a fact the gate reads (${String(gate.missing ?? "unknown")}) could not be read. Nothing was written; retry shortly.`,
          };
        }
        if (!(e instanceof WorkItemPatchConflictError)) throw e;
        return {
          success: false as const,
          id: input.id,
          code: "revision_conflict" as const,
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
