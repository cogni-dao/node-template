// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * TEXT_SCAN_BOUNDED (task.0055): a JS-side text match scans at most
 * WORK_TEXT_SCAN_MAX_ROWS rows per request and hands back a continuation at the
 * last scanned row. SQL correctness of the seek is proved in native CI; this
 * fake serves an ordered corpus honoring the seek id and LIMIT.
 */
import { describe, expect, it } from "vitest";
import {
  DoltgresWorkItemAdapter,
  WORK_TEXT_SCAN_MAX_ROWS
} from "../../src/adapters/doltgres/index.js";
import {
  independentReadPool,
  makeFakeDoltgresSql
} from "./fake-doltgres-sql.js";

const CORPUS = 2500;
const NEEDLES = new Set([1200, 1800, 2400]);
const idOf = (i: number) => `task.${String(i).padStart(4, "0")}`;
const corpus = Array.from({ length: CORPUS }, (_, i) => ({
  id: idOf(i),
  title: NEEDLES.has(i) ? "has the needle" : "plain work",
  summary: "",
  type: "task",
  status: "needs_implement",
  labels: [],
  external_refs: [],
  spec_refs: [],
  assignees: [],
  __sort_key: null
}));

function corpusReader() {
  const queries: string[] = [];
  const scansPerCall: number[][] = [];
  const sql = makeFakeDoltgresSql((query) => {
    if (!query.includes("FROM (SELECT")) return [];
    const after = /id > '([^']+)'/.exec(query)?.[1];
    const limit = Number(/LIMIT (\d+)$/.exec(query)?.[1]);
    const start = after ? corpus.findIndex((row) => row.id > after) : 0;
    const rows = start < 0 ? [] : corpus.slice(start, start + limit);
    scansPerCall.at(-1)?.push(rows.length);
    return rows;
  }, queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), {
    readClient: sql
  });
  return { adapter, queries, scansPerCall };
}

describe("text scan is capped per request with a continuation", () => {
  it.each(["list", "listSummaries"] as const)(
    "%s returns a continuation at the cap and resumes without loss or duplicates",
    async (method) => {
      const { adapter, scansPerCall } = corpusReader();
      const read = (cursor?: string) => {
        scansPerCall.push([]);
        return adapter[method]({
          text: "needle",
          limit: 25,
          ...(cursor && { cursor })
        });
      };

      // Page 1: rows 0..999 hold no match. An empty page with a cursor is progress.
      const first = await read();
      expect(first.items).toEqual([]);
      expect(first.pageInfo.hasMore).toBe(true);
      expect(first.pageInfo.endCursor).toBeTruthy();
      expect(first.pageInfo).toMatchObject({ rowsScanned: WORK_TEXT_SCAN_MAX_ROWS });
      expect(scansPerCall[0]).toEqual([501, WORK_TEXT_SCAN_MAX_ROWS - 501]);

      // Page 2 resumes after the last scanned row (task.0999), not after a match.
      const second = await read(first.pageInfo.endCursor ?? undefined);
      expect(second.items.map((item) => item.id)).toEqual([
        idOf(1200),
        idOf(1800)
      ]);
      expect(second.pageInfo.hasMore).toBe(true);
      expect(scansPerCall[1]?.reduce((a, b) => a + b, 0)).toBe(
        WORK_TEXT_SCAN_MAX_ROWS
      );

      // Page 3 reaches the end of the corpus: no continuation.
      const third = await read(second.pageInfo.endCursor ?? undefined);
      expect(third.items.map((item) => item.id)).toEqual([idOf(2400)]);
      expect(third.pageInfo).toEqual({
        endCursor: null,
        hasMore: false,
        rowsScanned: CORPUS - 2 * WORK_TEXT_SCAN_MAX_ROWS
      });

      const seen = [first, second, third].flatMap((page) =>
        page.items.map((item) => item.id)
      );
      // The union of capped pages equals one uncapped full scan, no duplicates.
      const fullScan = corpus
        .filter((row) => row.title.includes("needle"))
        .map((row) => row.id);
      expect(seen).toEqual(fullScan);
      expect(new Set(seen).size).toBe(seen.length);
      for (const scans of scansPerCall) {
        expect(scans.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
          WORK_TEXT_SCAN_MAX_ROWS
        );
      }
    }
  );

  it("continues a full page after its last returned match, not its last scanned row", async () => {
    const { adapter, scansPerCall } = corpusReader();
    scansPerCall.push([]);
    // Matches at 1200 and 1800 fall in one capped window; limit 1 fills the page first.
    const skipFirst = await adapter.listSummaries({ text: "needle", limit: 1 });
    expect(skipFirst.items).toEqual([]);
    const page = await adapter.listSummaries({
      text: "needle",
      limit: 1,
      cursor: skipFirst.pageInfo.endCursor ?? undefined
    });
    expect(page.items.map((item) => item.id)).toEqual([idOf(1200)]);
    const next = await adapter.listSummaries({
      text: "needle",
      limit: 1,
      cursor: page.pageInfo.endCursor ?? undefined
    });
    expect(next.items.map((item) => item.id)).toEqual([idOf(1800)]);
  });

  it("tightens the cap per call and clamps summary pages to 100 rows", async () => {
    const { adapter, scansPerCall } = corpusReader();
    scansPerCall.push([]);
    const tight = await adapter.listSummaries(
      { text: "needle", limit: 25 },
      { maxScanRows: 300 }
    );
    expect(scansPerCall[0]).toEqual([300]);
    expect(tight.pageInfo).toMatchObject({ hasMore: true, rowsScanned: 300 });
    scansPerCall.push([]);
    await adapter.listSummaries({ text: "needle" }, { maxScanRows: 50_000 });
    expect(scansPerCall[1]?.reduce((a, b) => a + b, 0)).toBe(
      WORK_TEXT_SCAN_MAX_ROWS
    );
    scansPerCall.push([]);
    const wide = await adapter.listSummaries({ limit: 500 });
    expect(wide.items).toHaveLength(100);
    expect(scansPerCall[2]).toEqual([101]);
    scansPerCall.push([]);
    const full = await adapter.list({ limit: 500 });
    expect(full.items).toHaveLength(500);
  });

  it("stops before the next batch once the signal aborts", async () => {
    const { adapter } = corpusReader();
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(
      adapter.listSummaries({ text: "needle" }, { signal: controller.signal })
    ).rejects.toThrow("gone");
  });

  it("still returns limit + 1 detection before the cap when matches are dense", async () => {
    const { adapter, scansPerCall } = corpusReader();
    scansPerCall.push([]);
    const page = await adapter.listSummaries({ text: "plain", limit: 3 });
    expect(page.items.map((item) => item.id)).toEqual([
      idOf(0),
      idOf(1),
      idOf(2)
    ]);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(scansPerCall[0]).toEqual([501]);
    const next = await adapter.listSummaries({
      text: "plain",
      limit: 3,
      cursor: page.pageInfo.endCursor ?? undefined
    });
    expect(next.items[0]?.id).toBe(idOf(3));
  });
});
