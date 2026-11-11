// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/mission/catalog`
 * Purpose: Validate the published node catalog and the createMissionGraph factory.
 * Scope: Catalog structure + factory validation. Does NOT invoke graphs with LLM.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: entries exist in catalog
 *   - FACTORY_SEAM: createMissionGraph requires systemPrompt
 * Side-effects: none
 * Links: catalog.ts, story.0028
 * @internal
 */

import { VCS_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGGRAPH_GRAPH_ID,
  LANGGRAPH_CATALOG,
  LANGGRAPH_GRAPH_IDS,
  NODE_LANGGRAPH_CATALOG,
} from "../../../src/catalog";
import { COGNI_DECIDE_TOOL_IDS } from "../../../src/graphs/mission/cogni-decide";
import { createMissionGraph } from "../../../src/graphs/mission/graph";

describe("published node catalog", () => {
  it("gives every entry a unique display name and its namespaced graph id", () => {
    const names = Object.values(NODE_LANGGRAPH_CATALOG).map(
      (entry) => entry.displayName,
    );
    expect(new Set(names).size).toBe(names.length);
    for (const key of Object.keys(NODE_LANGGRAPH_CATALOG))
      expect(LANGGRAPH_GRAPH_IDS[key as keyof typeof LANGGRAPH_GRAPH_IDS]).toBe(
        `langgraph:${key}`,
      );
  });

  it("defaults to cogni", () => {
    expect(DEFAULT_LANGGRAPH_GRAPH_ID).toBe("langgraph:cogni");
  });

  it("cogni's catalog prompt lists every catalog workflow", () => {
    const prompt = NODE_LANGGRAPH_CATALOG.cogni.systemPrompt;
    const keys = Object.keys(NODE_LANGGRAPH_CATALOG);
    for (const key of keys) expect(prompt).toContain(`"id":"langgraph:${key}"`);
    expect(prompt.match(/"id":"langgraph:/g)).toHaveLength(keys.length);
  });

  it("work-prioritizer (mission loop) runs on every node, bound to the common Cogni factory (reads + triage writer)", () => {
    const entry = LANGGRAPH_CATALOG["work-prioritizer"];
    expect(entry).toBeDefined();
    // Powered by the shared Cogni engine (program "work-review" via createMissionGraph).
    expect(entry?.graphFactory).toBe(createMissionGraph);
    expect(entry?.program).toBe("work-review");
    expect(entry?.systemPrompt).toBeDefined();
    expect(entry?.toolIds).toEqual(COGNI_DECIDE_TOOL_IDS);
    expect(entry?.report).toEqual({ event: "ai.work_prioritizer.cycle" });
    expect(LANGGRAPH_GRAPH_IDS["work-prioritizer"]).toBe(
      "langgraph:work-prioritizer",
    );
  });

  it("no node-runtime graph needs an operator-only VCS tool", () => {
    const vcs = new Set(VCS_TOOL_BUNDLE.map((t) => t.contract.name));
    for (const [name, entry] of Object.entries(LANGGRAPH_CATALOG)) {
      for (const id of entry.toolIds) {
        expect(vcs.has(id), `${name} → ${id}`).toBe(false);
      }
    }
  });
});

describe("createMissionGraph", () => {
  it("throws when systemPrompt is not provided", () => {
    const fakeOpts = {
      llm: {} as never,
      tools: [],
    };
    expect(() => createMissionGraph(fakeOpts)).toThrow(
      "createMissionGraph requires systemPrompt",
    );
  });
});
