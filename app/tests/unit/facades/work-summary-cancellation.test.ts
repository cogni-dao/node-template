// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ container: undefined as unknown }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => fake.container }));
vi.mock("@cogni/node-contracts", async () => {
  const work = await import("@cogni/work-items");
  return { WorkItemDtoSchema: work.WorkItemDtoSchema, WorkItemSummarySchema: work.WorkItemSummarySchema };
});
import { loadWorkBoardColumns } from "@cogni/work-items";
import { getWorkItem, listWorkBoardColumns, listWorkSummaries } from "@/app/_facades/work/items.server";

const item = { id: "task.0001", type: "task", title: "Fixture", status: "needs_implement", node: "operator", actor: "either", assignees: [], externalRefs: [], labels: [], specRefs: [], revision: 1, deployVerified: false, createdAt: "2026-01-01", updatedAt: "2026-01-02", moves: [{ metricId: "m", direction: "up", baselineObservationId: "11111111-1111-4111-8111-111111111111" }] };
const workReadBatch = vi.fn();
const get = vi.fn();
const listSummaries = vi.fn();
const listBoardColumns = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  fake.container = { doltgresWorkItems: { get, listSummaries, listBoardColumns }, goalMetrics: { workReadBatch } };
  get.mockResolvedValue(item);
  workReadBatch.mockResolvedValue([{ baseline: { id: item.moves[0].baselineObservationId, status: "ok", value: 2, observedAt: "2026-01-01", unit: "count" }, current: { id: "22222222-2222-4222-8222-222222222222", status: "ok", value: 3, observedAt: "2026-01-02", unit: "count" } }]);
});

describe("work summary request cancellation", () => {
  beforeEach(() => {
    listSummaries.mockResolvedValue({ items: [item], pageInfo: { endCursor: null, hasMore: false } });
    listBoardColumns.mockResolvedValue({ columns: [{ status: "needs_implement", items: [item], pageInfo: { endCursor: null, hasMore: false } }], queryCount: 1 });
  });

  it.each(["list", "board"] as const)("cancels an in-flight %s batch", async (surface) => {
    const controller = new AbortController();
    let batchSignal: AbortSignal | undefined;
    let started!: () => void;
    const batchStarted = new Promise<void>((resolve) => { started = resolve; });
    workReadBatch.mockImplementation((_moves, signal: AbortSignal) => {
      batchSignal = signal;
      started();
      return new Promise(() => {});
    });
    const options = { signal: controller.signal, deadline: Date.now() + 10_000 };
    const pending = surface === "list" ? listWorkSummaries({}, options) : listWorkBoardColumns({}, ["needs_implement"], 20, options);
    await batchStarted;
    controller.abort();
    await pending;
    expect(batchSignal?.aborted).toBe(true);
  });

  it.each(["list", "board"] as const)("does not admit %s enrichment after deadline or cancellation", async (surface) => {
    const run = (options: { signal?: AbortSignal; deadline?: number }) => surface === "list" ? listWorkSummaries({}, options) : listWorkBoardColumns({}, ["needs_implement"], 20, options);
    await run({ deadline: Date.now() - 1 });
    const controller = new AbortController();
    controller.abort();
    await run({ signal: controller.signal });
    expect(workReadBatch).not.toHaveBeenCalled();
    const healthy = await run({ deadline: Date.now() + 10_000 });
    const result = "items" in healthy ? healthy.items[0] : healthy.columns[0]?.items[0];
    expect(result?.moves?.[0]).toMatchObject({ baselineObservationId: item.moves[0].baselineObservationId, baseline: { value: 2 }, current: { value: 3 } });
    expect(workReadBatch).toHaveBeenCalledOnce();
  });
});

  it("cancels detail enrichment through the same batch", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    workReadBatch.mockImplementation((_moves, batchSignal: AbortSignal) => { signal = batchSignal; started(); return new Promise(() => {}); });
    const pending = getWorkItem(item.id, { signal: controller.signal });
    await ready;
    controller.abort();
    await pending;
    expect(signal?.aborted).toBe(true);
  });

it("passes the board budget to the composed facade", async () => {
  listBoardColumns.mockResolvedValue({ columns: [{ status: "needs_implement", items: [item], pageInfo: { endCursor: null, hasMore: false } }], queryCount: 1 });
  await loadWorkBoardColumns(listWorkSummaries, {}, ["needs_implement"], { listColumns: listWorkBoardColumns, now: () => 1, budgetMs: 10 });
  expect(listBoardColumns.mock.calls[0]?.[3]).toMatchObject({ deadline: 11 });
  expect(workReadBatch).not.toHaveBeenCalled();
});

it("aborts an active batch when the shared deadline expires", async () => {
  listSummaries.mockResolvedValue({ items: [item], pageInfo: { endCursor: null, hasMore: false } });
  let signal: AbortSignal | undefined;
  workReadBatch.mockImplementation((_moves, value: AbortSignal) => { signal = value; return new Promise(() => {}); });
  await listWorkSummaries({}, { deadline: Date.now() + 30 });
  expect(signal?.aborted).toBe(true);
});
