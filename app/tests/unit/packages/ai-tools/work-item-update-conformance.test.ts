// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * ONE_PATCH_SCHEMA (task.0065): the agent tool `core__work_item_update` mirrors `PATCH /api/v1/work/items/{id}` one to one.
 * Its input schema is the very schema the route parses, and it needs the scope the route declares.
 */
import { workItemsPatchOperation } from "@cogni/node-contracts";
import {
  WorkItemUpdateSuccessSchema,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { WorkItemPatchInputSchema } from "@cogni/work-items";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("core__work_item_update mirrors the PATCH route", () => {
  it("shares one input schema object with the route contract", () => {
    expect(workItemUpdateContract.inputSchema).toBe(WorkItemPatchInputSchema);
    expect(workItemsPatchOperation.input).toBe(WorkItemPatchInputSchema);
  });

  it("has the same JSON schema as the route contract", () => {
    expect(z.toJSONSchema(workItemUpdateContract.inputSchema)).toEqual(
      z.toJSONSchema(workItemsPatchOperation.input),
    );
  });

  it("returns the route's output: the same WorkItemDto schema on success", () => {
    expect(WorkItemUpdateSuccessSchema).toBe(workItemsPatchOperation.output);
    expect(z.toJSONSchema(WorkItemUpdateSuccessSchema)).toEqual(
      z.toJSONSchema(workItemsPatchOperation.output),
    );
    // The full output is that DTO or the typed revision_conflict result (the route's 409).
    expect(
      workItemUpdateContract.outputSchema.safeParse({
        success: false,
        id: "task.1",
        code: "revision_conflict",
        currentRevision: 3,
        message: "m",
      }).success,
    ).toBe(true);
  });

  it("requires the scope the route declares through sameDoor", () => {
    const door = SAME_DOOR_ROUTES.core__work_item_update;
    expect(door?.routes).toContain("work.items.patch");
    expect(workItemUpdateContract.requires?.scope).toBe(door?.scope);
  });
});
