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
import { cutHistoryPage, HistoryCursorUnknownError, type HistoryEntry } from "../src/history.js";

const version = (reason: string | null): HistoryEntry => ({
  version: "2",
  commit: "abc",
  at: "2026-11-07T00:00:00.000Z",
  actor: "actor:1",
  reason,
  cites: [],
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
  const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
  it.each([
    ["one line", true],
    ["two\nlines", true],
    ["\n", false],
    ["", false],
    [words(25), true],
    [words(26), false],
    ["x".repeat(240), true],
    ["x".repeat(241), false],
    ["a\u0000b", false],
  ])("%j -> %s", (value, ok) => {
    expect(ChangeReasonSchema.safeParse(value).success).toBe(ok);
  });
});

describe("history refs view (story.0058)", () => {
  const at = (n: number): HistoryEntry => ({ ...version(`reason ${n}`), version: String(n), commit: `c${n}` });

  it("cutHistoryPage: cursor is the last kept entry when more remain, the oldest raw row at the raw cap, else null", () => {
    const entries = Array.from({ length: 25 }, (_, i) => at(25 - i));
    const raw = entries.map((e) => ({ to_commit: e.commit }));
    expect(cutHistoryPage(entries, raw, 60, 20)).toMatchObject({ nextCursor: "c6" });
    expect(cutHistoryPage(entries, raw, 60, 20).entries).toHaveLength(20);
    // The raw read hit its cap but shaped to fewer than a page: continue below the oldest raw row.
    const capped = Array.from({ length: 60 }, (_, i) => ({ to_commit: `r${i}` }));
    expect(cutHistoryPage(entries.slice(0, 7), capped, 60, 20)).toMatchObject({ nextCursor: "r59" });
    expect(cutHistoryPage(entries.slice(0, 7), raw.slice(0, 7), 60, 20)).toMatchObject({ nextCursor: null });
  });

  const store = (pages: Record<string, { entries: HistoryEntry[]; nextCursor: string | null }>) => ({
    get: async () => ({ id: "task.0001" }),
    history: async () => [at(1)],
    historyPage: async (_id: unknown, options: { cursor?: string | undefined }) => {
      const page = pages[options.cursor ?? ""];
      if (!page) throw new HistoryCursorUnknownError(options.cursor ?? "");
      return page;
    },
  });

  it("returns refs without diff and pages by commit; the default answer is unchanged", async () => {
    const s = store({ "": { entries: [at(2)], nextCursor: "c2" }, c2: { entries: [at(1)], nextCursor: null } });
    const first = await readWorkItemHistory(s, "task.0001", { view: "refs" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ refs: [expect.not.objectContaining({ diff: expect.anything() })], nextCursor: "c2" });
    expect((first.body as { refs: { commit: string }[] }).refs[0]?.commit).toBe("c2");
    const older = await readWorkItemHistory(s, "task.0001", { view: "refs", cursor: "c2" });
    expect(older.body).toMatchObject({ refs: [{ commit: "c1" }], nextCursor: null });
    expect((await readWorkItemHistory(s, "task.0001")).body).toMatchObject({ items: [{ diff: {} }] });
  });

  it("refuses a foreign cursor, an unknown view and a cursor without view=refs with 400 invalid_input", async () => {
    const s = store({ "": { entries: [], nextCursor: null } });
    for (const query of [{ view: "refs", cursor: "zz" }, { view: "full" }, { cursor: "c1" }, { view: "refs", cursor: "C!" }]) {
      const refused = await readWorkItemHistory(s, "task.0001", query);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ errorCode: "invalid_input" });
    }
  });
});
