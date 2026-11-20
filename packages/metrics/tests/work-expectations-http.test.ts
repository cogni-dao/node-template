// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/tests/work-expectations-http`
 * Purpose: The expectations route core assesses only bindings pinned to the item's moves, in one batch, and says when evidence
 *   is unavailable instead of failing (story.0085). Before, each fork carried this logic as a copied app route.
 * Scope: The framework-free core over fakes. No store, no network.
 * Invariants: PINNED_MATCH, ONE_BATCH, ONE_TERMINAL_EVENT.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { WorkExpectationPageSchema } from "../src/contracts.js";
import { handleWorkExpectations, WORK_EXPECTATIONS_READ_EVENT } from "../src/work-expectations-http.js";

const BASE = "00000000-0000-4000-8000-000000000001";
const binding = (metricId: string, baselineObservationId = BASE) => ({
  metricId,
  comparator: "gte",
  target: { value: 4, unit: "count" },
  baselineObservationId,
});
const edo = {
  items: [
    {
      hypothesis: { id: "hyp.1", title: "More merges", content: "c", kpiBindings: [binding("m-pinned"), binding("m-other")] },
      outcomes: [{ id: "out.1", title: "Observed", content: "recount" }],
      truncated: false,
    },
    { hypothesis: { id: "hyp.2", title: "Bad", content: "c", kpiBindings: "nope" }, outcomes: [], truncated: false },
  ],
  truncated: false,
};
const item = { moves: [{ metricId: "m-pinned", baselineObservationId: BASE }] };
const assessment = { status: "met", value: 5, unit: "count", observationId: "obs-1", reason: null, deadline: null };

describe("handleWorkExpectations", () => {
  it("assesses only the pinned binding, in one batch, and returns the page the view parses", async () => {
    const predictionBatch = vi.fn(async () => [{ assessment, viewState: "ok" }]);
    const r = await handleWorkExpectations({
      workItemId: "task.1",
      readItem: async () => item,
      readEdo: async () => edo,
      predictionBatch: predictionBatch as never,
    });
    expect(r.status).toBe(200);
    expect(predictionBatch).toHaveBeenCalledOnce();
    expect(predictionBatch.mock.calls[0]?.[0]).toEqual([binding("m-pinned")]);
    const page = WorkExpectationPageSchema.parse(r.body);
    expect(page.items[0]?.predictions).toEqual([
      { metricId: "m-pinned", expected: "gte 4 count", observed: "met · 5 count · obs-1 · ok" },
      { metricId: "m-other", expected: "gte 4 count", observed: "unresolved (metric or baseline mismatch)" },
    ]);
    expect(page.items[1]?.predictions).toEqual([{ metricId: "", expected: "invalid binding", observed: "unresolved" }]);
    expect(r.event).toEqual({
      event: WORK_EXPECTATIONS_READ_EVENT,
      routeId: "work.expectations.get",
      outcome: "success",
      status: 200,
      workItemId: "task.1",
    });
  });

  it("a failed batch or no metrics reads unavailable evidence, never an error page", async () => {
    for (const predictionBatch of [undefined, async () => Promise.reject(new Error("x"))]) {
      const r = await handleWorkExpectations({
        workItemId: "task.1",
        readItem: async () => item,
        readEdo: async () => edo,
        predictionBatch: predictionBatch as never,
      });
      expect(r.status).toBe(200);
      expect(r.event.errorCode).toBe("metrics_unavailable");
      expect(WorkExpectationPageSchema.parse(r.body).items[0]?.predictions[0]?.observed).toBe("unavailable (metrics_unavailable)");
    }
  });

  it("no EDO read or a failed read is 503; no item is 404", async () => {
    const none = await handleWorkExpectations({ workItemId: "task.1", readItem: async () => item });
    expect(none).toMatchObject({ status: 503, event: { errorCode: "unavailable" } });
    const failed = await handleWorkExpectations({
      workItemId: "task.1",
      readItem: async () => item,
      readEdo: async () => Promise.reject(new Error("down")),
    });
    expect(failed.status).toBe(503);
    const missing = await handleWorkExpectations({ workItemId: "task.9", readItem: async () => null, readEdo: async () => edo });
    expect(missing).toMatchObject({ status: 404, event: { errorCode: "not_found", workItemId: "task.9" } });
  });
});
