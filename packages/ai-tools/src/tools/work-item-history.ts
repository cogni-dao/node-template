// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/work-item-history`
 * Purpose: Host read of one work item's change log (when, who, why) for program guards.
 * Scope: Reads WorkItemCapability.history. A program guard calls it; no model tool list names it. Does not
 *   import LangChain and never returns field values.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__work_item_history`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - HOST_ONLY_READ: the only caller is the `brief-steward` guard; no catalog entry lends it to a model
 *   - UNKNOWN_IS_NOT_EMPTY: a capability without `history` yields `available: false`, never an empty list
 *   - NO_VALUES: versions carry version, time, actor and reason only
 * Side-effects: IO (reads history via capability)
 * Links: hub brief-steward-design, hub change-history-design
 * @public
 */

import { z } from "zod";
import type { WorkItemCapability } from "../capabilities/work-item";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const WORK_ITEM_HISTORY_NAME = "core__work_item_history" as const;
const Input = z.object({ id: z.string().min(1).max(200) });
const Output = z.object({
  /** False when this node's store has no history port: the log is unknown, not empty. */
  available: z.boolean(),
  versions: z.array(
    z.object({
      version: z.string(),
      at: z.string(),
      actor: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
type Input = z.infer<typeof Input>;
type Output = z.infer<typeof Output>;

export const workItemHistoryContract: ToolContract<
  typeof WORK_ITEM_HISTORY_NAME,
  Input,
  Output,
  Output
> = {
  name: WORK_ITEM_HISTORY_NAME,
  description:
    "Host read: the versions of one work item, newest first, with time, actor and change reason. Program guards call it; it is not offered to models.",
  effect: "read_only",
  inputSchema: Input,
  outputSchema: Output,
  redact: (output) => output,
  allowlist: ["available", "versions"] as const,
};

export function createWorkItemHistoryImplementation(deps: {
  readonly workItemCapability: WorkItemCapability;
}): ToolImplementation<Input, Output> {
  return {
    async execute({ id }) {
      const versions = await deps.workItemCapability.history?.(id);
      if (!versions) return { available: false, versions: [] };
      return {
        available: true,
        versions: versions.map((v) => ({
          version: v.version,
          at: v.at,
          actor: v.actor,
          reason: v.reason,
        })),
      };
    },
  };
}

export const workItemHistoryBoundTool: BoundTool<
  typeof WORK_ITEM_HISTORY_NAME,
  Input,
  Output,
  Output
> = {
  contract: workItemHistoryContract,
  implementation: {
    async execute() {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
