// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Read-miss KPI source (story.0061): an empty day is unknown, never a healthy 0%, and the share is miss units over
 * all units for the last full UTC day before the window end.
 */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { readKnowledgeReads } from "@/adapters/server/metrics/knowledge-reads.source";

function fakeSql(row: Record<string, unknown>) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const sql = {
    unsafe(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      return Object.assign(Promise.resolve([row]), { cancel: vi.fn() });
    },
  } as unknown as Sql;
  return { sql, queries };
}

const window = { start: "2026-11-19T05:00:00.000Z", end: "2026-11-20T05:00:00.000Z" };
const day = {
  day: "2026-11-19",
  as_of: "2026-11-20T05:00:01.000Z",
  units: 40,
  miss_units: 10,
  reads: 450,
  principals: 3,
  top_misses: [{ atom_id: "dead-link", n: 7, principals: 1 }],
  top_reads: [{ atom_id: "node-template-architect", n: 90, principals: 3 }],
};

describe("readKnowledgeReads", () => {
  it("reads the miss share of the last full UTC day, naming the day and top misses", async () => {
    const { sql, queries } = fakeSql(day);
    const sample = await readKnowledgeReads(sql, { measure: "miss_share" }, window, new AbortController().signal);
    expect(queries[0]?.params).toEqual([window.end]);
    expect(queries[0]?.text).toContain("GROUP BY k.principal_id, k.atom_id");
    // A probing caller folds into sentinels; they count as units but are never ranked as fixable ids.
    expect(queries[0]?.text.match(/NOT IN \('\*invalid\*', '\*overflow\*'\)/g)).toHaveLength(2);
    expect(sample).toMatchObject({ value: 0.25, unit: "ratio", complete: true });
    expect(sample.evidenceRefs).toContain("node:knowledge_read_daily:day=2026-11-19");
    expect(sample.evidenceRefs.join(" ")).toContain("dead-link=7/1p");
  });

  it("reports an empty day as unknown, never as a 0% miss share", async () => {
    const { sql } = fakeSql({ ...day, units: 0, miss_units: 0, reads: 0, principals: 0, top_misses: [], top_reads: [] });
    const sample = await readKnowledgeReads(sql, { measure: "miss_share" }, window, new AbortController().signal);
    expect(sample).toMatchObject({ complete: false, reason: "zero_denominator" });
  });

  it("returns the unit count as the guardrail", async () => {
    const { sql } = fakeSql(day);
    const sample = await readKnowledgeReads(sql, { measure: "read_units" }, window, new AbortController().signal);
    expect(sample).toMatchObject({ value: 40, unit: "units", complete: true });
  });
});
