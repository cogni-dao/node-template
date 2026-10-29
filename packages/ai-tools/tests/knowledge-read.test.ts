// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/knowledge-read`
 * Purpose: core__knowledge_read carries the full knowledge envelope in get and list modes (agent-tool-context-envelope).
 * Scope: Tool implementation over a fake capability. Does not touch a store or the network.
 * Invariants: ENVELOPE_COMPLETE — no KnowledgeEntry field is dropped by the tool.
 * Side-effects: none
 * Links: src/tools/knowledge-read.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type {
  KnowledgeCapability,
  KnowledgeEntry,
} from "../src/capabilities/knowledge";
import { KnowledgeEntrySchema } from "../src/capabilities/knowledge";
import {
  createKnowledgeReadImplementation,
  KnowledgeReadEntrySchema,
  KnowledgeReadOutputSchema,
} from "../src/tools/knowledge-read";

const unused = () => {
  throw new Error("not used");
};

const full: KnowledgeEntry = {
  id: "hyp-1",
  domain: "strategy",
  entityId: "ent-1",
  title: "A hypothesis",
  content: "body",
  useWhen: "when deciding",
  entryType: "hypothesis",
  confidencePct: 30,
  sourceType: "agent",
  sourceRef: null,
  tags: ["t"],
  evaluateAt: "2026-12-31T00:00:00.000Z",
  resolutionStrategy: "manual",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const capability: KnowledgeCapability = {
  search: unused,
  list: async () => [full],
  get: async () => full,
  write: unused,
};

describe("core__knowledge_read envelope", () => {
  it("the item schema IS the shared envelope (same keys as KnowledgeEntry)", () => {
    expect(Object.keys(KnowledgeReadEntrySchema.shape).sort()).toEqual(
      Object.keys(KnowledgeEntrySchema.shape).sort()
    );
    expect(Object.keys(full).sort()).toEqual(
      Object.keys(KnowledgeEntrySchema.shape).sort()
    );
  });

  it("get mode carries every field through execute AND validateOutput", async () => {
    const out = await createKnowledgeReadImplementation({
      knowledgeCapability: capability,
    }).execute({ id: "hyp-1" });
    expect(KnowledgeReadOutputSchema.parse(out).entries).toEqual([full]);
  });

  it("list mode carries every field through execute AND validateOutput", async () => {
    const out = await createKnowledgeReadImplementation({
      knowledgeCapability: capability,
    }).execute({ domain: "strategy" });
    expect(KnowledgeReadOutputSchema.parse(out).entries).toEqual([full]);
    expect(out.totalFound).toBe(1);
  });
});
