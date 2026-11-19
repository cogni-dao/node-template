// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/write-http`
 * Purpose: Every create and PATCH answer carries exactly one terminal event from the package, so every fork logs the same lines (bug.0063).
 * Scope: The framework-free route core over fakes. No store, no network.
 * Invariants: ONE_TERMINAL_EVENT, EVENT_NAMES_HERE, PACKAGE_ERRORS_FIRST.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { WorkItemPatchInputSchema } from "../src/patch-contract.js";
import { handleWorkItemCreate, handleWorkItemPatch, WORK_ITEM_WRITE_EVENTS } from "../src/write-http.js";

const patchDeps = (overrides: Partial<Parameters<typeof handleWorkItemPatch>[1]> = {}) => ({
  readJson: async () => ({ reason: "r", set: { title: "t" } }),
  parse: (body: unknown) => WorkItemPatchInputSchema.safeParse(body),
  write: async () => ({ id: "task.1" }),
  toBody: (r: unknown) => r,
  ...overrides,
});

describe("handleWorkItemPatch", () => {
  it("a patch is one success event naming the item", async () => {
    const r = await handleWorkItemPatch("task.1", patchDeps());
    expect(r.status).toBe(200);
    expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.patchSuccess, outcome: "success", workItemId: "task.1", citeCount: 0 });
  });

  it("an untyped design link is one refused event with invalid_input", async () => {
    const r = await handleWorkItemPatch("task.1", patchDeps({ readJson: async () => ({ reason: "r", set: { specRefs: ["x"] } }) }));
    expect(r.status).toBe(400);
    expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.patchRefused, errorCode: "invalid_input", workItemId: "task.1" });
  });

  it("a gate refusal names the missing fact; a node error maps; anything else throws", async () => {
    const gate = Object.assign(new Error("gate"), { name: "WorkItemGateUnmetError", from: "needs_design_review", to: "needs_implement", missing: "design_link", code: "gate_unmet" });
    const refused = await handleWorkItemPatch("task.1", patchDeps({ write: async () => { throw gate; } }));
    expect(refused.status).toBe(409);
    expect(refused.event).toMatchObject({ errorCode: "gate_unmet", from: "needs_design_review", to: "needs_implement", missing: "design_link" });
    const node = await handleWorkItemPatch("task.1", patchDeps({
      write: async () => { throw new Error("nope"); },
      mapNodeError: () => ({ status: 404, errorCode: "not_found", body: { error: "nope" } }),
    }));
    expect(node.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.patchRefused, status: 404, errorCode: "not_found" });
    await expect(handleWorkItemPatch("task.1", patchDeps({ write: async () => { throw new Error("boom"); } }))).rejects.toThrow("boom");
  });

  it("malformed JSON and a body id that is not the path id are refused before parsing", async () => {
    expect((await handleWorkItemPatch("task.1", patchDeps({ readJson: async () => { throw new Error("bad"); } }))).event.errorCode).toBe("invalid_json");
    expect((await handleWorkItemPatch("task.1", patchDeps({ readJson: async () => ({ id: "task.2", reason: "r", set: { title: "t" } }) }))).event.errorCode).toBe("id_mismatch");
  });
});

describe("handleWorkItemCreate", () => {
  it("a create is one success event with the new id and node", async () => {
    const r = await handleWorkItemCreate({
      readJson: async () => ({}),
      parse: (body) => ({ success: true as const, data: body }),
      write: async () => ({ id: "task.9", node: "shared" }),
      toBody: (r) => r,
    });
    expect(r.status).toBe(201);
    expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.createSuccess, workItemId: "task.9", node: "shared" });
  });
});
