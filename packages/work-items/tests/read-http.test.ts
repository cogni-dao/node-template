// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/read-http`
 * Purpose: Every single-item read carries exactly one terminal event from the package and asks the node's store for exactly the
 *   parts the shared item view draws, so every fork serves and logs the same read (story.0085).
 * Scope: The framework-free read route core over fakes. No store, no network.
 * Invariants: ONE_TERMINAL_EVENT, UNKNOWN_INCLUDE_REFUSED, ONE_READ_TAXONOMY.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { handleWorkItemGet, WORK_ITEM_READ_EVENTS } from "../src/read-http.js";

const deps = (query: string, overrides: Partial<Parameters<typeof handleWorkItemGet>[1]> = {}) => ({
  searchParams: new URLSearchParams(query),
  read: vi.fn(async () => ({ id: "task.1" })),
  toBody: (r: unknown) => r,
  ...overrides,
});

describe("handleWorkItemGet", () => {
  it("asks the store for each requested part, from a comma list or repeats, and logs one success", async () => {
    const d = deps("include=links,artifacts&include=history&artifact=wia-2");
    const r = await handleWorkItemGet("task.1", d);
    expect(r.status).toBe(200);
    expect(d.read).toHaveBeenCalledWith("task.1", {
      includeLinks: true,
      includeArtifacts: true,
      includeHistory: true,
      artifactId: "wia-2",
    });
    expect(r.event).toEqual({
      event: WORK_ITEM_READ_EVENTS.getSuccess,
      routeId: "work.items.get",
      outcome: "success",
      status: 200,
      workItemId: "task.1",
      include: ["links", "artifacts", "history"],
    });
  });

  it("a bare read asks for no part", async () => {
    const d = deps("");
    await handleWorkItemGet("task.1", d);
    expect(d.read).toHaveBeenCalledWith("task.1", { includeLinks: false, includeArtifacts: false, includeHistory: false });
  });

  it("refuses an unknown part or a bad artifact id before any read", async () => {
    for (const query of ["include=links,secrets", "artifact=../x"]) {
      const d = deps(query);
      const r = await handleWorkItemGet("task.1", d);
      expect(r.status).toBe(400);
      expect(r.event).toMatchObject({ event: WORK_ITEM_READ_EVENTS.getRefused, errorCode: "invalid_input" });
      expect(d.read).not.toHaveBeenCalled();
    }
  });

  it("no item is 404 not_found", async () => {
    const r = await handleWorkItemGet("task.9", deps("", { read: async () => null }));
    expect(r).toMatchObject({ status: 404, body: { error: "Work item not found: task.9" } });
    expect(r.event).toMatchObject({ outcome: "refused", errorCode: "not_found", workItemId: "task.9" });
  });

  it("a busy backend is 503 with a fixed text; an aborted request is 499 with no body", async () => {
    const busy = Object.assign(new Error("pool exhausted at host x"), { name: "WorkItemsBackendNotReadyError" });
    const r = await handleWorkItemGet("task.1", deps("", { read: async () => Promise.reject(busy) }));
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("host x");
    expect(r.event.errorCode).toBe("backend_unavailable");

    const controller = new AbortController();
    controller.abort();
    const aborted = await handleWorkItemGet(
      "task.1",
      deps("", { signal: controller.signal, read: async () => Promise.reject(new Error("aborted")) }),
    );
    expect(aborted).toMatchObject({ status: 499, body: null, event: { errorCode: "client_aborted" } });
  });

  it("a node error maps through the node; anything still unknown is rethrown", async () => {
    class Forbidden extends Error {}
    const mapNodeError = (e: unknown) => (e instanceof Forbidden ? { status: 403, errorCode: "forbidden", body: {} } : undefined);
    const r = await handleWorkItemGet("task.1", deps("", { read: async () => Promise.reject(new Forbidden()), mapNodeError }));
    expect(r.event).toMatchObject({ status: 403, errorCode: "forbidden" });
    await expect(
      handleWorkItemGet("task.1", deps("", { read: async () => Promise.reject(new Error("boom")), mapNodeError })),
    ).rejects.toThrow("boom");
  });
});
