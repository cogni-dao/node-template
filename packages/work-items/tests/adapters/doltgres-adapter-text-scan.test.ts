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

  it("uses a caller deadline for admission only: no pool retirement, partial page with continuation", async () => {
    const queries: string[] = [];
    let ended = 0;
    let rebuilt = 0;
    const sql = makeFakeDoltgresSql(async (query) => {
      if (!query.includes("FROM (SELECT")) return [];
      // Slower than the caller's deadline, far inside queryTimeoutMs.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = /id > '([^']+)'/.exec(query)?.[1];
      const limit = Number(/LIMIT (\d+)$/.exec(query)?.[1]);
      const start = after ? corpus.findIndex((row) => row.id > after) : 0;
      return start < 0 ? [] : corpus.slice(start, start + limit);
    }, queries);
    const reader = Object.assign(async () => [], {
      unsafe: sql.unsafe.bind(sql),
      end: async () => {
        ended += 1;
      }
    }) as unknown as typeof sql;
    const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), {
      readClient: reader,
      recreateReadClient: () => {
        rebuilt += 1;
        return reader;
      },
      queryTimeoutMs: 1_000
    });

    const page = await adapter.listSummaries(
      { text: "needle", limit: 25 },
      { deadline: Date.now() + 20 }
    );
    // The in-flight batch finished under its own native timeout; no next batch was admitted.
    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasMore: true, rowsScanned: 501 });
    expect(page.pageInfo.endCursor).toEqual(expect.any(String));
    expect(queries.filter((query) => query.includes("FROM (SELECT"))).toHaveLength(1);
    expect(ended).toBe(0);
    expect(rebuilt).toBe(0);

    // The same reader keeps serving, and the continuation resumes after row 500.
    const next = await adapter.listSummaries({
      text: "needle",
      limit: 25,
      cursor: page.pageInfo.endCursor ?? undefined
    });
    expect(next.pageInfo.rowsScanned).toBe(WORK_TEXT_SCAN_MAX_ROWS);
    expect(next.items.map((item) => item.id)).toEqual([idOf(1200)]);
    const scans = queries.filter((query) => query.includes("FROM (SELECT"));
    expect(scans[1]).toContain(`id > '${idOf(500)}'`);
    expect(ended).toBe(0);
    expect(rebuilt).toBe(0);
  });

  it("ignores a non-finite scan budget", async () => {
    const { adapter, scansPerCall } = corpusReader();
    scansPerCall.push([]);
    await adapter.listSummaries({ text: "needle" }, { maxScanRows: Number.NaN });
    expect(scansPerCall[0]?.reduce((a, b) => a + b, 0)).toBe(WORK_TEXT_SCAN_MAX_ROWS);
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

describe("listBoardColumns composes every column in one native read", () => {
  const STATUSES = ["needs_design", "needs_implement", "done"] as const;
  const rowsFor = (status: string, count: number, column: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${status}.${String(i).padStart(4, "0")}`,
      title: `${status} ${i}`,
      type: "task",
      status,
      labels: [],
      project_id: `proj.${"p".repeat(10)}`,
      __sort_key: String(100 - i),
      __board_column: column
    }));

  it("issues ONE query and returns per-column pages whose cursors equal listSummaries'", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql((query) => {
      if (query.startsWith("WITH board AS")) {
        // 21 rows (more) for design, 3 for implement, none for done.
        return [...rowsFor("needs_design", 21, 0), ...rowsFor("needs_implement", 3, 1)];
      }
      if (query.includes("FROM (SELECT")) {
        const status = /status IN \('([^']+)'\)/.exec(query)?.[1] ?? "";
        return rowsFor(status, status === "needs_design" ? 21 : 3, 0);
      }
      return [];
    }, queries);
    const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
    const filters = { types: ["task" as const], rankMin: 1 };
    const board = await adapter.listBoardColumns(filters, [...STATUSES, "done"], 20);

    const composed = queries.filter((query) => query.startsWith("WITH board AS"));
    expect(composed).toHaveLength(1);
    expect(queries.filter((query) => query.includes("FROM (SELECT"))).toHaveLength(1);
    const sqlText = composed[0] as string;
    expect(sqlText.match(/UNION ALL/g)).toHaveLength(2);
    expect(sqlText.match(/LIMIT 21\)/g)).toHaveLength(3);
    for (const status of STATUSES) expect(sqlText).toContain(`status IN ('${status}')`);
    expect(sqlText).not.toContain("work_items.*");
    expect(board.queryCount).toBe(1);
    expect(board.columns.map((c) => [c.status, c.items.length, c.pageInfo.hasMore])).toEqual([
      ["needs_design", 20, true],
      ["needs_implement", 3, false],
      ["done", 0, false]
    ]);
    expect(board.columns[0]?.items[0]).not.toHaveProperty("summary");

    // The per-column path issues the identical cursor for the identical column query.
    const single = await adapter.listSummaries({ ...filters, statuses: ["needs_design"], limit: 20 });
    expect(board.columns[0]?.pageInfo.endCursor).toBe(single.pageInfo.endCursor);
    // ...and that cursor continues the column through listSummaries.
    await expect(
      adapter.listSummaries({
        ...filters,
        statuses: ["needs_design"],
        limit: 20,
        cursor: board.columns[0]?.pageInfo.endCursor ?? undefined
      })
    ).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it("never composes text search and reads nothing for no columns", async () => {
    const queries: string[] = [];
    const sql = makeFakeDoltgresSql(() => [], queries);
    const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
    await expect(adapter.listBoardColumns({ text: "x" }, ["done"], 20)).rejects.toThrow(/text/);
    await expect(adapter.listBoardColumns({}, [], 20)).resolves.toEqual({ columns: [], queryCount: 0 });
    expect(queries.filter((query) => query.includes("SELECT ordered"))).toHaveLength(0);
  });
});
