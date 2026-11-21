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
import { WorkItemsBusyError } from "../src/errors.js";
import { handleWorkItemCreate, handleWorkItemPatch, WORK_ITEM_WRITE_EVENTS } from "../src/write-http.js";

const patchDeps = (overrides: Partial<Parameters<typeof handleWorkItemPatch>[1]> = {}) => ({
  readJson: async () => ({ reason: "r", set: { title: "t" } }),
  parse: (body: unknown) => WorkItemPatchInputSchema.safeParse(body),
  write: async () => ({ id: "task.1" }),
  toBody: (r: unknown) => r,
  attribution: { actor: "caller-1" },
  ...overrides,
});

describe("handleWorkItemPatch", () => {
  it("a patch is one success event naming the item", async () => {
    const r = await handleWorkItemPatch("task.1", patchDeps());
    expect(r.status).toBe(200);
    expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.patchSuccess, outcome: "success", workItemId: "task.1", citeCount: 0 });
  });

  it("a route write's events carry the actor alone; a node run's carry the requester and the run too (task.0133)", async () => {
    const route = await handleWorkItemPatch("task.1", patchDeps());
    expect(route.event).toMatchObject({ actor: "caller-1" });
    expect(route.event).not.toHaveProperty("requestedBy");
    expect(route.event).not.toHaveProperty("runId");
    const run = { actor: "node-ai", requestedBy: "owner-1", run: { id: "run-9", kind: "system_scheduled" as const } };
    const ran = await handleWorkItemPatch("task.1", patchDeps({ attribution: run }));
    expect(ran.event).toMatchObject({ outcome: "success", actor: "node-ai", requestedBy: "owner-1", runId: "run-9", runKind: "system_scheduled" });
    // A refusal names who tried: the same fields on the refused event.
    const refused = await handleWorkItemPatch("task.1", patchDeps({ attribution: run, readJson: async () => ({ reason: "r", set: { specRefs: ["x"] } }) }));
    expect(refused.event).toMatchObject({ outcome: "refused", errorCode: "invalid_input", actor: "node-ai", requestedBy: "owner-1", runId: "run-9", runKind: "system_scheduled" });
    const bad = await handleWorkItemPatch("task.1", patchDeps({ readJson: async () => { throw new Error("bad"); } }));
    expect(bad.event).toMatchObject({ errorCode: "invalid_json", actor: "caller-1" });
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

  // task.0162: a busy store answered a bare 503 whose only log line was "request complete".
  it("a busy store is one refused 503 event naming its reason, with a fixed body, before node mapping", async () => {
    const busy = new WorkItemsBusyError("Work-item writer admission unavailable: lock_contended branch work-item-op/x", "lock_contended");
    // A facade copy keeps the reason under its own name; the package still classifies it.
    const copy = Object.assign(new Error("copy"), { name: "WorkItemsBackendNotReadyError", reason: "queue_timeout" });
    for (const [error, reason] of [[busy, "lock_contended"], [copy, "queue_timeout"]] as const) {
      const r = await handleWorkItemPatch("task.1", patchDeps({
        write: async () => { throw error; },
        mapNodeError: () => ({ status: 500, errorCode: "wrong", body: {} }),
      }));
      expect(r.status).toBe(503);
      expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.patchRefused, errorCode: "backend_unavailable", reason });
      expect(r.body).toEqual({ error: expect.not.stringContaining("work-item-op"), code: reason });
    }
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
      attribution: { actor: "caller-1" },
    });
    expect(r.status).toBe(201);
    expect(r.event).toMatchObject({ event: WORK_ITEM_WRITE_EVENTS.createSuccess, workItemId: "task.9", node: "shared", actor: "caller-1" });
  });
});
