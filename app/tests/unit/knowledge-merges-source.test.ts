// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Reviewed-merge share over knowledge_contributions: counts, window, unknown states. */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { readKnowledgeMerges } from "@/adapters/server/metrics/knowledge-merges.source";

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
const signal = () => new AbortController().signal;
const counted = {
  as_of: "2026-11-14T00:00:01.000Z",
  merged: 4,
  reviewed: 3,
  unresolved: 0,
};

describe("readKnowledgeMerges", () => {
  it("reads one static statement with the half-open resolved_at window in the text", async () => {
    const { sql, queries } = fakeSql(() => [counted]);
    await readKnowledgeMerges(sql, "share", window, signal());
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(
      `state = 'merged' AND resolved_at >= '${window.start}' AND resolved_at < '${window.end}'`,
    );
    expect(queries[0]).toContain("resolved_by <> principal_id");
  });

  it("share is merges resolved by another principal over all merges", async () => {
    const { sql } = fakeSql(() => [counted]);
    const sample = await readKnowledgeMerges(sql, "share", window, signal());
    expect(sample.value).toBeCloseTo(3 / 4);
    expect(sample.unit).toBe("ratio");
    expect(sample.complete).toBe(true);
    expect(sample.sourceWatermarks[0]).toEqual({
      source: "node.doltgres.main",
      asOf: "2026-11-14T00:00:01.000Z",
    });
    expect(sample.evidenceRefs).toContain(
      "counts:merged=4;reviewed=3;unresolved=0",
    );
  });

  it("merged is the raw count, string counts included, and a genuine zero is complete", async () => {
    const { sql } = fakeSql(() => [
      { ...counted, merged: "4", reviewed: "3", unresolved: "0" },
    ]);
    const sample = await readKnowledgeMerges(sql, "merged", window, signal());
    expect(sample.value).toBe(4);
    expect(sample.unit).toBe("items");
    expect(sample.complete).toBe(true);
    const empty = fakeSql(() => [
      { ...counted, merged: 0, reviewed: 0, unresolved: 0 },
    ]);
    const zero = await readKnowledgeMerges(empty.sql, "merged", window, signal());
    expect(zero.value).toBe(0);
    expect(zero.complete).toBe(true);
  });

  it("no merges is a zero denominator, never a 0 share", async () => {
    const { sql } = fakeSql(() => [
      { ...counted, merged: 0, reviewed: 0, unresolved: 0 },
    ]);
    const sample = await readKnowledgeMerges(sql, "share", window, signal());
    expect(sample.complete).toBe(false);
    expect(sample.reason).toBe("zero_denominator");
  });

  it("a merge with no resolver makes the share unknown but not the raw count", async () => {
    const { sql } = fakeSql(() => [{ ...counted, reviewed: 2, unresolved: 1 }]);
    const share = await readKnowledgeMerges(sql, "share", window, signal());
    expect(share.complete).toBe(false);
    expect(share.reason).toBe("incomplete_or_invalid_source");
    const merged = await readKnowledgeMerges(sql, "merged", window, signal());
    expect(merged.complete).toBe(true);
  });

  it("a missing row or inconsistent counts are incomplete, not zero", async () => {
    const missing = fakeSql(() => []);
    for (const output of ["share", "merged"] as const) {
      const sample = await readKnowledgeMerges(
        missing.sql,
        output,
        window,
        signal(),
      );
      expect(sample.complete, output).toBe(false);
      expect(sample.reason, output).toBe("incomplete_or_invalid_source");
    }
    const skewed = fakeSql(() => [{ ...counted, merged: 2, reviewed: 3 }]);
    const sample = await readKnowledgeMerges(skewed.sql, "share", window, signal());
    expect(sample.complete).toBe(false);
  });

  it("an abort cancels the running query and rejects", async () => {
    const controller = new AbortController();
    const { sql, cancel } = fakeSql(() => {
      controller.abort();
      return [counted];
    });
    await expect(
      readKnowledgeMerges(sql, "share", window, controller.signal),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a window edge that is not an instant", async () => {
    const { sql } = fakeSql(() => [counted]);
    await expect(
      readKnowledgeMerges(
        sql,
        "share",
        { start: "x'; DROP TABLE t; --", end: window.end },
        signal(),
      ),
    ).rejects.toThrow("invalid_window");
  });
});
