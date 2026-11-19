// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/knowledge-usage/cite-pair-recorder`
 * Purpose: Guards story.0061's cite pairs: a patch's repeated cites become one row per atom, and a failing database
 *   never reaches the patch that already committed.
 * @internal
 */

import type { Database } from "@cogni/db-client";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { PostgresCitePairRecorder } from "@/adapters/server/knowledge-usage/cite-pair-recorder.adapter";

function fakeDb(fail = false) {
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        execute: async () => undefined,
        insert: () => ({
          values: (rows: Array<Record<string, unknown>>) => ({
            onConflictDoNothing: async () => {
              inserts.push(rows);
              if (fail) throw new Error("db down");
            },
          }),
        }),
      }),
  } as unknown as Database;
  return { db, inserts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PostgresCitePairRecorder", () => {
  it("writes one row per distinct cited atom, pinned to the patch's revision", async () => {
    const { db, inserts } = fakeDb();
    new PostgresCitePairRecorder(db, pino({ level: "silent" })).record("story.0061", "33", [{ id: "b" }, { id: "a" }, { id: "b" }]);
    await settle();
    expect(inserts).toEqual([
      [
        { atomId: "a", workItemId: "story.0061", firstItemRevision: 33 },
        { atomId: "b", workItemId: "story.0061", firstItemRevision: 33 },
      ],
    ]);
  });

  it("never throws into the patch and logs a failed insert", async () => {
    const { db } = fakeDb(true);
    const log = pino({ level: "silent" });
    const info = vi.spyOn(log, "info");
    const recorder = new PostgresCitePairRecorder(db, log);
    expect(() => recorder.record("story.0061", "33", [{ id: "a" }])).not.toThrow();
    await settle();
    await settle();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "knowledge.cite_pairs_write_failed", reason: "insert_failed", pairs: 1 }),
      expect.anything()
    );
  });
});
