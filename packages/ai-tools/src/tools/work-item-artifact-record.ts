// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-artifact-record`
 * Purpose: AI tool that mirrors `POST /api/v1/work/items/{id}/artifacts` one to one: the same body, the same backend handler, the same scope.
 *   It lets an agent record the artifact a status move needs (a triage route, a review, a validation) before it patches the status.
 * Scope: One artifact insert via WorkItemCapability. Does not import LangChain. Recording never moves the item.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_artifact_record`
 *   - ONE_ARTIFACT_SCHEMA: `artifact` IS `WorkItemArtifactInputSchema` from `@cogni-dao/work-items`, the schema the route parses. Never re-declared.
 *   - SAME_DOOR: requires `work_item:transition`, the scope `core__work_item_update` and the route declare; no new scope.
 *   - STORE_AUTHORITY: the package handler stamps the author from the run's principal and refuses a subject's own author; this tool adds no authority.
 *   - REFUSAL_IS_A_RESULT: a refusal (400, 404, 409, 503) returns `{ success:false, status, code, message }`; nothing was written, except a 409
 *     `work_item_write_outcome_unknown`, which says to read before retrying.
 * Side-effects: IO (inserts an artifact via capability)
 * Links: packages/work-items/src/artifacts.ts, app/src/app/api/v1/work/items/[id]/artifacts/route.ts
 * @public
 */

import {
  WorkItemArtifactInputSchema,
  WorkItemArtifactSchema,
} from "@cogni-dao/work-items";
import { z } from "zod";

import type { WorkItemCapability } from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_ARTIFACT_RECORD_NAME = "core__work_item_artifact_record" as const;

export const WorkItemArtifactRecordInputSchema = z.object({
  id: z.string().min(1).describe("The work item id the artifact is recorded on."),
  artifact: WorkItemArtifactInputSchema,
});
export type WorkItemArtifactRecordInput = z.infer<typeof WorkItemArtifactRecordInputSchema>;

/** Success: the route's 201 body. */
export const WorkItemArtifactRecordSuccessSchema = z.object({
  artifact: WorkItemArtifactSchema,
});
/** A refusal as a result, so a graph can read why and act. */
export const WorkItemArtifactRecordRefusalSchema = z.object({
  success: z.literal(false),
  id: z.string(),
  status: z.number().int(),
  code: z.string(),
  message: z.string(),
});
export const WorkItemArtifactRecordOutputSchema = z.union([
  WorkItemArtifactRecordSuccessSchema,
  WorkItemArtifactRecordRefusalSchema,
]);
export type WorkItemArtifactRecordOutput = z.infer<typeof WorkItemArtifactRecordOutputSchema>;

export const workItemArtifactRecordContract: ToolContract<
  typeof WORK_ITEM_ARTIFACT_RECORD_NAME,
  WorkItemArtifactRecordInput,
  WorkItemArtifactRecordOutput,
  WorkItemArtifactRecordOutput
> = {
  name: WORK_ITEM_ARTIFACT_RECORD_NAME,
  description:
    "Record one immutable artifact on a work item: the same operation as POST /api/v1/work/items/{id}/artifacts. " +
    "Input { id, artifact: { kind, subject, verdict, note?, url?, body?, rows? } }. A triage artifact has kind 'triage', subject 'work:<itemId>', " +
    "verdict research, design or implement (the route you chose) and, when the item declares no `moves`, a one-line `note` naming the measurement gap. " +
    "Recording never moves the item: record the artifact, then patch the status with core__work_item_update. " +
    "The author is you; a review or validation of work you wrote is refused. A refusal returns success=false with a code and nothing was written.",
  effect: "state_change",
  requires: {
    scope: "work_item:transition",
    kind: "node",
    subject: "member",
    label: "Update work items and record their reviews",
    description: "Change a work item's status, scores and labels, and record its triage and reviews.",
  },
  inputSchema: WorkItemArtifactRecordInputSchema,
  outputSchema: WorkItemArtifactRecordOutputSchema,
  redact: (output) => output,
  allowlist: ["artifact", "success", "id", "status", "code", "message"] as never,
};

export interface WorkItemArtifactRecordDeps {
  readonly workItemCapability: WorkItemCapability;
}

export function createWorkItemArtifactRecordImplementation(
  deps: WorkItemArtifactRecordDeps
): ToolImplementation<WorkItemArtifactRecordInput, WorkItemArtifactRecordOutput> {
  return {
    execute: async (input) => {
      const record = deps.workItemCapability.recordArtifact;
      if (!record) throw new Error("WorkItemCapability does not record artifacts.");
      const result = await record.call(deps.workItemCapability, {
        id: input.id,
        body: input.artifact,
      });
      if (result.status === 201) return WorkItemArtifactRecordSuccessSchema.parse(result.body);
      const body = (result.body ?? {}) as { errorCode?: unknown; error?: unknown; reason?: unknown };
      const code = String(body.errorCode ?? body.error ?? "refused");
      const reason = typeof body.reason === "string" ? ` (${body.reason})` : "";
      return {
        success: false as const,
        id: input.id,
        status: result.status,
        code,
        message:
          code === "work_item_write_outcome_unknown"
            ? `The write outcome of the artifact on ${input.id} is unknown. Read the item's artifacts before recording again.`
            : `Not recorded: ${code}${reason}. Nothing was written.`,
      };
    },
  };
}

export const workItemArtifactRecordBoundTool: BoundTool<
  typeof WORK_ITEM_ARTIFACT_RECORD_NAME,
  WorkItemArtifactRecordInput,
  WorkItemArtifactRecordOutput,
  WorkItemArtifactRecordOutput
> = {
  contract: workItemArtifactRecordContract,
  implementation: {
    execute: async () => {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
