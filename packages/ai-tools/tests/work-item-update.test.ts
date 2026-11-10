// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-update`
 * Purpose: Unit tests for core__work_item_update (task.0065): capability passthrough and the non-throwing conflict result.
 * Scope: Does not hit a store.
 * Side-effects: none
 * @internal
 */

import { WorkItemPatchInputSchema } from "@cogni-dao/work-items";
import { describe, expect, it, vi } from "vitest";

import {
  type WorkItemCapability,
  type WorkItemInfo,
  WorkItemPatchConflictError,
} from "../src/capabilities/work-item";
import {
  createWorkItemUpdateImplementation,
  WorkItemUpdateOutputSchema,
  workItemUpdateContract,
} from "../src/tools/work-item-update";

const PATCHED = {
  id: "task.5001",
  type: "task",
  title: "A task",
  status: "needs_design",
  priority: 1,
  rank: 4,
  rankScore: 6.4,
  labels: ["goal:x"],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  updatedAt: "2026-10-21T00:00:00.000Z",
  revision: 9,
} as unknown as WorkItemInfo;

const capability = (patch: WorkItemCapability["patch"]) =>
  ({ patch }) as unknown as WorkItemCapability;

describe("core__work_item_update", () => {
  it("takes the PATCH route's input schema, not a copy", () => {
    expect(workItemUpdateContract.inputSchema).toBe(WorkItemPatchInputSchema);
    expect(workItemUpdateContract.requires?.scope).toBe("work_item:transition");
  });

  it("passes id, expectedRevision, reason and set through to the capability patch", async () => {
    const patch = vi.fn().mockResolvedValue(PATCHED);
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: capability(patch),
    });
    const input = {
      id: "task.5001",
      expectedRevision: 8,
      reason: "triage: route",
      set: { status: "needs_design" as const, labels: ["goal:x"] },
    };
    const out = await impl.execute(input, {} as never);
    expect(patch).toHaveBeenCalledWith(input);
    expect(WorkItemUpdateOutputSchema.parse(out)).toMatchObject({
      success: true,
      id: "task.5001",
      status: "needs_design",
      revision: 9,
    });
  });

  it("returns a lost compare-and-set as a result, not a throw", async () => {
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: capability(
        vi.fn().mockRejectedValue(new WorkItemPatchConflictError("task.5001", 8, 10)),
      ),
    });
    const out = await impl.execute(
      { id: "task.5001", expectedRevision: 8, set: { rank: 1 } },
      {} as never,
    );
    expect(out).toMatchObject({
      success: false,
      code: "revision_conflict",
      currentRevision: 10,
    });
  });

  it("lets any other error bubble", async () => {
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: capability(vi.fn().mockRejectedValue(new Error("boom"))),
    });
    await expect(
      impl.execute({ id: "task.1", set: { rank: 1 } }, {} as never),
    ).rejects.toThrow("boom");
  });
});
