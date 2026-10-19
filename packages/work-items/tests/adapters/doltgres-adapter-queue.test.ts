// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Reads have no writer admission path; leases cannot call versioned content. */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { toWorkItemId, type WorkItemLeasePort } from "../../src/index.js";
import { DoltgresWorkItemAdapter } from "../../src/adapters/doltgres/adapter.js";
import { withWorkItemLeases } from "../../src/with-leases.js";
import type { WorkItemsContentPort } from "../../src/adapters/doltgres/ports.js";

it("rejects a shared read/write pool before executing SQL", () => {
  const pool = { unsafe: vi.fn() } as unknown as Sql;
  expect(() => new DoltgresWorkItemAdapter(pool, { readClient: pool })).toThrow(
    /separate pools/
  );
  expect(pool.unsafe).not.toHaveBeenCalled();
});

it("all concurrent read methods never reserve, lock, checkout, reconcile, or query writer", async () => {
  const write = {
    unsafe: vi.fn(() => {
      throw new Error("writer must stay untouched");
    }),
    reserve: vi.fn(),
  } as unknown as Sql;
  const read = { unsafe: vi.fn(async () => []) } as unknown as Sql;
  const adapter = new DoltgresWorkItemAdapter(write, { readClient: read });
  await Promise.all(Array.from({ length: 100 }, () => Promise.all([adapter.list(), adapter.get(toWorkItemId("task.0001")), adapter.listRelations(toWorkItemId("task.0001"))])));
  expect(write.unsafe).not.toHaveBeenCalled();
  expect(write.reserve).not.toHaveBeenCalled();
  expect(read.unsafe).toHaveBeenCalledTimes(300);
  expect(read.unsafe).not.toHaveBeenCalledWith(
    expect.stringMatching(/dolt_|advisory/)
  );
});

describe("lease/content composition", () => {
  it("heartbeat and release never read Dolt, including errors", async () => {
    const content = {
      get: vi.fn(() => {
        throw new Error("Dolt unavailable");
      }),
    } as unknown as WorkItemsContentPort;
    const leases = {
      heartbeat: vi.fn(async () => {
        throw new Error("conflict");
      }),
      release: vi.fn(async () => ({ active: false })),
    } as unknown as WorkItemLeasePort;
    const adapter = withWorkItemLeases(content, leases);
    const input = {
      id: toWorkItemId("task.0001"),
      principalId: "p",
      runId: "r",
      leaseToken: "token",
    };
    await expect(adapter.heartbeat(input)).rejects.toThrow("conflict");
    await expect(adapter.release(input)).resolves.toMatchObject({
      active: false,
    });
    expect(content.get).not.toHaveBeenCalled();
  });

  it("ignores legacy Dolt claims and projects PostgreSQL authority in one page batch", async () => {
    const item = {
      id: toWorkItemId("task.0001"),
      claimedByRun: "obsolete",
      claimedAt: "old",
      lastCommand: "old",
    };
    const content = {
      list: vi.fn(async () => ({
        items: [item],
        pageInfo: { endCursor: null, hasMore: false },
      })),
    } as unknown as WorkItemsContentPort;
    const leases = {
      getMany: vi.fn(async () => new Map()),
    } as unknown as WorkItemLeasePort;
    const page = await withWorkItemLeases(content, leases).list();
    expect(page.items[0]?.claimedByRun).toBeUndefined();
    expect(page.items[0]?.lastCommand).toBeUndefined();
    expect(leases.getMany).toHaveBeenCalledExactlyOnceWith([item.id]);
  });
  it("content mutation success never depends on PostgreSQL hydration", async () => {
    const item = { id: toWorkItemId("task.0001"), title: "committed" };
    const content = { create: vi.fn(async () => item), patch: vi.fn(async () => item) } as unknown as WorkItemsContentPort;
    const leases = { getMany: vi.fn(async () => { throw new Error("PostgreSQL unavailable"); }) } as unknown as WorkItemLeasePort;
    const adapter = withWorkItemLeases(content, leases);
    await expect(adapter.create({type:"task",title:"committed"}, "p")).resolves.toBe(item);
    await expect(adapter.patch({id:item.id,set:{title:"committed"}}, "p")).resolves.toBe(item);
    expect(leases.getMany).not.toHaveBeenCalled();
  });

});
