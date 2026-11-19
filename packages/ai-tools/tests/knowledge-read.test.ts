// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/knowledge-read`
 * Purpose: core__knowledge_read reads the atom a work item's design ref names (story.0069). On candidate an agent passed
 *   `knowledge:agent-human-boundary` straight from specRefs and got totalFound 0.
 * Scope: Tool implementation over a fake capability. Does not touch a store or the network.
 * Invariants: SPEC_REF_READS_ITS_ATOM.
 * Side-effects: none
 * Links: src/tools/knowledge-read.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import type { KnowledgeCapability, KnowledgeEntry } from "../src/capabilities/knowledge";
import { createKnowledgeReadImplementation } from "../src/tools/knowledge-read";

const unused = () => {
  throw new Error("not used");
};
const atom: KnowledgeEntry = {
  id: "agent-human-boundary",
  domain: "build-agents",
  entityId: null,
  entryType: "design",
  evaluateAt: null,
  resolutionStrategy: null,
  createdAt: null,
  title: "Human-help and agent-readiness boundaries",
  content: "body",
  confidencePct: null,
  sourceType: "agent",
  sourceRef: null,
  tags: null,
};

describe("core__knowledge_read", () => {
  it("SPEC_REF_READS_ITS_ATOM: a knowledge:<id> ref and the bare id read the same atom", async () => {
    const asked: string[] = [];
    const capability: KnowledgeCapability = {
      get: async (id: string) => {
        asked.push(id);
        return id === atom.id ? atom : null;
      },
      search: unused,
      list: unused,
      write: unused,
    };
    const read = createKnowledgeReadImplementation({ knowledgeCapability: capability });
    for (const id of ["knowledge:agent-human-boundary", "agent-human-boundary"]) {
      const out = await read.execute({ id });
      expect(out.totalFound, id).toBe(1);
      expect(out.entries[0]?.title).toBe(atom.title);
    }
    expect(asked).toEqual(["agent-human-boundary", "agent-human-boundary"]);
  });
});
