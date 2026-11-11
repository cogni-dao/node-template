// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-update`
 * Purpose: Unit tests for core__work_item_update (task.0065): capability passthrough and the non-throwing conflict result.
 * Scope: Does not hit a store.
 * Side-effects: none
 * @internal
 */

import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  WorkItemPatchInputSchema,
} from "@cogni-dao/work-items";
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
  createdAt: "2026-10-20T00:00:00.000Z",
  deployVerified: false,
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
    // The tool returns the updated item, the PATCH route's DTO, with no field dropped.
    expect(WorkItemUpdateOutputSchema.parse(out)).toMatchObject({
      id: "task.5001",
      status: "needs_design",
      revision: 9,
      rankScore: 6.4,
      labels: ["goal:x"],
    });
    expect(out).not.toHaveProperty("success");
  });

  it("forwards cites unchanged and omits them when absent", async () => {
    const patch = vi.fn().mockResolvedValue(PATCHED);
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: capability(patch),
    });
    const cites = [{ id: "change-history-design" }, { id: "other-atom", contribution: "contrib-x-1" }];
    await impl.execute({ id: "task.5001", reason: "r", cites, set: { rank: 1 } }, {} as never);
    expect(patch).toHaveBeenLastCalledWith({ id: "task.5001", reason: "r", cites, set: { rank: 1 } });
    await impl.execute({ id: "task.5001", reason: "r", set: { rank: 1 } }, {} as never);
    expect(patch).toHaveBeenLastCalledWith({ id: "task.5001", reason: "r", set: { rank: 1 } });
  });

  it("the input schema requires a reason with the message the 400 uses, and bounds cites", () => {
    const parse = (extra: Record<string, unknown>) =>
      workItemUpdateContract.inputSchema.safeParse({ id: "task.1", set: { rank: 1 }, ...extra });
    const missing = parse({});
    expect(missing.success).toBe(false);
    expect(missing.success ? [] : missing.error.issues).toEqual([
      expect.objectContaining({ path: ["reason"], message: CHANGE_REASON_REQUIRED_MESSAGE }),
    ]);
    expect(parse({ reason: "r", cites: [{ id: "a" }] }).success).toBe(true);
    expect(parse({ reason: "r", cites: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}` })) }).success).toBe(false);
    expect(workItemUpdateContract.description).toContain(CHANGE_REASON_REQUIRED_MESSAGE);
  });

  it("returns a lost compare-and-set as a result, not a throw", async () => {
    const impl = createWorkItemUpdateImplementation({
      workItemCapability: capability(
        vi.fn().mockRejectedValue(new WorkItemPatchConflictError("task.5001", 8, 10)),
      ),
    });
    const out = await impl.execute(
      { id: "task.5001", expectedRevision: 8, reason: "r", set: { rank: 1 } },
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
      impl.execute({ id: "task.1", reason: "r", set: { rank: 1 } }, {} as never),
    ).rejects.toThrow("boom");
  });
});
