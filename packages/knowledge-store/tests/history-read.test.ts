// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/history-read`
 * Purpose: Pins the failure log of the history handler: database error code and bounded single-line message (bug.0025).
 * Scope: `readKnowledgeHistory` over a fake structural port. No database.
 * Side-effects: none
 * Links: bug.0025, ../src/domain/history-read.ts
 */

import { describe, expect, it } from "vitest";

import { readKnowledgeHistory } from "../src/domain/history-read.js";

describe("readKnowledgeHistory failure log", () => {
  it("503: logs the database error code and a bounded single-line message", async () => {
    const dbError = Object.assign(
      new Error(`relation missing\r\n${"x".repeat(400)}`),
      { name: "PostgresError", code: "42P01" }
    );
    const result = await readKnowledgeHistory(
      {
        knowledgeExists: async () => true,
        history: async () => {
          throw dbError;
        },
      },
      "k-1"
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "history_unavailable" });
    expect(result.log.errorName).toBe("PostgresError");
    expect(result.log.dbCode).toBe("42P01");
    expect(result.log.errorMessage).toHaveLength(300);
    expect(result.log.errorMessage).not.toMatch(/[\r\n]/);
    expect(result.log.errorMessage?.startsWith("relation missing ")).toBe(true);
  });

  it("503: an error without a code logs no dbCode", async () => {
    const result = await readKnowledgeHistory(
      {
        knowledgeExists: async () => true,
        history: async () => {
          throw new TypeError("boom");
        },
      },
      "k-1"
    );
    expect(result.log.dbCode).toBeUndefined();
    expect(result.log.errorMessage).toBe("boom");
  });
});
