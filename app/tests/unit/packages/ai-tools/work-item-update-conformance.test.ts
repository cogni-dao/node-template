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
import { KnowledgeEntryIdSchema } from "@cogni/knowledge-store";
import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  CITE_ID_PATTERN,
  WorkItemPatchInputSchema,
} from "@cogni/work-items";
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

describe("reason and cites (task.0086)", () => {
  it("the shared JSON schema requires a reason and offers cites", () => {
    const schema = z.toJSONSchema(workItemUpdateContract.inputSchema) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("reason");
    expect(schema.properties).toHaveProperty("cites");
    expect(workItemUpdateContract.description).toContain(
      CHANGE_REASON_REQUIRED_MESSAGE,
    );
  });

  it("the cite id pattern accepts every id the knowledge store accepts", () => {
    const longest = `${"a".repeat(9)}-${"b".repeat(9)}-${"c".repeat(9)}-${"d".repeat(10)}`;
    expect(longest).toHaveLength(40);
    for (const id of [
      "ab",
      "a1",
      "change-history-design",
      "node-template-mission",
      "0abc-1def",
      longest,
    ]) {
      expect(KnowledgeEntryIdSchema.safeParse(id).success).toBe(true);
      expect(CITE_ID_PATTERN.test(id)).toBe(true);
    }
    // The copy is wider on purpose (dots, underscores, 256 chars); it never rejects a valid knowledge id.
    for (const id of ["Upper", "-lead", "has space", "has\nline", ""]) {
      expect(CITE_ID_PATTERN.test(id)).toBe(false);
    }
  });
});
