// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Native-key roundtrips and order/version mismatch rejection. */
import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  type WorkItemCursor
} from "../../src/adapters/doltgres/cursor.js";

describe("order-bound work cursor", () => {
  it.each([
    "1.2000000000000002",
    null
  ])("retains exact native numeric key %s", (key) => {
    const c: WorkItemCursor = {
      v: 1,
      sortBy: "rankScore",
      sortDirection: "desc",
      key,
      id: "task.5042"
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("preserves timestamp microseconds rather than a DTO Date", () => {
    const c: WorkItemCursor = {
      v: 1,
      sortBy: "createdAt",
      sortDirection: "asc",
      key: "2026-04-30 12:00:00.123456+00",
      id: "task.5042"
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
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
          id: "task.5042"
        })
      ).toString("base64url")
    ])
      expect(() => decodeCursor(raw)).toThrow(/restart pagination/);
    const raw = encodeCursor({
      v: 1,
      sortBy: "rankScore",
      sortDirection: "desc",
      key: "1",
      id: "task.5042"
    });
    expect(() =>
      decodeCursor(raw, { sortBy: "priority", sortDirection: "asc" })
    ).toThrow(/restart pagination/);
  });
});
