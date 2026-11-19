// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/knowledge-usage/knowledge-read-counter`
 * Purpose: Guards the counter's contracts (story.0061): writes grow with distinct keys, never with read volume, even
 *   when a caller invents missing ids; and a failing database never reaches the knowledge read that was counted.
 * @internal
 */

import type { Database } from "@cogni/db-client";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  INVALID_ATOM_KEY,
  MISSED_IDS_PER_PRINCIPAL_DAY,
  OVERFLOW_ATOM_KEY,
  PostgresKnowledgeReadCounter,
} from "@/adapters/server/knowledge-usage/knowledge-read-counter.adapter";
import type { KnowledgeRead } from "@/ports";

const read = (atomId: string, outcome: "ok" | "fail" = "ok"): KnowledgeRead => ({
  atomId,
  outcome,
  principalId: "agent-1",
  principalClass: "external_agent",
});

function fakeDb(fail = false) {
  const statements: Array<Array<Record<string, unknown>>> = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        execute: async () => undefined,
        insert: () => ({
          values: (rows: Array<Record<string, unknown>>) => ({
            onConflictDoUpdate: async () => {
              statements.push(rows);
              if (fail) throw new Error("db down");
            },
          }),
        }),
      }),
  } as unknown as Database;
  return { db, statements };
}

const fixedNow = () => new Date("2026-11-18T12:00:00Z");

describe("PostgresKnowledgeReadCounter", () => {
  it("folds any number of reads of one key into one row in one statement", async () => {
    const { db, statements } = fakeDb();
    const counter = new PostgresKnowledgeReadCounter(db, pino({ level: "silent" }), fixedNow);

    for (let i = 0; i < 1_000; i += 1) counter.count(read("b"));
    for (let i = 0; i < 10; i += 1) counter.count(read("a", "fail"));
    await counter.flush();

    expect(statements).toHaveLength(1);
    expect(statements[0]).toEqual([
      expect.objectContaining({ day: "2026-11-18", atomId: "a", okCount: 0, failCount: 10 }),
      expect.objectContaining({ day: "2026-11-18", atomId: "b", okCount: 1_000, failCount: 0 }),
    ]);
  });

  it("bounds the keys a caller can create with invented missing ids", async () => {
    const { db, statements } = fakeDb();
    const counter = new PostgresKnowledgeReadCounter(db, pino({ level: "silent" }), fixedNow);

    for (let i = 0; i < 1_000; i += 1) counter.count(read(`made-up-${i}`, "fail"));
    counter.count(read("../../etc/passwd", "fail"));
    await counter.flush();

    const keys = (statements[0] ?? []).map((row) => row.atomId);
    expect(keys).toHaveLength(MISSED_IDS_PER_PRINCIPAL_DAY + 2);
    expect(keys).toContain(OVERFLOW_ATOM_KEY);
    expect(keys).toContain(INVALID_ATOM_KEY);
  });

  it("never surfaces a failed flush and logs it", async () => {
    const { db } = fakeDb(true);
    const log = pino({ level: "silent" });
    const info = vi.spyOn(log, "info");
    const counter = new PostgresKnowledgeReadCounter(db, log, fixedNow);

    expect(() => counter.count(read("a"))).not.toThrow();
    await expect(counter.flush()).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "knowledge.read_count_write_failed", reason: "flush_failed", reads: 1 }),
      expect.anything()
    );
  });
});
