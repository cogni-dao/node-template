// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/work-item-tool-envelope.conformance`
 * Purpose: Check the derived tool envelope against the complete HTTP read contract.
 * Scope: Compatibility controls; CI's source-only installed-artifact probe proves inheritance.
 * Invariants: real revision, complete canonical context, additive legacy assignee id.
 * Side-effects: none
 * @internal
 */
import {
  createWorkItemQueryImplementation, type WorkItemCapability, type WorkItemInfo,
  WorkItemOutputSchema, WorkItemQueryOutputSchema,
} from "@cogni/ai-tools";
import { WorkItemDtoSchema } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";

const item: WorkItemInfo = {
  id: "task.0007", type: "task", title: "Read context", status: "needs_implement",
  revision: 7, node: "shared", labels: ["proof"], specRefs: ["knowledge:context"],
  assignees: [{ kind: "agent", agentId: "agent-1" }], externalRefs: [],
  reviewer: "independent", claimedByRun: "run-1", claimedAt: "2026-10-20T00:00:00Z", lastCommand: "implement",
  createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", deployVerified: true,
};
const capability: WorkItemCapability = { query: vi.fn().mockResolvedValue([item]), transitionStatus: vi.fn(), patch: vi.fn() };

describe("derived work-item read envelope", () => {
  it("derives all HTTP item fields and adds only tool provenance", async () => {
    expect(Object.keys(WorkItemOutputSchema.shape)).toEqual(expect.arrayContaining(Object.keys(WorkItemDtoSchema.shape)));
    const execute = createWorkItemQueryImplementation({ workItemCapability: capability }).execute;
    for (const params of [{}, { ids: [item.id] }]) {
      const result = WorkItemQueryOutputSchema.parse(await execute(params));
      expect(WorkItemDtoSchema.parse(result.items[0])).toMatchObject(item);
      expect(result.items[0]?.assignees[0]).toEqual({ kind: "agent", agentId: "agent-1", id: "agent-1" });
    }
  });
  it("rejects missing revision instead of inventing one", async () => {
    const { revision: _revision, ...missingRevision } = item;
    expect(WorkItemDtoSchema.safeParse(missingRevision).success).toBe(false);
    expect(WorkItemOutputSchema.safeParse(missingRevision).success).toBe(false);
  });
});
