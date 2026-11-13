// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Caller-class classifier over graph_runs: counts, shares and unknown states. */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { readRunsByCaller } from "@/adapters/server/metrics/runs.source";

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const cancel = vi.fn();
  const sql = {
    unsafe(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      const p = Promise.resolve().then(() => answer(text));
      return Object.assign(p, { cancel });
    },
  } as unknown as Sql;
  return { sql, queries, cancel };
}

const window = {
  start: "2026-11-05T00:00:00.000Z",
  end: "2026-11-12T00:00:00.000Z",
};
const signal = () => new AbortController().signal;
const counted = {
  as_of: "2026-11-12T00:00:01.000Z",
  total: 20,
  system: 10,
  bearer_agent: 6,
  human: 3,
};

describe("readRunsByCaller", () => {
  it("windows on started_at with the engine's edges as parameters", async () => {
    const { sql, queries } = fakeSql(() => [counted]);
    await readRunsByCaller(sql, { class: "all", mode: "count" }, window, signal());
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("gr.started_at >= $1 AND gr.started_at < $2");
    expect(queries[0]?.params).toEqual([window.start, window.end]);
  });

  it("counts every class and derives unclassified as the remainder", async () => {
    const { sql } = fakeSql(() => [counted]);
    const byClass = {
      all: 20,
      system: 10,
      "bearer-agent": 6,
      human: 3,
      unclassified: 1,
      agent: 16,
    } as const;
    for (const [cls, want] of Object.entries(byClass)) {
      const sample = await readRunsByCaller(
        sql,
        { class: cls as keyof typeof byClass, mode: "count" },
        window,
        signal(),
      );
      expect(sample.value, cls).toBe(want);
      expect(sample.unit).toBe("runs");
      expect(sample.complete).toBe(true);
      expect(sample.sourceWatermarks[0]).toEqual({
        source: "node.graph_runs",
        asOf: "2026-11-12T00:00:01.000Z",
      });
    }
  });

  it("tolerates string-typed counts from the driver", async () => {
    const { sql } = fakeSql(() => [
      { ...counted, total: "20", system: "10", bearer_agent: "6", human: "3" },
    ]);
    const sample = await readRunsByCaller(
      sql,
      { class: "unclassified", mode: "count" },
      window,
      signal(),
    );
    expect(sample.value).toBe(1);
    expect(sample.complete).toBe(true);
  });

  it("computes a share against the windowed total", async () => {
    const { sql } = fakeSql(() => [counted]);
    const agent = await readRunsByCaller(
      sql,
      { class: "agent", mode: "share" },
      window,
      signal(),
    );
    expect(agent.value).toBeCloseTo(16 / 20);
    expect(agent.unit).toBe("ratio");
    expect(agent.complete).toBe(true);
    const unclassified = await readRunsByCaller(
      sql,
      { class: "unclassified", mode: "share" },
      window,
      signal(),
    );
    expect(unclassified.value).toBeCloseTo(1 / 20);
  });

  it("an empty window is a zero denominator, never a healthy zero share", async () => {
    const { sql } = fakeSql(() => [
      { ...counted, total: 0, system: 0, bearer_agent: 0, human: 0 },
    ]);
    const sample = await readRunsByCaller(
      sql,
      { class: "human", mode: "share" },
      window,
      signal(),
    );
    expect(sample.complete).toBe(false);
    expect(sample.reason).toBe("zero_denominator");
  });

  it("a missing row is incomplete in both modes, not zero", async () => {
    const { sql } = fakeSql(() => []);
    const share = await readRunsByCaller(
      sql,
      { class: "all", mode: "share" },
      window,
      signal(),
    );
    expect(share.complete).toBe(false);
    expect(share.reason).toBe("incomplete_or_invalid_source");
    const count = await readRunsByCaller(
      sql,
      { class: "all", mode: "count" },
      window,
      signal(),
    );
    expect(count.complete).toBe(false);
  });

  it("an inconsistent remainder can never read complete", async () => {
    const { sql } = fakeSql(() => [
      { ...counted, total: 5, system: 4, bearer_agent: 4, human: 0 },
    ]);
    const sample = await readRunsByCaller(
      sql,
      { class: "all", mode: "count" },
      window,
      signal(),
    );
    expect(sample.complete).toBe(false);
  });

  it("an abort cancels the running query and rejects", async () => {
    const controller = new AbortController();
    const { sql, cancel } = fakeSql(() => {
      controller.abort();
      return [counted];
    });
    await expect(
      readRunsByCaller(sql, { class: "all", mode: "count" }, window, controller.signal),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a window edge that is not an instant", async () => {
    const { sql } = fakeSql(() => [counted]);
    await expect(
      readRunsByCaller(
        sql,
        { class: "all", mode: "count" },
        { start: "not a date", end: window.end },
        signal(),
      ),
    ).rejects.toThrow("invalid_window");
  });
});
