// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/knowledge-entry`
 * Purpose: toKnowledgeEntry maps the store's Knowledge row to the full tool envelope and the capability read paths surface it.
 * Scope: Pure mapper + stub-port read passthrough. Does not call Doltgres or HTTP.
 * Invariants: ENVELOPE_BY_CONSTRUCTION, WIRE_DEFAULTS
 * Side-effects: none
 * Links: packages/knowledge-store/src/knowledge-entry.ts
 * @internal
 */

import { KnowledgeEntrySchema } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import { createKnowledgeCapability } from "../src/capability.js";
import type { Knowledge } from "../src/domain/schemas.js";
import { toKnowledgeEntry } from "../src/knowledge-entry.js";
import type { KnowledgeStorePort } from "../src/port/knowledge-store.port.js";

const row: Knowledge = {
  id: "goal-1",
  domain: "strategy",
  entityId: "ent",
  title: "t",
  content: "c",
  useWhen: "when planning",
  entryType: "goal",
  confidencePct: 80,
  sourceType: "human",
  sourceRef: "ref",
  tags: ["x"],
  evaluateAt: new Date("2026-12-31T00:00:00.000Z"),
  resolutionStrategy: "metric:kpi",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
};

describe("toKnowledgeEntry", () => {
  it("carries every envelope field, Dates as ISO strings", () => {
    expect(toKnowledgeEntry(row)).toEqual({
      ...row,
      evaluateAt: "2026-12-31T00:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("emits exactly the shared envelope's keys (no more, no fewer)", () => {
    expect(Object.keys(toKnowledgeEntry(row)).sort()).toEqual(
      Object.keys(KnowledgeEntrySchema.shape).sort()
    );
  });

  it("applies wire defaults for absent columns", () => {
    const minimal: Knowledge = {
      id: "a",
      domain: "meta",
      title: "t",
      content: "c",
      sourceType: "agent",
    };
    expect(toKnowledgeEntry(minimal)).toEqual({
      id: "a",
      domain: "meta",
      entityId: null,
      title: "t",
      content: "c",
      useWhen: null,
      entryType: "finding",
      confidencePct: null,
      sourceType: "agent",
      sourceRef: null,
      tags: null,
      evaluateAt: null,
      resolutionStrategy: null,
      createdAt: null,
    });
  });

  it("capability get/list/search surface the full envelope", async () => {
    const port = {
      getKnowledge: async () => row,
      listKnowledge: async () => [row],
      searchKnowledge: async () => [row],
    } as unknown as KnowledgeStorePort;
    const cap = createKnowledgeCapability(port);
    const expected = toKnowledgeEntry(row);
    expect(await cap.get("goal-1")).toEqual(expected);
    expect(await cap.list({ domain: "strategy" })).toEqual([expected]);
    expect(await cap.search({ domain: "strategy", query: "t" })).toEqual([
      expected,
    ]);
  });
});
