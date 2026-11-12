// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-envelope`
 * Purpose: The single-item read carries each move's metric, KPI and goal, and `include=links` adds the first citation page (task.0118).
 * Scope: Mocks the container, the metrics service and the knowledge store. No database.
 * Invariants: chain resolved from definitions plus active goals' bindings (never the goal progress read);
 *   an unresolved chain is `context: "unavailable"`, unreadable links are `unavailable`, never empty or invented.
 * Side-effects: none
 * Links: src/app/_facades/work/items.server.ts
 * @internal
 */

import { WorkItemDtoSchema } from "@cogni/node-contracts";
import { toWorkItemId, type WorkItem } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { getWorkItem } from "@/app/_facades/work/items.server";
import { getContainer } from "@/bootstrap/container";

const OBS = "11111111-1111-4111-8111-111111111111";
const item = (moves: WorkItem["moves"]): WorkItem => ({
  id: toWorkItemId("story.0035"),
  type: "story",
  title: "Work story",
  status: "needs_implement",
  assignees: [],
  externalRefs: [],
  labels: ["goal:goal-ai-work-converges"],
  specRefs: [],
  revision: 3,
  deployVerified: false,
  createdAt: "2026-11-01",
  updatedAt: "2026-11-02",
  actor: "either",
  ...(moves ? { moves } : {}),
});

const goals = [
  {
    id: "goal-ai-work-converges",
    title: "AI work converges faster than it sprawls",
    evaluateAt: null,
    kpiBindings: [
      { metricId: "work-validated", comparator: "gte", target: { value: 10, unit: "items" } },
    ],
  },
];
const summaries: Record<string, object> = {
  "work-validated": { id: "work-validated", title: "Validated work", unit: "items", display: "progress" },
  "work-open": { id: "work-open", title: "Open work", unit: "items", serves: { kpi: "work-validated", role: "input" } },
};

function setup(
  moves: WorkItem["moves"],
  overrides: { describe?: ReturnType<typeof vi.fn>; listActiveGoals?: ReturnType<typeof vi.fn>; listCitationLinks?: ReturnType<typeof vi.fn> } = {},
) {
  const describeMetrics =
    overrides.describe ??
    vi.fn(async (ids: string[]) => ids.flatMap((id) => (summaries[id] ? [summaries[id]] : [])));
  const goalMetrics = {
    describe: describeMetrics,
    kpi: vi.fn(async () => ({ viewState: "ok", assessment: { status: "behind" } })),
    workReadBatch: vi.fn(async (requests: unknown[]) => requests.map(() => ({ baseline: null, current: null }))),
  };
  const knowledgeStorePort = {
    listActiveGoals: overrides.listActiveGoals ?? vi.fn(async () => goals),
    listCitationLinks:
      overrides.listCitationLinks ??
      vi.fn(async () => ({
        links: [
          {
            id: "c1",
            citingId: "story.0035",
            citedId: "goal-ai-work-converges",
            citationType: "extends",
            context: null,
            sourceTitle: "Work story",
            targetTitle: "AI work converges faster than it sprawls",
          },
        ],
        nextCursor: "next-1",
      })),
  };
  vi.mocked(getContainer).mockReturnValue({
    doltgresWorkItems: { get: vi.fn().mockResolvedValue(item(moves)) },
    workItemQuery: { get: vi.fn() },
    goalMetrics,
    knowledgeStorePort,
  } as never);
  return { goalMetrics, knowledgeStorePort, describeMetrics };
}

describe("single-item envelope (task.0118)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("a moved KPI resolves to itself with its goal; a supporting metric resolves the KPI it serves", async () => {
    const { goalMetrics } = setup([
      { metricId: "work-validated", direction: "up", baselineObservationId: OBS },
      { metricId: "work-open", direction: "down", baselineObservationId: null },
    ]);
    const result = await getWorkItem("story.0035");
    expect(() => WorkItemDtoSchema.parse(result)).not.toThrow();
    const [direct, supporting] = result?.moves ?? [];
    expect(direct).toMatchObject({
      metric: { id: "work-validated", title: "Validated work", unit: "items", display: "progress" },
      kpi: { metricId: "work-validated", title: "Validated work", comparator: "gte", target: { value: 10, unit: "items" }, status: "behind" },
      goal: { id: "goal-ai-work-converges", title: "AI work converges faster than it sprawls" },
    });
    expect(supporting).toMatchObject({
      metric: { id: "work-open", title: "Open work" },
      kpi: { metricId: "work-validated", title: "Validated work" },
      goal: { id: "goal-ai-work-converges" },
    });
    expect(direct?.context).toBeUndefined();
    // One KPI assessed once, latest only.
    expect(goalMetrics.kpi).toHaveBeenCalledOnce();
    expect(goalMetrics.kpi.mock.calls[0]?.[1]).toMatchObject({ latestOnly: true });
    expect(result).not.toHaveProperty("links");
  });

  it("an unknown metric reads context unavailable without invented fields; the item still reads", async () => {
    setup([{ metricId: "no-such-metric", direction: "up", baselineObservationId: null }]);
    const result = await getWorkItem("story.0035");
    expect(result?.moves?.[0]).toMatchObject({ metricId: "no-such-metric", context: "unavailable" });
    expect(result?.moves?.[0]).not.toHaveProperty("metric");
    expect(result?.moves?.[0]).not.toHaveProperty("kpi");
    expect(result?.moves?.[0]).not.toHaveProperty("goal");
  });

  it("a failed resolution (goals read down) marks every move unavailable and keeps the readings", async () => {
    setup([{ metricId: "work-validated", direction: "up", baselineObservationId: OBS }], {
      listActiveGoals: vi.fn().mockRejectedValue(new Error("goals 503")),
    });
    const result = await getWorkItem("story.0035");
    expect(result?.moves?.[0]).toMatchObject({
      metricId: "work-validated",
      context: "unavailable",
      moved: "unknown",
    });
  });

  it("include=links adds the first citation page from the same read the UI uses, with nextCursor", async () => {
    const { knowledgeStorePort } = setup([]);
    const result = await getWorkItem("story.0035", { includeLinks: true });
    expect(knowledgeStorePort.listCitationLinks).toHaveBeenCalledWith("story.0035", undefined);
    expect(result?.links?.nextCursor).toBe("next-1");
    expect(result?.links?.items[0]).toMatchObject({
      id: "c1",
      direction: "out",
      citationType: "extends",
      source: { id: "story.0035", kind: "work", href: "/work/items/story.0035" },
      target: { id: "goal-ai-work-converges", kind: "knowledge", href: "/knowledge/goal-ai-work-converges" },
    });
    expect(result?.links).not.toHaveProperty("unavailable");
  });

  it("links are absent by default and unavailable, never empty, when the read fails", async () => {
    const off = setup([]);
    expect(await getWorkItem("story.0035")).not.toHaveProperty("links");
    expect(off.knowledgeStorePort.listCitationLinks).not.toHaveBeenCalled();
    setup([], { listCitationLinks: vi.fn().mockRejectedValue(new Error("down")) });
    const failed = await getWorkItem("story.0035", { includeLinks: true });
    expect(failed?.links).toEqual({ items: [], nextCursor: null, unavailable: true });
  });

  it("chain: false (the EDO expectations read) skips the chain and its reads", async () => {
    const { describeMetrics, knowledgeStorePort } = setup([
      { metricId: "work-validated", direction: "up", baselineObservationId: OBS },
    ]);
    const result = await getWorkItem("story.0035", { chain: false });
    expect(describeMetrics).not.toHaveBeenCalled();
    expect(knowledgeStorePort.listActiveGoals).not.toHaveBeenCalled();
    expect(result?.moves?.[0]).not.toHaveProperty("context");
  });
});
