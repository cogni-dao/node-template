// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/catalog-report`
 * Purpose: The catalog-declared run report helpers every node provider calls (CatalogEntry.report).
 * Scope: Pure helpers only. Does not run a graph or touch a logger.
 * Invariants: CATALOG_REPORT_SEAM — telemetry → one `event`, samples → `sampleEvent` (≤10), stream echo in GRAPH_REPORT delimiters.
 * Side-effects: none
 * Links: src/catalog.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  graphReportDelta,
  graphReportLogFields,
  LANGGRAPH_CATALOG,
} from "../src/catalog";

describe("catalog report seam (CatalogEntry.report)", () => {
  const report = {
    event: "ai.work_prioritizer.cycle",
    sampleEvent: "ai.work_prioritizer.judge_sample",
  };

  it("the work prioritizer declares its report in the node catalog", () => {
    expect(LANGGRAPH_CATALOG["work-prioritizer"]?.report).toEqual(report);
  });

  it("logs the telemetry as `event` and each sample as `sampleEvent`", () => {
    const sample = {
      lines: ['{"id":"bug.1","harmDays":"1 day"}'],
      counts: { lines: 14, parsed: 14, withHarm: 3, withHarmDays: 1 },
    };
    expect(
      graphReportLogFields(report, "run-9", {
        telemetry: { status: "planned", decisionId: "d", edoWrites: 1 },
        samples: [sample],
      })
    ).toEqual([
      {
        event: "ai.work_prioritizer.cycle",
        runId: "run-9",
        status: "planned",
        decisionId: "d",
        edoWrites: 1,
      },
      {
        event: "ai.work_prioritizer.judge_sample",
        runId: "run-9",
        batch: 0,
        ...sample,
      },
    ]);
  });

  it("emits nothing when the output carries no report", () => {
    expect(graphReportLogFields(report, "r", undefined)).toEqual([]);
    expect(graphReportLogFields(report, "r", { content: "x" })).toEqual([]);
    expect(graphReportDelta({ content: "x" })).toBeNull();
  });

  it("echoes the telemetry as one <graph_report> delta", () => {
    expect(graphReportDelta({ telemetry: { status: "no_change" } })).toBe(
      '\n<graph_report>{"status":"no_change"}</graph_report>\n'
    );
  });
});
