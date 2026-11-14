// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/work-item-artifact-record`
 * Purpose: `core__work_item_artifact_record` mirrors `POST /api/v1/work/items/{id}/artifacts` (task.0122): the route's body schema,
 *   the same scope as the PATCH twin, a refusal as a result, and no authority of its own.
 * Scope: Fake capability only.
 * Invariants: ONE_ARTIFACT_SCHEMA, SAME_DOOR, REFUSAL_IS_A_RESULT.
 * Side-effects: none
 * @internal
 */

import { WorkItemArtifactInputSchema } from "@cogni-dao/work-items";
import { describe, expect, it, vi } from "vitest";

import type { WorkItemCapability } from "../src/capabilities/work-item";
import {
  createWorkItemArtifactRecordImplementation,
  WorkItemArtifactRecordInputSchema,
  WorkItemArtifactRecordOutputSchema,
  workItemArtifactRecordContract,
} from "../src/tools/work-item-artifact-record";
import { workItemUpdateContract } from "../src/tools/work-item-update";

const TRIAGE = { kind: "triage", subject: "work:task.1", verdict: "implement", note: "no KPI measures this yet" };
const STORED = {
  id: "wia-1",
  itemId: "task.1",
  seq: 1,
  itemRevision: 7,
  kind: "triage",
  subject: "work:task.1",
  verdict: "implement",
  note: "no KPI measures this yet",
  author: "p1",
  createdAt: "2026-11-14T00:00:00.000Z",
};

const capability = (recordArtifact?: WorkItemCapability["recordArtifact"]) =>
  ({ ...(recordArtifact ? { recordArtifact } : {}) }) as unknown as WorkItemCapability;

describe("core__work_item_artifact_record", () => {
  it("takes the route's artifact schema as its `artifact`, and needs the PATCH twin's scope", () => {
    expect(WorkItemArtifactRecordInputSchema.shape.artifact).toBe(WorkItemArtifactInputSchema);
    expect(workItemArtifactRecordContract.requires).toEqual(workItemUpdateContract.requires);
    expect(workItemArtifactRecordContract.requires?.scope).toBe("work_item:transition");
    expect(workItemArtifactRecordContract.effect).toBe("state_change");
  });

  it("refuses an input the route would refuse: design_waiver-style kinds and a triage with a wrong verdict", () => {
    expect(
      WorkItemArtifactRecordInputSchema.safeParse({ id: "task.1", artifact: { ...TRIAGE, verdict: "approve" } }).success
    ).toBe(false);
    expect(
      WorkItemArtifactRecordInputSchema.safeParse({ id: "task.1", artifact: { ...TRIAGE, kind: "design_waiver" } }).success
    ).toBe(false);
    expect(WorkItemArtifactRecordInputSchema.safeParse({ id: "task.1", artifact: TRIAGE }).success).toBe(true);
  });

  it("records through the capability and returns the route's 201 body", async () => {
    const record = vi.fn(async () => ({ status: 201, body: { artifact: STORED } }));
    const out = await createWorkItemArtifactRecordImplementation({
      workItemCapability: capability(record),
    }).execute({ id: "task.1", artifact: TRIAGE } as never);
    expect(record).toHaveBeenCalledWith({ id: "task.1", body: TRIAGE });
    expect(out).toEqual({ artifact: STORED });
    expect(WorkItemArtifactRecordOutputSchema.safeParse(out).success).toBe(true);
  });

  it.each([
    [409, { error: "x", errorCode: "artifact_author_not_independent", reason: "same_principal" }, "artifact_author_not_independent"],
    [404, { error: "Work item not found: task.1", errorCode: "not_found" }, "not_found"],
    [400, { error: "invalid input", errorCode: "invalid_input" }, "invalid_input"],
    [503, { error: "artifacts_unavailable", errorCode: "artifacts_unavailable" }, "artifacts_unavailable"],
  ])("a %i refusal is a result with its code, not a throw", async (status, body, code) => {
    const out = await createWorkItemArtifactRecordImplementation({
      workItemCapability: capability(async () => ({ status, body })),
    }).execute({ id: "task.1", artifact: TRIAGE } as never);
    expect(out).toMatchObject({ success: false, id: "task.1", status, code });
    expect(WorkItemArtifactRecordOutputSchema.safeParse(out).success).toBe(true);
  });

  it("an unknown write outcome says to read before recording again", async () => {
    const out = await createWorkItemArtifactRecordImplementation({
      workItemCapability: capability(async () => ({
        status: 409,
        body: { errorCode: "work_item_write_outcome_unknown" },
      })),
    }).execute({ id: "task.1", artifact: TRIAGE } as never);
    expect(out).toMatchObject({ success: false, code: "work_item_write_outcome_unknown" });
    expect((out as { message: string }).message).toContain("Read");
  });

  it("a capability that serves no artifacts fails loudly", async () => {
    await expect(
      createWorkItemArtifactRecordImplementation({ workItemCapability: capability() }).execute({
        id: "task.1",
        artifact: TRIAGE,
      } as never)
    ).rejects.toThrow("does not record artifacts");
  });
});
