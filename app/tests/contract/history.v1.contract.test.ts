// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/history.v1.contract`
 * Purpose: Pins ONE_HISTORY_SHAPE across the two packages that own the history schemas (story.0023).
 * Scope: Pure schema comparison plus the knowledge handler's status/body/log. No HTTP, no database.
 * Invariants:
 *   - ONE_HISTORY_SHAPE: `@cogni-dao/work-items` and `@cogni-dao/knowledge-store/contracts` emit identical JSON schemas for the history output.
 *   - node-contracts re-exports the package schemas; it declares none of its own.
 *   - The knowledge handler never throws: a missing entry is 404, a port without history or a failed read is 503.
 * Side-effects: none
 * Links: packages/work-items/src/history-contract.ts, packages/knowledge-store/src/contracts.ts, hub change-history-fleet-adoption
 * @internal
 */

import { readKnowledgeHistory } from "@cogni/knowledge-store";
import {
  HistoryOutputSchema as KnowledgeOutputSchema,
  knowledgeHistoryOperation,
} from "@cogni/knowledge-store/contracts";
import {
  HistoryOutputSchema as NodeOutputSchema,
  knowledgeHistoryOperation as nodeKnowledgeOperation,
  workItemsHistoryOperation as nodeWorkItemsOperation,
} from "@cogni/node-contracts";
import {
  HistoryOutputSchema as WorkItemsOutputSchema,
  workItemsHistoryOperation,
} from "@cogni/work-items";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const entry = (reason: string | null) => ({
  version: "abc",
  commit: "abc123",
  at: "2026-11-07T00:00:00.000Z",
  actor: null,
  reason,
  cites: [],
  changed: ["title"],
  diff: { title: { before: "a", after: "b", truncated: false } },
});

describe("history schemas", () => {
  it("work items and knowledge declare one item shape", () => {
    expect(z.toJSONSchema(KnowledgeOutputSchema)).toEqual(
      z.toJSONSchema(WorkItemsOutputSchema)
    );
  });

  it("node-contracts re-exports the package operations", () => {
    expect(nodeWorkItemsOperation).toBe(workItemsHistoryOperation);
    expect(nodeKnowledgeOperation).toBe(knowledgeHistoryOperation);
    expect(z.toJSONSchema(NodeOutputSchema)).toEqual(
      z.toJSONSchema(WorkItemsOutputSchema)
    );
  });
});

describe("readKnowledgeHistory", () => {
  it("200: parsed items with version and reason counts", async () => {
    const result = await readKnowledgeHistory(
      {
        knowledgeExists: async () => true,
        history: async () => [entry("why"), entry(null)],
      },
      "k-1"
    );
    expect(result.status).toBe(200);
    expect(result.log).toEqual({
      event: "knowledge.history_read",
      status: 200,
      outcome: "success",
      versionCount: 2,
      reasonCount: 1,
    });
  });

  it("404: a missing entry reports not_found", async () => {
    const result = await readKnowledgeHistory(
      { knowledgeExists: async () => false, history: async () => [] },
      "k-9"
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "not found" });
    expect(result.log.errorCode).toBe("not_found");
  });

  it("503: a port without history is unavailable and carries no error name", async () => {
    for (const port of [{ knowledgeExists: async () => true }, undefined]) {
      const result = await readKnowledgeHistory(port, "k-1");
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: "history_unavailable" });
      expect(result.log.errorName).toBeUndefined();
    }
  });

  it("503: a failed read never throws", async () => {
    const result = await readKnowledgeHistory(
      {
        knowledgeExists: async () => true,
        history: async () => {
          throw new TypeError("boom");
        },
      },
      "k-1"
    );
    expect(result.status).toBe(503);
    expect(result.log.errorName).toBe("TypeError");
  });
});
