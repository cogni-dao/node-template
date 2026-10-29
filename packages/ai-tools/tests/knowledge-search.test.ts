// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/knowledge-search`
 * Purpose: core__knowledge_search truncates each hit's content so one call stays small (bug.5518).
 * Scope: Tool implementation over a fake capability. Does not touch a store or the network.
 * Invariants: BOUNDED_RESULTS.
 * Side-effects: none
 * Links: src/tools/knowledge-search.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  KnowledgeCapability,
  KnowledgeEntry,
} from "../src/capabilities/knowledge";
import {
  createKnowledgeSearchImplementation,
  KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS,
  KnowledgeSearchOutputSchema,
} from "../src/tools/knowledge-search";

const unused = () => {
  throw new Error("not used");
};
const entry = (id: string, content: string): KnowledgeEntry => ({
  id,
  domain: "strategy",
  entityId: null,
  title: id,
  content,
  confidencePct: null,
  sourceType: "agent",
  sourceRef: null,
  tags: null,
  useWhen: null,
  entryType: "finding",
  evaluateAt: null,
  resolutionStrategy: null,
  createdAt: null,
});

describe("core__knowledge_search", () => {
  it("BOUNDED_RESULTS: truncates long content with an ellipsis, leaves short content intact", async () => {
    const capability: KnowledgeCapability = {
      search: async () => [
        entry("big", "x".repeat(680_000)),
        entry("small", "short"),
      ],
      list: unused,
      get: unused,
      write: unused,
    };
    const out = await createKnowledgeSearchImplementation({
      knowledgeCapability: capability,
    }).execute({ domain: "strategy", query: "decision" });

    expect(KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS).toBe(1500);
    expect(out.results[0]?.content).toBe(`${"x".repeat(1500)}…`);
    expect(out.results[1]?.content).toBe("short");
    expect(out.totalFound).toBe(2);
  });

  it("ENVELOPE: carries every KnowledgeEntry field through execute AND validateOutput", async () => {
    const full: KnowledgeEntry = {
      id: "goal-x",
      domain: "strategy",
      entityId: "ent-1",
      title: "A goal",
      content: "body",
      useWhen: "when planning",
      entryType: "goal",
      confidencePct: 80,
      sourceType: "human",
      sourceRef: "https://example.com/src",
      tags: ["a", "b"],
      evaluateAt: "2026-12-31T00:00:00.000Z",
      resolutionStrategy: "metric:kpi",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const capability: KnowledgeCapability = {
      search: async () => [full],
      list: unused,
      get: unused,
      write: unused,
    };
    const out = await createKnowledgeSearchImplementation({
      knowledgeCapability: capability,
      nodePublicOrigin: "https://node.example",
    }).execute({ domain: "strategy", query: "goal" });
    const parsed = KnowledgeSearchOutputSchema.parse(out);
    expect(parsed.results[0]).toEqual({
      ...full,
      sourceUrl: "https://node.example/knowledge/goal-x",
    });
    // No envelope field is dropped: every KnowledgeEntry key survives the contract parse.
    expect(Object.keys(parsed.results[0] ?? {})).toEqual(
      expect.arrayContaining(Object.keys(full))
    );
  });

  it("NO_MODEL_SELECTED_HOST: a rogue capability sourceUrl never survives without a trusted origin", async () => {
    const capability: KnowledgeCapability = {
      search: async () => [
        {
          ...entry("e", "x"),
          sourceUrl: "https://untrusted.example/wrong",
        } as KnowledgeEntry,
      ],
      list: unused,
      get: unused,
      write: unused,
    };
    const out = await createKnowledgeSearchImplementation({
      knowledgeCapability: capability,
    }).execute({ domain: "strategy", query: "x" });
    expect(out.results[0]).not.toHaveProperty("sourceUrl");
    expect(out.results[0]?.sourceUrlUnavailable).toBe(true);
  });
});
