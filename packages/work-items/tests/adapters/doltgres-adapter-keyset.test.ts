// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Admission/deadline regression; SQL correctness is proved in native CI. */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import {
  DoltgresWorkItemAdapter,
  WorkItemsBusyError
} from "../../src/adapters/doltgres/adapter.js";
import {
  independentReadPool,
  makeFakeDoltgresSql
} from "./fake-doltgres-sql.js";

it("shares one deadline across sparse text batches and stops dispatching after failure", async () => {
  let calls = 0;
  const reader = makeFakeDoltgresSql(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Array.from({ length: 501 }, (_, i) => ({
      id: `task.${calls}.${i}`,
      __sort_key: null,
      title: "no match"
    }));
  }, []);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(reader), {
    readClient: reader,
    queryTimeoutMs: 30
  });
  await expect(
    adapter.list({ text: "absent", limit: 1 })
  ).rejects.toBeInstanceOf(WorkItemsBusyError);
  const captured = calls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(captured);
  expect(calls).toBeLessThanOrEqual(2);
});

// COMMAND_QUERY_SEPARATION at runtime (work-items-port.md). Reads must not enter
// the write admission queue: on operator production `operation.queue` averaged
// 2660ms (peak 7334ms) against a 677ms dml.read, because a `max: 1` pool behind
// a single-slot FIFO makes read concurrency structurally 1.
describe("reads leave the write lane when a read pool is supplied", () => {
  it("serves N concurrent reads concurrently, not one-at-a-time", async () => {
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const readPool = Object.assign(async () => [], {
      options: { max: 3 },
      unsafe: async (_q: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(Date.now());
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return [] as unknown[];
      }
    }) as unknown as never;

    const { DoltgresWorkItemAdapter } = await import(
      "../../src/adapters/doltgres/adapter.js"
    );
    const adapter = new DoltgresWorkItemAdapter(independentReadPool(readPool), {
      readClient: readPool
    });

    await Promise.all([adapter.list({}), adapter.list({}), adapter.list({})]);

    // Non-vacuous: without the read lane these serialize and maxInFlight === 1.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(started.length).toBeGreaterThanOrEqual(3);
  });

  it("quarantines a transport-unknown reader without destruction or writer replay", async () => {
    let writeQueries = 0;
    let firstEnded = 0;
    let rebuilds = 0;
    const writePool = Object.assign(async () => [], {
      unsafe: async () => {
        writeQueries += 1;
        return [];
      }
    }) as unknown as Sql;
    const terminalReadPool = Object.assign(async () => [], {
      unsafe: async () => {
        const error = new Error("read connection ended") as Error & {
          code: string;
        };
        error.code = "CONNECTION_ENDED";
        throw error;
      },
      end: async () => {
        firstEnded += 1;
      }
    }) as unknown as Sql;
    const healthyReadPool = Object.assign(async () => [], {
      unsafe: async () => [],
      end: async () => undefined
    }) as unknown as Sql;
    const adapter = new DoltgresWorkItemAdapter(writePool, {
      readClient: terminalReadPool,
      recreateReadClient: () => {
        rebuilds += 1;
        return healthyReadPool;
      }
    });

    await expect(adapter.list()).rejects.toBeInstanceOf(WorkItemsBusyError);
    expect(firstEnded).toBe(0);
    expect(writeQueries).toBe(0);

    await expect(adapter.list()).resolves.toMatchObject({ items: [] });
    expect(rebuilds).toBe(1);
    expect(firstEnded).toBe(0);
    expect(writeQueries).toBe(0);
  });
});

// 0.1.5 shipped the read lane as an opt-in `readClient`, and every node in the
// fleet upgraded without passing it — poly's /work kept hanging on a fix that
// was already in its node_modules. The lane has to arm itself from what nodes
// DO pass, which is `recreateClient`.
describe("the read lane arms itself from recreateClient", () => {
  function countingPool() {
    let inFlight = 0;
    let maxInFlight = 0;
    const pool = Object.assign(async () => [], {
      options: { max: 3 },
      unsafe: async (_q: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return [] as unknown[];
      }
    });
    return { pool, peak: () => maxInFlight };
  }

  it("derives a read pool when the caller passed only recreateClient", async () => {
    const write = countingPool();
    const read = countingPool();
    let built = 0;
    const { DoltgresWorkItemAdapter } = await import(
      "../../src/adapters/doltgres/adapter.js"
    );
    const adapter = new DoltgresWorkItemAdapter(
      write.pool as unknown as never,
      {
        recreateClient: (() => {
          built += 1;
          return read.pool;
        }) as unknown as () => never
      }
    );

    await Promise.all([adapter.list({}), adapter.list({}), adapter.list({})]);

    // Derived once and reused — not a pool per read.
    expect(built).toBe(1);
    // The reads landed on the derived pool, concurrently.
    expect(read.peak()).toBeGreaterThan(1);
    // ...and never touched the max:1 write pool.
    expect(write.peak()).toBe(0);
  });

  it("rejects missing read configuration before any SQL", () => {
    const { sql, queries } = {
      sql: makeFakeDoltgresSql(() => [], []),
      queries: [] as string[]
    };
    expect(() => new DoltgresWorkItemAdapter(sql)).toThrow(
      /dedicated readClient/
    );
    expect(queries).toEqual([]);
  });
});

it("projects summaries and scans beyond the first text batch without reading outcomes", async () => {
  const queries: string[] = [];
  let batch = 0;
  const sql = makeFakeDoltgresSql((query) => {
    if (!query.includes("FROM (SELECT")) return [];
    batch++;
    const makeRow = (i: number, summary: string) => ({ id: `task.${String(i).padStart(4, "0")}`, title: "work", type: "task", status: "needs_implement", labels: [], summary, __sort_key: null });
    return batch === 1 ? Array.from({ length: 501 }, (_, i) => makeRow(i, "none")) : [makeRow(501, "needle only here")];
  }, queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
  const result = await adapter.listSummaries({ text: "needle", limit: 1 });
  expect(result.items.map((item) => item.id)).toEqual(["task.0501"]);
  expect(result.items[0]).not.toHaveProperty("summary");
  const scans = queries.filter((query) => query.includes("FROM (SELECT"));
  expect(scans).toHaveLength(2);
  for (const scan of scans) {
    expect(scan).not.toContain("work_items.*");
    expect(scan).not.toMatch(/\boutcome\b/);
    expect(scan).toContain("summary");
  }
});

it("keeps full list fields and resolves long project cursors with a narrow lookup", async () => {
  const queries: string[] = [];
  const project = `proj.${"x".repeat(1500)}`;
  let scans = 0;
  const sql = makeFakeDoltgresSql((query) => {
    if (query.startsWith("SELECT project_id FROM")) return [{ project_id: project }];
    if (!query.includes("FROM (SELECT")) return [];
    scans++;
    const row = (id: string) => ({ id, title: id, type: "task", status: "needs_implement", project_id: project, __sort_key: project, labels: [], outcome: "full detail", external_refs: [], spec_refs: [], assignees: [] });
    return scans === 1 ? [row("task.1"), row("task.2")] : [row("task.2")];
  }, queries);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
  const first = await adapter.listSummaries({ sortBy: "projectId", limit: 1 });
  expect(first.nextCursor).toBeTruthy();
  expect(first.items[0]).not.toHaveProperty("outcome");
  expect(queries.find((query) => query.includes("FROM (SELECT"))).not.toMatch(/\bsummary\b/);
  await adapter.listSummaries({ sortBy: "projectId", limit: 1, cursor: first.nextCursor });
  expect(queries.some((query) => query.startsWith("SELECT project_id FROM work_items"))).toBe(true);
  expect(queries.some((query) => query.startsWith("SELECT * FROM work_items"))).toBe(false);
  const full = await adapter.list({ limit: 1 });
  expect(full.items[0]?.outcome).toBe("full detail");
  expect(queries.some((query) => query.includes("SELECT work_items.*"))).toBe(true);
});


it("serializes native summary dates without changing timestamp strings or cursor precision", async () => {
  const sql = makeFakeDoltgresSql((query) => query.includes("FROM (SELECT") ? [
    { id: "task.1", title: "one", type: "task", status: "needs_implement", labels: [], created_at: new Date("2026-11-05T20:00:00.123Z"), updated_at: "2026-11-06T02:03:04.123456Z", __sort_key: "2026-11-05 20:00:00.123456" },
    { id: "task.2", title: "two", type: "task", status: "needs_implement", labels: [], created_at: "2026-11-06T02:03:04.123456Z", updated_at: new Date("2026-11-07T03:04:05.678Z"), __sort_key: "2026-11-06 02:03:04.123456" }
  ] : [], []);
  const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
  const page = await adapter.listSummaries({ sortBy: "createdAt", limit: 2 });
  expect(page.items.map(({ createdAt, updatedAt }) => [createdAt, updatedAt])).toEqual([
    ["2026-11-05T20:00:00.123Z", "2026-11-06T02:03:04.123456Z"],
    ["2026-11-06T02:03:04.123456Z", "2026-11-07T03:04:05.678Z"]
  ]);
  expect(page.items[0]?.createdAt.slice(0, 10)).toBe("2026-11-05");
});
