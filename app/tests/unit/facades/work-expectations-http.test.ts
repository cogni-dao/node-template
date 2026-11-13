// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ container: undefined as unknown, user: null as unknown }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => fake.container }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: async () => fake.user }));
// The node-contracts release re-exports these shared work contracts.
vi.mock("@cogni/node-contracts", async () => {
  const work = await import("@cogni/work-items");
  return { WorkItemDtoSchema: work.WorkItemDtoSchema, WorkItemSummarySchema: work.WorkItemSummarySchema };
});

import { GET } from "@/app/api/v1/work/items/[id]/expectations/route";
import { getWorkItem, listWorkBoardColumns, listWorkSummaries } from "@/app/_facades/work/items.server";

const baselineId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const binding = (id: string) => ({ metricId: "m", comparator: "gte", target: { value: 5, unit: "count" }, baselineObservationId: id });
const move = { metricId: "m", direction: "up", baselineObservationId: baselineId };
const item = { id: "task.0001", type: "task", title: "Fixture", status: "needs_implement", node: "operator", actor: "either", assignees: [], externalRefs: [], labels: [], specRefs: [], revision: 1, deployVerified: false, createdAt: "2026-01-01", updatedAt: "2026-01-02", moves: [move] };
const readWorkEdo = vi.fn();
const predictionBatch = vi.fn();
const workReadBatch = vi.fn();
const get = vi.fn();
const listSummaries = vi.fn();
const listBoardColumns = vi.fn();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
const request = (input = new NextRequest("http://localhost/api/v1/work/items/task.0001/expectations")) => GET(input, { params: Promise.resolve({ id: "task.0001" }) });

beforeEach(() => {
  vi.resetAllMocks();
  log.child.mockReturnValue(log);
  fake.user = { id: "u", walletAddress: null, displayName: null, avatarColor: null };
  fake.container = { config: { unhandledErrorPolicy: "respond_500" }, log, clock: { now: () => new Date().toISOString() }, doltgresWorkItems: { get, listSummaries, listBoardColumns }, workItemQuery: { get: vi.fn().mockResolvedValue(null) }, knowledgeStorePort: { readWorkEdo }, goalMetrics: { workReadBatch, predictionBatch } };
  get.mockResolvedValue(item);
  workReadBatch.mockResolvedValue([{ baseline: { id: baselineId, status: "ok", value: 2, observedAt: "2026-01-01", unit: "count" }, current: { id: otherId, status: "error", value: null, observedAt: "2026-01-02", viewState: "error", unit: "count" } }]);
  readWorkEdo.mockResolvedValue({ items: [{ hypothesis: { id: "hyp.1", title: "Hypothesis", content: "content", kpiBindings: [binding(baselineId), binding(otherId)] }, outcomes: [], truncated: false }], truncated: false });
  predictionBatch.mockResolvedValue([{ assessment: { status: "failing", value: 3, unit: "count", observationId: otherId, reason: "source_failed" } }]);
});

describe("authenticated work metric projection", () => {
  it("denies missing sessions before any data reads", async () => {
    fake.user = null;
    expect((await request()).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    expect(readWorkEdo).not.toHaveBeenCalled();
    expect(predictionBatch).not.toHaveBeenCalled();
  });
  it("only assesses pinned matching commitments and preserves failure and unknown", async () => {
    const input = new NextRequest("http://localhost/api/v1/work/items/task.0001/expectations");
    const response = await request(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(predictionBatch).toHaveBeenCalledOnce();
    expect(predictionBatch).toHaveBeenCalledWith([binding(baselineId)], input.signal);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", status: 200, outcome: "success" }), expect.any(String));
    expect((await response.json()).items[0].predictions).toEqual([
      { metricId: "m", expected: "gte 5 count", observed: `failing · 3 count · ${otherId} · source_failed` },
      { metricId: "m", expected: "gte 5 count", observed: "unresolved (metric or baseline mismatch)" },
    ]);
  });
  it("fails closed when metrics authority is unavailable", async () => {
    predictionBatch.mockRejectedValue(new Error("authority unavailable"));
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]).toMatchObject({ title: "Hypothesis", content: "content", outcomes: [] });
    expect(body.items[0].predictions[0].observed).toBe("unavailable (metrics_unavailable)");
    expect(body.items[0].predictions[1].observed).toBe("unresolved (metric or baseline mismatch)");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", status: 200, outcome: "error", errorCode: "metrics_unavailable" }), expect.any(String));
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("authority unavailable");
  });
  it("keeps healthy results and recorded outcomes if one matched result is unavailable", async () => {
    get.mockResolvedValue({ ...item, moves: [move, { ...move, baselineObservationId: otherId }] });
    readWorkEdo.mockResolvedValue({ items: [{ hypothesis: { id: "hyp.1", title: "Hypothesis", content: "content", kpiBindings: [binding(baselineId), binding(otherId)] }, outcomes: [{ id: "out.1", title: "Outcome", content: "Recorded" }], truncated: false }], truncated: false });
    const response = await request();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items[0].outcomes).toEqual([{ id: "out.1", title: "Outcome", content: "Recorded" }]);
    expect(body.items[0].predictions[0].observed).toContain(`failing · 3 count · ${otherId}`);
    expect(body.items[0].predictions[1].observed).toBe("unavailable (metrics_unavailable)");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", status: 200, outcome: "error", errorCode: "metrics_unavailable" }), expect.any(String));
  });
  it("records degraded telemetry for an explicit unreadable batch position", async () => {
    predictionBatch.mockResolvedValue([{ viewState: "error", assessment: { status: "not_measured", value: null, unit: "count", observationId: null, reason: "source_failed" } }]);
    const response = await request();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items[0].predictions[0].observed).toContain("not_measured · source_failed · error");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", status: 200, outcome: "error", errorCode: "metrics_unavailable" }), expect.any(String));
  });
  it("marks matched evidence unavailable when the metrics service is missing", async () => {
    (fake.container as { goalMetrics?: unknown }).goalMetrics = undefined;
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].predictions[0].observed).toBe("unavailable (metrics_unavailable)");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", outcome: "error", errorCode: "metrics_unavailable" }), expect.any(String));
  });
  it("does not report a metrics failure when there are no matched bindings", async () => {
    (fake.container as { goalMetrics?: unknown }).goalMetrics = undefined;
    get.mockResolvedValue({ ...item, moves: [] });
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].predictions[0].observed).toBe("unresolved (metric or baseline mismatch)");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: "work.expectations.read", status: 200, outcome: "success" }), expect.any(String));
  });
  it("uses one shared projection for detail, table and composed board", async () => {
    listSummaries.mockResolvedValue({ items: [item], pageInfo: { endCursor: null, hasMore: false } });
    listBoardColumns.mockResolvedValue({ columns: [{ status: "needs_implement", items: [item], pageInfo: { endCursor: null, hasMore: false } }], queryCount: 1 });
    const detail = await getWorkItem(item.id);
    const table = await listWorkSummaries({});
    const board = await listWorkBoardColumns({}, ["needs_implement"], 20);
    // Detail adds the KPI chain (task.0118); with no goals reader here it reads unavailable. Everything else is the shared projection.
    expect(detail?.moves?.map(({ context, ...move }) => ({ context, move }))).toEqual(
      table.items[0]?.moves?.map((move) => ({ context: "unavailable", move })),
    );
    expect(board.columns[0]?.items[0]?.moves).toEqual(table.items[0]?.moves);
    expect(detail?.moves?.[0]).toMatchObject({ baselineObservationId: baselineId, moved: "unknown", baseline: { value: 2, unit: "count" }, current: { viewState: "error" } });
    expect(workReadBatch).toHaveBeenCalledTimes(3);
  });
});
