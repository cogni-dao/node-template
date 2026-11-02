// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Native-key roundtrips and order/version mismatch rejection. */
import { describe, expect, it } from "vitest";
import { toWorkItemId } from "../../src/types.js";
import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import { independentReadPool, makeFakeDoltgresSql } from "./fake-doltgres-sql.js";
import {
  decodeCursor,
  encodeCursor,
  queryIdentity,
  type WorkItemCursor,
} from "../../src/adapters/doltgres/cursor.js";

describe("order-bound work cursor", () => {
  it.each(["1.2000000000000002", null])(
    "retains exact native numeric key %s",
    (key) => {
      const c: WorkItemCursor = {
        v: 2,
        filter: queryIdentity(),
        sortBy: "rankScore",
        sortDirection: "desc",
        key,
        id: "task.5042",
      };
      expect(decodeCursor(encodeCursor(c), undefined, queryIdentity())).toEqual(
        c,
      );
    },
  );
  it("binds normalized filters while rejecting changed filters", () => {
    const filter = queryIdentity({
      statuses: ["done", "blocked", "done"],
      rankMin: 4,
    });
    expect(queryIdentity({ statuses: ["blocked", "done"], rankMin: 4 })).toBe(
      filter,
    );
    const raw = encodeCursor({
      v: 2,
      filter,
      sortBy: "rankScore",
      sortDirection: "desc",
      key: "6",
      id: "task.0001",
    });
    expect(() =>
      decodeCursor(
        raw,
        undefined,
        queryIdentity({ statuses: ["done"], rankMin: 4 }),
      ),
    ).toThrow(/restart pagination/);
    expect(() =>
      decodeCursor(
        raw,
        undefined,
        queryIdentity({ statuses: ["done", "blocked"], rankMin: 5 }),
      ),
    ).toThrow(/restart pagination/);
  });
  it("preserves timestamp microseconds rather than a DTO Date", () => {
    const c: WorkItemCursor = {
      v: 2,
      filter: queryIdentity(),
      sortBy: "createdAt",
      sortDirection: "asc",
      key: "2026-04-30 12:00:00.123456+00",
      id: "task.5042",
    };
    expect(decodeCursor(encodeCursor(c), undefined, queryIdentity())).toEqual(
      c,
    );
  });
  it("rejects legacy, malformed and sort-mismatched cursors", () => {
    for (const raw of [
      "!!!",
      "e30",
      Buffer.from(
        JSON.stringify({
          p: 1,
          r: 2,
          ts: "2026-04-30T00:00:00.000Z",
          id: "task.5042",
        }),
      ).toString("base64url"),
    ])
      expect(() => decodeCursor(raw)).toThrow(/restart pagination/);
    const raw = encodeCursor({
      v: 2,
      filter: queryIdentity(),
      sortBy: "rankScore",
      sortDirection: "desc",
      key: "1",
      id: "task.5042",
    });
    expect(() =>
      decodeCursor(
        raw,
        { sortBy: "priority", sortDirection: "asc" },
        queryIdentity(),
      ),
    ).toThrow(/restart pagination/);
  });
});


it("applies inclusive rank and projects before the page limit", async () => {
  const sql: string[] = [];
  const reader = makeFakeDoltgresSql(() => [], sql);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), { readClient: reader });
  await adapter.list({ rankMin: 4, rankMax: 12, projectIds: [toWorkItemId("proj.a"), toWorkItemId("proj.b")], limit: 10 });
  const query = sql.find(q => q.includes("AS ordered")) ?? "";
  expect(query).toContain("project_id IN ('proj.a', 'proj.b')");
  expect(query).toContain(">= 4");
  expect(query).toContain("<= 12");
  expect(query).toContain("LIMIT 11");
  expect(query.indexOf(">= 4")).toBeLessThan(query.indexOf("LIMIT 11"));
});
