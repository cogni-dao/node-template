// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Complete bounded work-item read through the host-injected capability. */
import { z } from "zod";
import type { WorkItemCapability } from "../capabilities/work-item";
import { readSourceProvenance, withoutSourceProvenance } from "../source-url";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";
import { toToolAssignee, WorkItemOutputSchema } from "./work-item-query";

export const WORK_ITEM_READ_NAME = "core__work_item_read" as const;
const Input = z.object({
  id: z.string().min(1).max(200),
  includeLinks: z
    .boolean()
    .optional()
    .describe(
      "true adds links: the first page (five) of the item's citation links with nextCursor; page on through GET /api/v1/citations/{id}?cursor=",
    ),
});
const Output = z.object({ item: WorkItemOutputSchema.nullable() });
type Input = z.infer<typeof Input>;
type Output = z.infer<typeof Output>;

export const workItemReadContract: ToolContract<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  name: WORK_ITEM_READ_NAME,
  description:
    "Read one work item completely by exact id. Oversized items fail rather than returning truncated evidence. " +
    "`moves` lists the metrics the item moves: each has its pinned baseline, the current reading and `moved` (as_declared, against, flat or unknown). unknown is never zero: it means a reading is missing. " +
    "Each move also names its goal chain: `metric` (id, title, unit, display), `kpi` (the goal KPI it moves or serves: metricId, title, comparator, target, status) and `goal` (id, title). Read the goal and KPI here rather than through goal or metric reads. " +
    "kpi and goal are absent when the metric serves no goal KPI; `context: \"unavailable\"` means the chain could not be resolved, never that there is none. " +
    "Set includeLinks to also get `links`: the first page of the item's citation links with nextCursor (`links.unavailable` means they could not be read, not that there are none).",
  effect: "read_only",
  inputSchema: Input,
  outputSchema: Output,
  redact: (output) => output,
  allowlist: ["item"] as const,
};

export function createWorkItemReadImplementation(deps: {
  readonly workItemCapability: WorkItemCapability;
  readonly nodePublicOrigin?: string | undefined;
}): ToolImplementation<Input, Output> {
  return {
    async execute({ id, includeLinks }) {
      // ONE_ITEM_ENVELOPE: the capability's `read` is the single-item envelope the route serves.
      const capability = deps.workItemCapability;
      const item = capability.read
        ? await capability.read(id, { includeLinks: includeLinks === true })
        : (await capability.query({ ids: [id], limit: 1 })).find(
            (entry) => entry.id === id,
          );
      if (!item || item.id !== id) return { item: null };
      const result = {
        ...withoutSourceProvenance(item),
        labels: [...item.labels],
        assignees: item.assignees.map(toToolAssignee),
        specRefs: [...item.specRefs],
        ...readSourceProvenance(deps.nodePublicOrigin, "work/items", item.id),
      };
      if (new TextEncoder().encode(JSON.stringify(result)).length > 65536)
        throw new Error("work_item_read_exceeds_limit");
      return { item: result };
    },
  };
}

export const workItemReadBoundTool: BoundTool<
  typeof WORK_ITEM_READ_NAME,
  Input,
  Output,
  Output
> = {
  contract: workItemReadContract,
  implementation: {
    async execute() {
      throw new Error("WorkItemCapability not configured.");
    },
  },
};
