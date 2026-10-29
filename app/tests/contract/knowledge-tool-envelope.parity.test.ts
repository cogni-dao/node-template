// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/knowledge-tool-envelope.parity`
 * Purpose: Prove the knowledge agent tools (`core__knowledge_read`, `core__knowledge_search`)
 *   return the same context envelope an external agent reads from GET /api/v1/knowledge
 *   (agent-tool-context-envelope), end to end from a store `Knowledge` row.
 * Scope: store row -> `toKnowledgeEntry` -> tool output item -> parsed by node-contracts
 *   `KnowledgeRowSchema`. ai-tools runs zod 3 and node-contracts zod 4, so the zod-4 schema
 *   parses the tool's plain output as DATA and the two majors never clash. Does not test HTTP.
 * Invariants:
 *   - ENVELOPE_PARITY: every `KnowledgeRow` field is carried by both tools (no exclusions),
 *     with the wire value types.
 *   - ENVELOPE_BY_CONSTRUCTION: a new `KnowledgeRow` field fails here until the tool carries it.
 * Side-effects: none
 * Links: packages/knowledge-store/src/knowledge-entry.ts, packages/ai-tools/src/capabilities/knowledge.ts
 * @internal
 */

import {
  createKnowledgeReadImplementation,
  createKnowledgeSearchImplementation,
  KnowledgeReadEntrySchema,
  KnowledgeSearchResultSchema,
  type KnowledgeCapability,
} from "@cogni/ai-tools";
import {
  createKnowledgeCapability,
  type Knowledge,
  type KnowledgeStorePort,
} from "@cogni/knowledge-store";
import { KnowledgeRowSchema, type KnowledgeRow } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const wireKeys = Object.keys(KnowledgeRowSchema.shape).sort();

const row: Knowledge = {
  id: "node-template-agent-orientation",
  domain: "meta",
  entityId: "ent-1",
  title: "Orientation",
  content: "body",
  useWhen: "any agent starts a session",
  entryType: "reference",
  confidencePct: 80,
  sourceType: "human",
  sourceRef: "https://example.com",
  tags: ["orientation"],
  evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
  resolutionStrategy: "manual",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
};

const store = {
  getKnowledge: async () => row,
  listKnowledge: async () => [row],
  searchKnowledge: async () => [row],
} as unknown as KnowledgeStorePort;
const knowledgeCapability: KnowledgeCapability =
  createKnowledgeCapability(store);

describe("knowledge tool envelope parity (agent-tool-context-envelope)", () => {
  it("both tool item schemas carry every KnowledgeRow field (no exclusions, no ledger)", () => {
    const readKeys = Object.keys(KnowledgeReadEntrySchema.shape);
    const searchKeys = Object.keys(KnowledgeSearchResultSchema.shape);
    expect(readKeys).toEqual(expect.arrayContaining(wireKeys));
    expect(searchKeys).toEqual(expect.arrayContaining(wireKeys));
  });

  it("core__knowledge_read items parse as the wire KnowledgeRow, nothing dropped", async () => {
    const impl = createKnowledgeReadImplementation({ knowledgeCapability });
    for (const out of [
      await impl.execute({ id: row.id }),
      await impl.execute({ domain: "meta" }),
    ]) {
      const item = out.entries[0];
      expect(item).toBeDefined();
      // Type-level: the tool item is assignable to the wire DTO.
      const asWire: KnowledgeRow = item as NonNullable<typeof item>;
      expect(KnowledgeRowSchema.parse(asWire)).toEqual(asWire);
      expect(Object.keys(asWire).sort()).toEqual(wireKeys);
      expect(asWire).toMatchObject({
        useWhen: "any agent starts a session",
        entryType: "reference",
        evaluateAt: "2026-12-31T00:00:00.000Z",
        resolutionStrategy: "manual",
        createdAt: "2026-10-01T00:00:00.000Z",
      });
    }
  });

  it("core__knowledge_search items carry the wire envelope plus only provenance extras", async () => {
    const out = await createKnowledgeSearchImplementation({
      knowledgeCapability,
      nodePublicOrigin: "https://node.example",
    }).execute({ domain: "meta", query: "orientation" });
    const { sourceUrl, sourceUrlUnavailable, ...envelope } = out.results[0] ?? {
      id: "",
    };
    expect(sourceUrl).toBe(`https://node.example/knowledge/${row.id}`);
    expect(sourceUrlUnavailable).toBeUndefined();
    const asWire: KnowledgeRow = envelope as KnowledgeRow;
    expect(KnowledgeRowSchema.parse(asWire)).toEqual(asWire);
    expect(Object.keys(asWire).sort()).toEqual(wireKeys);
  });
});
