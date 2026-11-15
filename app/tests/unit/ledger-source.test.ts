// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Work-author classifier over the work ledger: validated items by class. */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  LEDGER_MAX_ROWS,
  readValidatedByAuthor,
} from "@/adapters/server/metrics/ledger.source";

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
  const queries: string[] = [];
  const cancel = vi.fn();
  const sql = {
    unsafe(text: string) {
      queries.push(text);
      const p = Promise.resolve().then(() => answer(text));
      return Object.assign(p, { cancel });
    },
  } as unknown as Sql;
  return { sql, queries, cancel };
}

const window = {
  start: "2026-11-07T00:00:00.000Z",
  end: "2026-11-14T00:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
  source(new AbortController().signal);
const AS_OF = "2026-11-14T00:00:01.000Z";
const INTERNAL = "00000000-0000-0000-0000-00000000a001";

type AuthorRow = { id: string; at: string; actor: string | null };
function ledgerAnswer(opts: { validated: string[]; authors: AuthorRow[] }) {
  return (text: string): Row[] => {
    if (text.includes("SELECT NOW()")) return [{ as_of: AS_OF }];
    if (text.includes("agent_principals")) return [{ user_id: INTERNAL }];
    if (text.includes("to_status = 'done'"))
      return opts.validated.map((id) => ({ id }));
    if (text.includes("to_status = 'needs_merge'"))
      return [...opts.authors]
        .sort((a, b) => (a.at < b.at ? -1 : 1))
        .map((a) => ({
          id: a.id,
          at: a.at,
          message:
            a.actor === null
              ? "Merge branch 'work-items-main' into main"
              : `work-items: patch ${a.id} by actor:${a.actor}`,
        }));
    return [];
  };
}

describe("readValidatedByAuthor", () => {
  it("classifies each validated item by its latest authored needs_merge actor", async () => {
    const { sql } = fakeSql(
      ledgerAnswer({
        validated: ["task.0001", "task.0002", "bug.0003", "task.0004"],
        authors: [
          { id: "task.0001", at: "2026-11-10 00:00:00.000", actor: INTERNAL },
          // A later authored transition supersedes the earlier internal one.
          { id: "task.0002", at: "2026-11-09 00:00:00.000", actor: "ext-1" },
          { id: "task.0002", at: "2026-11-08 00:00:00.000", actor: INTERNAL },
          { id: "bug.0003", at: "2026-11-09 00:00:00.000", actor: null },
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

  it("a merge-commit repeat never overwrites the real author", async () => {
    const { sql } = fakeSql(
      ledgerAnswer({
        validated: ["task.0010"],
        authors: [
          { id: "task.0010", at: "2026-11-10 00:00:00.000", actor: INTERNAL },
          // Later merge repeat with no actor must not supersede.
          { id: "task.0010", at: "2026-11-10 00:00:05.000", actor: null },
        ],
      }),
    );
    const sample = await readValidatedByAuthor(
      sql,
      sql,
      { author: "internal", mode: "count" },
      window,
      read,
    );
    expect(sample.value).toBe(1);
  });

  it("counts a bouncing item once and computes shares against the total", async () => {
    const { sql } = fakeSql(
      ledgerAnswer({
        validated: ["task.0001", "task.0001", "task.0005"],
        authors: [
          { id: "task.0001", at: "2026-11-10 00:00:00.000", actor: INTERNAL },
          { id: "task.0005", at: "2026-11-10 00:00:00.000", actor: "ext-9" },
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

  it("a missing clock row is incomplete in both modes", async () => {
    const answer = ledgerAnswer({ validated: ["task.0001"], authors: [] });
    const { sql } = fakeSql((text) =>
      text.includes("SELECT NOW()") ? [] : answer(text),
    );
    const count = await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "count" },
      window,
      read,
    );
    expect(count.complete).toBe(false);
    expect(count.reason).toBe("incomplete_or_invalid_source");
  });

  it("a capped read is incomplete, never silently truncated", async () => {
    const many = Array.from({ length: LEDGER_MAX_ROWS + 1 }, (_, i) => `task.${i}`);
    const { sql } = fakeSql(ledgerAnswer({ validated: many, authors: [] }));
    const sample = await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "count" },
      window,
      read,
    );
    expect(sample.complete).toBe(false);
    expect(sample.reason).toBe("incomplete_or_invalid_source");
  });

  it("bounds, filters and caps the ledger queries", async () => {
    const { sql, queries } = fakeSql(
      ledgerAnswer({
        validated: ["task.0001"],
        authors: [
          { id: "task.0001", at: "2026-11-10 00:00:00.000", actor: INTERNAL },
        ],
      }),
    );
    await readValidatedByAuthor(
      sql,
      sql,
      { author: "all", mode: "count" },
      window,
      read,
    );
    const validated = queries.find((q) => q.includes("to_status = 'done'"));
    expect(validated).toContain("d.to_commit_date >= '2026-11-07 00:00:00.000'");
    expect(validated).toContain("d.to_commit_date < '2026-11-14 00:00:00.000'");
    expect(validated).toContain("IS DISTINCT FROM 'done'");
    expect(validated).toContain("from_deploy_verified IS DISTINCT FROM true");
    expect(validated).toContain('NOT LIKE \'%"test-fixture"%\'');
    expect(validated).toContain(`LIMIT ${LEDGER_MAX_ROWS + 1}`);
    const authors = queries.find((q) => q.includes("to_status = 'needs_merge'"));
    expect(authors).toContain("l.message LIKE 'work-items: %'");
    expect(authors).toContain("ORDER BY d.to_commit_date, d.to_commit");
    expect(authors).toContain(`LIMIT ${LEDGER_MAX_ROWS + 1}`);
  });

  it("an abort cancels the running query and rejects", async () => {
    const controller = new AbortController();
    const { sql, cancel } = fakeSql(() => {
      controller.abort();
      return [{ as_of: AS_OF }];
    });
    await expect(
      readValidatedByAuthor(
        sql,
        sql,
        { author: "all", mode: "count" },
        window,
        (source) => source(controller.signal),
      ),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
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
