// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Work-author classifier over the work ledger: validated items by class. */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { readValidatedByAuthor } from "@/adapters/server/metrics/ledger.source";

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
  const queries: string[] = [];
  const sql = {
    unsafe(text: string) {
      queries.push(text);
      const p = Promise.resolve().then(() => answer(text));
      return Object.assign(p, { cancel: () => undefined });
    },
  } as unknown as Sql;
  return { sql, queries };
}

const window = {
  start: "2026-11-07T00:00:00.000Z",
  end: "2026-11-14T00:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
  source(new AbortController().signal);
const AS_OF = "2026-11-14T00:00:01.000Z";
const INTERNAL = "00000000-0000-0000-0000-00000000a001";

function ledgerAnswer(opts: {
  validated: string[];
  authors: Array<{ id: string; at: string; actor: string | null }>;
}) {
  return (text: string): Row[] => {
    if (text.includes("SELECT NOW()")) return [{ as_of: AS_OF }];
    if (text.includes("agent_principals")) return [{ user_id: INTERNAL }];
    if (text.includes("to_status = 'done'"))
      return opts.validated.map((id) => ({ id }));
    if (text.includes("to_status = 'needs_merge'"))
      return opts.authors.map((a) => ({
        id: a.id,
        at: a.at,
        message:
          a.actor === null
            ? "unrelated message"
            : `work-items: patch ${a.id} by actor:${a.actor}`,
      }));
    return [];
  };
}

describe("readValidatedByAuthor", () => {
  it("classifies each validated item by its latest needs_merge actor", async () => {
    const { sql } = fakeSql(
      ledgerAnswer({
        validated: ["task.0001", "task.0002", "bug.0003", "task.0004"],
        authors: [
          { id: "task.0001", at: "2026-11-10T00:00:00Z", actor: INTERNAL },
          // An older internal author is superseded by the later external one.
          { id: "task.0002", at: "2026-11-08T00:00:00Z", actor: INTERNAL },
          { id: "task.0002", at: "2026-11-09T00:00:00Z", actor: "ext-1" },
          { id: "bug.0003", at: "2026-11-09T00:00:00Z", actor: null },
          // task.0004 has no needs_merge transition at all.
        ],
      }),
    );
    const counts: Record<string, number> = {
      all: 4,
      internal: 1,
      "non-internal": 1,
      unclassified: 2,
    };
    for (const [author, want] of Object.entries(counts)) {
      const sample = await readValidatedByAuthor(
        sql,
        sql,
        { author: author as never, mode: "count" },
        window,
        read,
      );
      expect(sample.value, author).toBe(want);
      expect(sample.unit).toBe("items");
      expect(sample.complete).toBe(true);
      expect(sample.sourceWatermarks[0]?.asOf).toBe(AS_OF);
    }
  });

  it("counts a bouncing item once and computes shares against the total", async () => {
    const { sql } = fakeSql(
      ledgerAnswer({
        validated: ["task.0001", "task.0001", "task.0005"],
        authors: [
          { id: "task.0001", at: "2026-11-10T00:00:00Z", actor: INTERNAL },
          { id: "task.0005", at: "2026-11-10T00:00:00Z", actor: "ext-9" },
        ],
      }),
    );
    const sample = await readValidatedByAuthor(
      sql,
      sql,
      { author: "internal", mode: "share" },
      window,
      read,
    );
    expect(sample.value).toBeCloseTo(1 / 2);
    expect(sample.unit).toBe("ratio");
  });

  it("an empty window is a zero denominator for shares and a plain zero count", async () => {
    const { sql, queries } = fakeSql(
      ledgerAnswer({ validated: [], authors: [] }),
    );
    const share = await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "share" },
      window,
      read,
    );
    expect(share.complete).toBe(false);
    expect(share.reason).toBe("zero_denominator");
    const count = await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "count" },
      window,
      read,
    );
    expect(count.value).toBe(0);
    expect(count.complete).toBe(true);
    // No author query runs when the window holds no validated items.
    expect(queries.some((q) => q.includes("needs_merge"))).toBe(false);
  });

  it("bounds the validated read to the window edges", async () => {
    const { sql, queries } = fakeSql(
      ledgerAnswer({ validated: [], authors: [] }),
    );
    await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "count" },
      window,
      read,
    );
    const validatedQuery = queries.find((q) => q.includes("to_status = 'done'"));
    expect(validatedQuery).toContain(
      "d.to_commit_date >= '2026-11-07T00:00:00.000Z'",
    );
    expect(validatedQuery).toContain(
      "d.to_commit_date < '2026-11-14T00:00:00.000Z'",
    );
  });

  it("rejects a window edge that is not an instant", async () => {
    const { sql } = fakeSql(ledgerAnswer({ validated: [], authors: [] }));
    await expect(
      readValidatedByAuthor(
        sql,
        sql,
        { author: "all", mode: "count" },
        { start: "not a date", end: window.end },
        read,
      ),
    ).rejects.toThrow("invalid_window");
  });
});
