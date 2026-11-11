// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/history-shape`
 * Purpose: Pins that a knowledge history version carries `cites: []`, the work-items shape (task.0086).
 * Scope: `shapeKnowledgeHistory` and `HistoryEntrySchema` over fixtures. No database.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";

import { HistoryEntrySchema } from "../src/contracts.js";
import { shapeKnowledgeHistory } from "../src/domain/history.js";

describe("knowledge history item shape", () => {
  it("returns cites: [] and parses under the shared schema", () => {
    const [entry] = shapeKnowledgeHistory([
      {
        to_commit: "c1",
        to_commit_date: "2026-11-11T00:00:00Z",
        diff_type: "modified",
        message: null,
        committer: "root",
        contribution_message: "why",
        contribution_principal: "agent-a",
        from_title: "a",
        to_title: "b",
      },
    ]);
    expect(entry?.cites).toEqual([]);
    expect(entry?.reason).toBe("why");
    expect(HistoryEntrySchema.safeParse(entry).success).toBe(true);
  });
});
