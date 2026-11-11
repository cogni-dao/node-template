// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/history-read`
 * Purpose: Pins the framework-agnostic history handler: status, body and log per outcome (story.0023).
 * Scope: Fake structural stores only. No database, no web framework.
 * Invariants:
 *   - NEVER_THROWS: a store failure or a store without `history` is a 503 `history_unavailable`.
 *   - A missing item is a 404 with the item id in the message.
 *   - `log` holds counts and codes, never values.
 * Side-effects: none
 * Links: hub change-history-fleet-adoption
 * @internal
 */

import { describe, expect, it } from "vitest";

import { ChangeReasonSchema } from "../src/history-contract.js";
import { readWorkItemHistory } from "../src/history-read.js";
import type { HistoryEntry } from "../src/history.js";

const version = (reason: string | null): HistoryEntry => ({
  version: "2",
  commit: "abc",
  at: "2026-11-07T00:00:00.000Z",
  actor: "actor:1",
  reason,
  changed: ["title"],
  diff: { title: { before: "a", after: "b", truncated: false } },
});

describe("readWorkItemHistory", () => {
  it("200: returns the parsed items and counts versions and reasons", async () => {
    const result = await readWorkItemHistory(
      {
        get: async () => ({ id: "task.1" }),
        history: async () => [version("why"), version(null)],
      },
      "task.1"
    );
    expect(result.status).toBe(200);
    expect((result.body as { items: unknown[] }).items).toHaveLength(2);
    expect(result.log).toEqual({
      event: "work.items.history_read",
      status: 200,
      outcome: "success",
      versionCount: 2,
      reasonCount: 1,
    });
  });

  it("404: a missing item reports not_found", async () => {
    const result = await readWorkItemHistory(
      { get: async () => null, history: async () => [] },
      "task.9"
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "Work item not found: task.9" });
    expect(result.log).toEqual({
      event: "work.items.history_read",
      status: 404,
      outcome: "error",
      errorCode: "not_found",
    });
  });

  it("503: a store without history is unavailable", async () => {
    const result = await readWorkItemHistory(
      { get: async () => ({ id: "task.1" }) },
      "task.1"
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "history_unavailable" });
    expect(result.log).toMatchObject({
      status: 503,
      outcome: "error",
      errorCode: "history_unavailable",
      errorName: "Error",
    });
  });

  it("503: a failed read never throws", async () => {
    const result = await readWorkItemHistory(
      {
        get: async () => ({ id: "task.1" }),
        history: async () => {
          throw new TypeError("boom");
        },
      },
      "task.1"
    );
    expect(result.status).toBe(503);
    expect(result.log.errorName).toBe("TypeError");
  });

  it("503: logs the database error code and a bounded single-line message", async () => {
    const dbError = Object.assign(
      new Error(`relation missing\r\n${"x".repeat(400)}`),
      { name: "PostgresError", code: "42P01" }
    );
    const result = await readWorkItemHistory(
      {
        get: async () => ({ id: "task.1" }),
        history: async () => {
          throw dbError;
        },
      },
      "task.1"
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
    const result = await readWorkItemHistory(
      {
        get: async () => ({ id: "task.1" }),
        history: async () => {
          throw new TypeError("boom");
        },
      },
      "task.1"
    );
    expect(result.log.dbCode).toBeUndefined();
    expect(result.log.errorMessage).toBe("boom");
  });

  it("503: a row that breaks the output shape is unavailable, not a 200", async () => {
    const result = await readWorkItemHistory(
      {
        get: async () => ({ id: "task.1" }),
        history: async () => [{ version: 1 } as unknown as HistoryEntry],
      },
      "task.1"
    );
    expect(result.status).toBe(503);
  });
});

describe("ChangeReasonSchema", () => {
  it.each([
    ["one line", true],
    ["two\nlines", true],
    ["\n", false],
    ["", false],
    ["x".repeat(512), true],
    ["x".repeat(513), false],
  ])("%j -> %s", (value, ok) => {
    expect(ChangeReasonSchema.safeParse(value).success).toBe(ok);
  });
});
