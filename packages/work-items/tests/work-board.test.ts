// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/work-board`
 * Purpose: Pins the bounded summary read contract: query codec round trip, page budgets, and board column loading with continuation cursors (task.0055).
 * Scope: Pure functions plus the real Doltgres cursor codec over an in-memory reader. No database.
 * Invariants:
 *   - BOUNDED_PAGE: default 25, max 100; above max rejected by the parser, clamped by the encoder.
 *   - BOUNDED_BOARD: one read per distinct visible status, each ≤ the column budget; no cursor walking.
 *   - COLUMN_CURSOR_IDENTITY: a column's endCursor decodes under the query a later `/summaries?statuses=<status>` request builds.
 * Side-effects: none
 * Links: packages/work-items/src/summary-query.ts, packages/work-items/src/board.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  queryIdentity,
} from "../src/adapters/doltgres/cursor.js";
import {
  loadWorkBoardColumns,
  parseWorkBoardSearchParams,
  WORK_BOARD_STATUSES,
  WorkBoardColumnsSchema,
} from "../src/board.js";
import {
  parseWorkSummarySearchParams,
  WORK_BOARD_COLUMN_PAGE,
  WORK_SUMMARY_LIST_MAX,
  WORK_SUMMARY_PAGE_DEFAULT,
  WORK_SUMMARY_PAGE_MAX,
  WORK_SUMMARY_TEXT_MAX,
  WorkSummaryPageSchema,
  type WorkSummaryPage,
  type WorkSummaryQuery,
  workSummaryQueryToSearchParams,
} from "../src/summary-query.js";
import {
  classifyWorkReadError,
  handleWorkBoardRequest,
  handleWorkSummariesRequest,
} from "../src/read-handlers.js";
import type { WorkQuery } from "../src/types.js";

const parse = (search: string) =>
  parseWorkSummarySearchParams(new URLSearchParams(search));

describe("work summary query codec", () => {
  it("defaults the limit and keeps absent filters absent", () => {
    const result = parse("");
    expect(result).toEqual({
      ok: true,
      query: { limit: WORK_SUMMARY_PAGE_DEFAULT },
    });
    expect(WORK_SUMMARY_PAGE_DEFAULT).toBe(25);
    expect(WORK_SUMMARY_PAGE_MAX).toBe(100);
    expect(WORK_BOARD_COLUMN_PAGE).toBe(20);
  });

  it("round-trips every supported parameter", () => {
    const query: WorkSummaryQuery = {
      types: ["task", "bug"],
      statuses: ["needs_implement", "needs_design"],
      projectIds: ["proj.alpha"],
      projectId: "proj.beta",
      labels: ["ui", "goal:alpha"],
      labelPrefix: "goal:",
      node: ["a", "b"],
      actor: "ai",
      scored: false,
      rankMin: -1,
      rankMax: 4.5,
      sortBy: "updatedAt",
      sortDirection: "asc",
      text: "board, bounded",
      limit: 40,
      cursor: "abc_DEF-123",
    };
    const params = workSummaryQueryToSearchParams(query);
    expect(parseWorkSummarySearchParams(params)).toEqual({
      ok: true,
      query,
    });
    // Encoding is stable: equal queries give equal strings.
    expect(workSummaryQueryToSearchParams({ ...query }).toString()).toBe(
      params.toString(),
    );
    expect(workSummaryQueryToSearchParams({ cursor: "c", limit: 5 }).toString())
      .toBe("limit=5&cursor=c");
  });

  it("reads a single node as a string and a list as an array", () => {
    expect(parse("node=a")).toMatchObject({ ok: true, query: { node: "a" } });
    expect(parse("node=a,b")).toMatchObject({
      ok: true,
      query: { node: ["a", "b"] },
    });
  });

  it("rejects a limit above the max, clamps it when encoding", () => {
    expect(parse(`limit=${WORK_SUMMARY_PAGE_MAX}`).ok).toBe(true);
    for (const limit of ["101", "500", "0", "-3", "1.5", "abc"]) {
      expect(parse(`limit=${limit}`).ok).toBe(false);
    }
    expect(
      workSummaryQueryToSearchParams({ limit: 500 }).get("limit"),
    ).toBe("100");
    expect(workSummaryQueryToSearchParams({ limit: 0 }).get("limit")).toBe("1");
    expect(workSummaryQueryToSearchParams({}).get("limit")).toBe("25");
  });

  it("rejects malformed values and inverted rank ranges", () => {
    for (const search of [
      "rankMin=x",
      "rankMin=5&rankMax=1",
      "sortBy=nope",
      "sortDirection=up",
      "actor=robot",
      "scored=maybe",
      `cursor=${"a".repeat(2049)}`,
    ]) {
      expect(parse(search).ok, search).toBe(false);
    }
    expect(parse("rankMin=&rankMax=").ok).toBe(true);
  });

  it("bounds list filters to 50 values and text to 200 characters", () => {
    const values = (n: number) =>
      Array.from({ length: n }, (_, i) => `v${i}`).join(",");
    for (const key of ["types", "statuses", "projectIds", "labels"]) {
      expect(parse(`${key}=${values(WORK_SUMMARY_LIST_MAX)}`).ok, key).toBe(
        true,
      );
      expect(
        parse(`${key}=${values(WORK_SUMMARY_LIST_MAX + 1)}`).ok,
        key,
      ).toBe(false);
    }
    expect(parse(`text=${"a".repeat(WORK_SUMMARY_TEXT_MAX)}`).ok).toBe(true);
    expect(parse(`text=${"a".repeat(WORK_SUMMARY_TEXT_MAX + 1)}`).ok).toBe(
      false,
    );
  });
});

/** Rows sorted by id within each status; keyset cursors are the last id. */
function fixtureReader(perStatus: number) {
  const calls: WorkSummaryQuery[] = [];
  const list = vi.fn(async (query: WorkSummaryQuery): Promise<WorkSummaryPage> => {
    calls.push(query);
    const status = query.statuses?.[0] ?? "";
    const identity = queryIdentity(query as WorkQuery);
    const after = query.cursor
      ? decodeCursor(query.cursor, undefined, identity).id
      : "";
    const all = Array.from({ length: perStatus }, (_, index) => ({
      id: `${status}.${String(index).padStart(4, "0")}`,
      title: `Item ${index}`,
      type: "task",
      status,
      labels: [],
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
    })).filter((item) => item.id > after);
    const limit = query.limit ?? WORK_SUMMARY_PAGE_DEFAULT;
    const items = all.slice(0, limit);
    const hasMore = all.length > limit;
    const last = items.at(-1);
    return {
      items,
      pageInfo: {
        hasMore,
        endCursor:
          hasMore && last
            ? encodeCursor({
                v: 2,
                filter: identity,
                sortBy: "rankScore",
                sortDirection: "desc",
                key: null,
                id: last.id,
              })
            : null,
      },
    };
  });
  return { list, calls };
}

describe("loadWorkBoardColumns", () => {
  const statuses = ["needs_design", "needs_implement", "done"];

  it("reads one bounded page per visible status, sequentially, in order", async () => {
    let active = 0;
    let peak = 0;
    const { list } = fixtureReader(45);
    const guarded = async (query: WorkSummaryQuery) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await list(query);
      } finally {
        active -= 1;
      }
    };
    const board = await loadWorkBoardColumns(
      guarded,
      { types: ["task"], text: "item", limit: 100, cursor: "ignored" },
      [...statuses, "needs_design"],
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(board.columns.map((column) => column.status)).toEqual(statuses);
    for (const column of board.columns) {
      expect(column.items).toHaveLength(WORK_BOARD_COLUMN_PAGE);
      expect(column.pageInfo.hasMore).toBe(true);
      expect(column.pageInfo.endCursor).toEqual(expect.any(String));
    }
    for (const call of list.mock.calls.map(([query]) => query)) {
      expect(call.limit).toBe(WORK_BOARD_COLUMN_PAGE);
      expect(call.cursor).toBeUndefined();
      expect(call.statuses).toHaveLength(1);
      expect(call.types).toEqual(["task"]);
    }
    expect(WorkBoardColumnsSchema.safeParse(board).success).toBe(true);
    expect(
      WorkSummaryPageSchema.safeParse({
        items: board.columns[0]?.items,
        pageInfo: board.columns[0]?.pageInfo,
      }).success,
    ).toBe(true);
  });

  it("clamps the column budget and never exceeds the status set", async () => {
    const { list } = fixtureReader(500);
    const board = await loadWorkBoardColumns(list, {}, WORK_BOARD_STATUSES, { perColumn: 5_000 });
    expect(list.mock.calls.length).toBe(WORK_BOARD_STATUSES.length);
    expect(
      list.mock.calls.every(([query]) => query.limit === WORK_SUMMARY_PAGE_MAX),
    ).toBe(true);
    expect(board.columns.every((c) => c.items.length === WORK_SUMMARY_PAGE_MAX))
      .toBe(true);
  });

  it("stops before the next column read once the signal aborts", async () => {
    const { list } = fixtureReader(3);
    const controller = new AbortController();
    const abortingList = async (query: WorkSummaryQuery) => {
      const page = await list(query);
      controller.abort(new Error("client went away"));
      return page;
    };
    await expect(
      loadWorkBoardColumns(abortingList, {}, statuses, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("client went away");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("shares one rows-scanned budget across columns and marks unreached columns not_started", async () => {
    const seen: Array<number | undefined> = [];
    const list = async (
      query: WorkSummaryQuery,
      options?: { maxScanRows?: number; deadline?: number },
    ): Promise<WorkSummaryPage> => {
      seen.push(options?.maxScanRows);
      expect(options?.deadline).toEqual(expect.any(Number));
      return {
        items: [],
        pageInfo: { endCursor: "c", hasMore: true, rowsScanned: 600 },
      };
    };
    const board = await loadWorkBoardColumns(
      list,
      { text: "sparse" },
      statuses,
      { maxScanRows: 1000 },
    );
    expect(seen).toEqual([1000, 400]);
    expect(board.columns.map((c) => c.state)).toEqual([
      "loaded",
      "loaded",
      "not_started",
    ]);
    expect(board.columns[2]).toEqual({
      status: "done",
      state: "not_started",
      items: [],
      pageInfo: { endCursor: null, hasMore: true, rowsScanned: 0 },
    });
    expect(WorkBoardColumnsSchema.safeParse(board).success).toBe(true);
  });

  it("shares one deadline across columns and starts none after it", async () => {
    let clock = 0;
    const deadlines: Array<number | undefined> = [];
    const list = async (
      _query: WorkSummaryQuery,
      options?: { deadline?: number },
    ): Promise<WorkSummaryPage> => {
      deadlines.push(options?.deadline);
      clock += 3_000;
      return { items: [], pageInfo: { endCursor: null, hasMore: false } };
    };
    const board = await loadWorkBoardColumns(list, {}, statuses, {
      budgetMs: 5_000,
      now: () => clock,
    });
    expect(deadlines).toEqual([5_000, 5_000]);
    expect(board.columns.map((c) => c.state)).toEqual([
      "loaded",
      "loaded",
      "not_started",
    ]);
  });

  it("reads nothing for no columns and rejects an unknown status before any read", async () => {
    const { list } = fixtureReader(3);
    await expect(loadWorkBoardColumns(list, {}, [])).resolves.toEqual({
      columns: [],
    });
    await expect(
      loadWorkBoardColumns(list, {}, ["done", "not_a_status"]),
    ).rejects.toThrow(RangeError);
    expect(list).not.toHaveBeenCalled();
  });

  it("issues a column cursor that continues exactly that column, and no other", async () => {
    const { list } = fixtureReader(45);
    const filters: WorkSummaryQuery = {
      types: ["task"],
      projectIds: ["proj.alpha"],
      text: "Item",
      sortBy: "rankScore",
      sortDirection: "desc",
    };
    const board = await loadWorkBoardColumns(list, filters, statuses);
    const column = board.columns[1];
    if (!column?.pageInfo.endCursor) throw new Error("expected a cursor");

    // The browser builds the follow-up from the same codec the route decodes with.
    const request = workSummaryQueryToSearchParams({
      ...filters,
      statuses: [column.status],
      limit: WORK_BOARD_COLUMN_PAGE,
      cursor: column.pageInfo.endCursor,
    });
    const parsed = parseWorkSummarySearchParams(request);
    if (!parsed.ok) throw new Error("follow-up request must parse");
    const next = await list(parsed.query);
    expect(next.items[0]?.id).toBe(
      `${column.status}.${String(WORK_BOARD_COLUMN_PAGE).padStart(4, "0")}`,
    );
    expect(next.items).toHaveLength(WORK_BOARD_COLUMN_PAGE);

    // The same cursor is not valid for another column's query.
    const other = board.columns[0]?.status;
    expect(() =>
      decodeCursor(
        column.pageInfo.endCursor as string,
        undefined,
        queryIdentity({ ...filters, statuses: [other] } as WorkQuery),
      ),
    ).toThrow(InvalidCursorError);
  });
});

describe("parseWorkBoardSearchParams", () => {
  it("requires known visible columns", () => {
    expect(
      parseWorkBoardSearchParams(new URLSearchParams("types=task")).ok,
    ).toBe(false);
    expect(
      parseWorkBoardSearchParams(new URLSearchParams("statuses=nope")).ok,
    ).toBe(false);
    const ok = parseWorkBoardSearchParams(
      new URLSearchParams("statuses=done,needs_design,done&types=bug"),
    );
    expect(ok).toMatchObject({
      ok: true,
      statuses: ["done", "needs_design"],
      query: { types: ["bug"] },
    });
  });
});

describe("read handlers", () => {
  const page: WorkSummaryPage = {
    items: [],
    pageInfo: { endCursor: null, hasMore: false, rowsScanned: 3 },
  };
  const named = (name: string) =>
    Object.assign(new Error(`${name} happened`), { name });

  it("serves a summaries page and reports counts, order and rows scanned", async () => {
    const list = vi.fn(async () => page);
    const result = await handleWorkSummariesRequest(
      new URLSearchParams("limit=5&statuses=done"),
      list,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual(page);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: 5, statuses: ["done"] });
    expect(result.telemetry).toMatchObject({
      status: 200,
      outcome: "success",
      count: 0,
      rowsScanned: 3,
      sortBy: "rankScore",
    });
  });

  it.each([
    ["limit=101", 400, "invalid_input"],
    [`cursor=${"a".repeat(2049)}`, 400, "invalid_input"],
  ])("rejects %s before any read", async (search, status, code) => {
    const list = vi.fn(async () => page);
    const result = await handleWorkSummariesRequest(new URLSearchParams(search), list);
    expect(result.status).toBe(status);
    expect(result.telemetry.errorCode).toBe(code);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    ["InvalidCursorError", 400, "invalid_cursor"],
    ["WorkItemsBusyError", 503, "backend_unavailable"],
    ["WorkItemsCapacityError", 503, "backend_unavailable"],
    ["WorkItemsBackendNotReadyError", 503, "backend_unavailable"],
    ["TypeError", 500, "internal_error"],
  ])("maps %s to %i", async (name, status, code) => {
    const result = await handleWorkBoardRequest(
      new URLSearchParams("statuses=done"),
      async () => {
        throw named(name);
      },
    );
    expect(result.status).toBe(status);
    expect(result.telemetry).toMatchObject({ errorCode: code, columnCount: 1 });
    if (status === 500) expect(result.body).toEqual({ error: "Internal server error" });
    // Fixed strings: the thrown error's text never reaches the client.
    expect(JSON.stringify(result.body)).not.toContain("happened");
  });

  it("answers an aborted board with 499 and no body", async () => {
    const controller = new AbortController();
    const result = await handleWorkBoardRequest(
      new URLSearchParams("statuses=done,needs_design"),
      async () => {
        controller.abort();
        return page;
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ status: 499, body: null });
    expect(result.telemetry.errorCode).toBe("client_aborted");
  });

  it("serves board columns with per-column durations and not-started counts", async () => {
    const result = await handleWorkBoardRequest(
      new URLSearchParams("statuses=done,needs_design&text=x"),
      async () => ({ ...page, pageInfo: { ...page.pageInfo, rowsScanned: 1000 } }),
    );
    expect(result.status).toBe(200);
    expect(result.telemetry).toMatchObject({
      columnCount: 2,
      notStartedCount: 1,
      rowsScanned: 1000,
    });
    expect(result.telemetry.columnDurationsMs).toHaveLength(1);
    expect(classifyWorkReadError(named("DoltgresNotConfiguredError"))).toBe(
      "backend_unavailable",
    );
  });
});

describe("summary query value bounds", () => {
  it("rejects oversized single-value filters", async () => {
    const { parseWorkSummarySearchParams, WORK_SUMMARY_VALUE_MAX } = await import("../src/index.js");
    const long = "x".repeat(WORK_SUMMARY_VALUE_MAX + 1);
    for (const key of ["projectId", "labelPrefix", "node"]) {
      const parsed = parseWorkSummarySearchParams(new URLSearchParams({ [key]: long }));
      expect(parsed.ok, key).toBe(false);
    }
    expect(parseWorkSummarySearchParams(new URLSearchParams({ node: "a,b" })).ok).toBe(true);
  });
});
