// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-item-capability`
 * Purpose: The AI work-item capability queries the live (Doltgres) backlog when wired, and refuses AI patches
 *   to priority <= 1.
 * Scope: Factory with fake ports. No Doltgres.
 * Invariants: QUERY_READS_THE_LIVE_BACKLOG, COMPLETE_SNAPSHOT (queryPage), WRITES_NOT_WIDENED, P0P1_IS_NODE_ADMIN,
 *   PATCH_ON_THE_LIVE_BACKLOG, PATCH_CAS_PASSTHROUGH.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/work-item.ts, story.5101
 * @internal
 */

import { WorkItemPatchConflictError } from "@cogni/ai-tools";
import { toWorkItemId, type WorkItem, type WorkItemCommandPort, type WorkItemQueryPort } from "@cogni/work-items";
import { WorkItemRevisionConflictError } from "@cogni/work-items/adapters/doltgres";
import { describe, expect, it, vi } from "vitest";

import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { createMoveMetricPorts } from "@/bootstrap/capabilities/work-item-moves";

const storedItem: WorkItem = {
  id: toWorkItemId("task.5001"),
  type: "task",
  title: "t",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  revision: 3,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
  deployVerified: false,
};

const empty = { items: [], pageInfo: { endCursor: null, hasMore: false } };

describe("createWorkItemCapability", () => {
  it("query reads the backlogReader (live backlog), not the markdown port", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const backlog = { list: vi.fn().mockResolvedValue(empty) };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(backlog.list).toHaveBeenCalledTimes(1);
    expect(backlog.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
    expect(markdown.list).not.toHaveBeenCalled();
  });

  it("query falls back to the query port when no backlogReader is wired", async () => {
    const markdown = { list: vi.fn().mockResolvedValue(empty), get: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
    });
    await cap.query({ statuses: ["needs_implement"] });
    expect(markdown.list).toHaveBeenCalledWith({
      statuses: ["needs_implement"],
    });
  });

  it("queryPage pages the live backlog: forwards cursor, returns nextCursor (COMPLETE_SNAPSHOT)", async () => {
    const backlog = {
      list: vi
        .fn()
        .mockResolvedValueOnce({ ...empty, nextCursor: "c1" })
        .mockResolvedValueOnce(empty),
    };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    if (!cap.queryPage) throw new Error("queryPage missing");
    expect((await cap.queryPage({ limit: 50 })).nextCursor).toBe("c1");
    expect(
      (await cap.queryPage({ limit: 50, cursor: "c1" })).nextCursor
    ).toBeUndefined();
    expect(backlog.list).toHaveBeenLastCalledWith({ limit: 50, cursor: "c1" });
  });

  it("an AI patch to priority <= 1 is refused before any write", async () => {
    const command = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
    });
    await expect(
      cap.patch({ reason: "test change", id: "task.5001", set: { priority: 0 } })
    ).rejects.toThrow("authz_denied");
    expect(command.patch).not.toHaveBeenCalled();
  });

  it("WRITES_NOT_WIDENED: patch stays on workItemQuery + workItemCommand, never the backlogReader", async () => {
    const item = storedItem;
    const markdown = { list: vi.fn(), get: vi.fn().mockResolvedValue(item) };
    const command = {
      patch: vi.fn().mockResolvedValue({
        ...item,
        type: "task",
        title: "t",
        labels: [],
        assignees: [],
      }),
    };
    const backlog = { list: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
      backlogReader: backlog as unknown as Pick<WorkItemQueryPort, "list">,
    });
    await cap.patch({ reason: "test change", id: "task.5001", set: { priority: 3 } });
    expect(markdown.get).toHaveBeenCalledTimes(1);
    expect(command.patch).toHaveBeenCalledTimes(1);
    expect(backlog.list).not.toHaveBeenCalled();
  });

  it("PATCH_CAS_PASSTHROUGH: the backlogWriter gets expectedRevision + rank; its conflict becomes WorkItemPatchConflictError", async () => {
    const row = {
      ...storedItem,
      id: "task.5001",
      type: "task",
      title: "t",
      status: "needs_implement",
      labels: [],
      assignees: [],
      revision: 8,
    };
    const store = {
      patch: vi
        .fn()
        .mockResolvedValueOnce(row)
        .mockRejectedValueOnce(
          new WorkItemRevisionConflictError("task.5001", 7, 9)
        ),
    };
    const command = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
      backlogWriter: { store, principalId: "system" },
    });
    expect(
      (
        await cap.patch({
          id: "task.5001",
          expectedRevision: 7,
          reason: "test change",
          set: { rank: 2 },
        })
      ).revision
    ).toBe(8);
    expect(store.patch).toHaveBeenLastCalledWith(
      {
        id: "task.5001",
        expectedRevision: 7,
        reason: "test change",
        set: { rank: 2 },
      },
      "system"
    );
    const lost = cap.patch({
      id: "task.5001",
      expectedRevision: 7,
      reason: "test change",
      set: { rank: 3 },
    });
    await expect(lost).rejects.toBeInstanceOf(WorkItemPatchConflictError);
    await expect(lost).rejects.toMatchObject({
      expectedRevision: 7,
      currentRevision: 9,
    });
    expect(command.patch).not.toHaveBeenCalled();
  });

  it("forwards the required reason and the cites to the live store (task.0086)", async () => {
    const row = {
      ...storedItem,
      id: "task.5001",
      type: "task",
      title: "t",
      status: "needs_implement",
      labels: [],
      assignees: [],
      revision: 8,
    };
    const store = { patch: vi.fn().mockResolvedValue(row) };
    const cap = createWorkItemCapability({
      workItemQuery: { list: vi.fn(), get: vi.fn() } as unknown as WorkItemQueryPort,
      workItemCommand: { patch: vi.fn() } as unknown as WorkItemCommandPort,
      backlogWriter: { store, principalId: "system" },
    });
    const cites = [{ id: "change-history-design" }];
    await cap.patch({ id: "task.5001", reason: "scope follows the design", cites, set: { rank: 2 } });
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: "task.5001", reason: "scope follows the design", cites, set: { rank: 2 } },
      "system"
    );
  });

  it("the markdown fallback refuses a caller expectedRevision instead of dropping it", async () => {
    const command = { patch: vi.fn() };
    const markdown = { list: vi.fn(), get: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: markdown as unknown as WorkItemQueryPort,
      workItemCommand: command as unknown as WorkItemCommandPort,
    });
    await expect(
      cap.patch({ reason: "test change", id: "task.5001", expectedRevision: 7, set: { rank: 2 } })
    ).rejects.toThrow("expectedRevision requires the Doltgres backlog writer");
    expect(markdown.get).not.toHaveBeenCalled();
    expect(command.patch).not.toHaveBeenCalled();
  });
  it("attributes score writes to each invocation's actor and reads every score back", async () => {
    const scores = Object.fromEntries(
      ["goal", "time", "unblocks", "ease", "confidence", "agent"].map(
        (axis) => [axis, { v: 4, ev: "https://external.example/proof" }]
      )
    );
    const row = {
      ...storedItem,
      id: "task.5001",
      type: "task",
      title: "t",
      status: "needs_implement",
      labels: [],
      assignees: [],
      revision: 8,
      scores,
    };
    const store = { patch: vi.fn().mockResolvedValue(row) };
    let actor = "authenticated-user-a";
    const cap = createWorkItemCapability({
      workItemQuery: {
        list: vi.fn(),
        get: vi.fn(),
      } as unknown as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogReader: {
        list: vi.fn().mockResolvedValue({ ...empty, items: [row] }),
      } as unknown as Pick<WorkItemQueryPort, "list">,
      backlogWriter: { store, principalId: () => actor },
    });
    expect(
      (await cap.patch({ reason: "test change", id: row.id, expectedRevision: 7, set: { scores } }))
        .scores
    ).toEqual(scores);
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: row.id, expectedRevision: 7, reason: "test change", set: { scores } },
      "authenticated-user-a"
    );
    actor = "scheduled-grant-user-b";
    await cap.patch({ reason: "test change", id: row.id, set: { scores } });
    expect(store.patch).toHaveBeenLastCalledWith(
      { id: row.id, reason: "test change", set: { scores } },
      "scheduled-grant-user-b"
    );
    const readback = (await cap.query({ ids: [row.id] }))[0];
    expect(readback?.scores).toEqual(scores);
    expect(readback?.rankScore).toBe(6.4);
  });

  it("a missing authenticated run actor fails before the live store writes", async () => {
    const store = { patch: vi.fn() };
    const cap = createWorkItemCapability({
      workItemQuery: {} as WorkItemQueryPort,
      workItemCommand: {} as WorkItemCommandPort,
      backlogWriter: {
        store,
        principalId: () => {
          throw new Error("authenticated run actorUserId is required");
        },
      },
    });
    await expect(
      cap.patch({ reason: "test change", id: "task.5001", set: { scores: { goal: { v: 3 } } } })
    ).rejects.toThrow("actorUserId is required");
    expect(store.patch).not.toHaveBeenCalled();
  });

  // story.0033: a one-item read (core__work_item_read) judges each move; a page does not.
  describe("moves at read time", () => {
    const OBS = "11111111-1111-4111-8111-111111111111";
    const withMoves: WorkItem = {
      ...storedItem,
      moves: [{ metricId: "m-1", direction: "up", baselineObservationId: OBS }],
    };
    const ok = (value: number) => ({ id: OBS, metricId: "m-1", status: "ok", value, observedAt: "2026-11-10T00:00:00.000Z", definitionHash: "h", calculatorVersion: "work.count@1", paramsHash: "p", node: "n", environment: "test", dataScope: "node-members", unit: "items", window: { start: "2026-11-09T23:00:00.000Z", end: "2026-11-10T00:00:00.000Z" }, sourceWatermarks: [{ source: "test", asOf: "2026-11-10T00:00:00.000Z" }], viewState: "ok", maxAgeSeconds: 7200 });
    const metrics = (baseline: number, current: number) => ({
      workReadBatch: vi.fn().mockResolvedValue([{ baseline: ok(baseline), current: ok(current) }]),
    });
    const capability = (items: WorkItem[], service: ReturnType<typeof metrics> | undefined) =>
      createWorkItemCapability({
        workItemQuery: {} as WorkItemQueryPort,
        workItemCommand: {} as WorkItemCommandPort,
        backlogReader: {
          list: vi.fn().mockResolvedValue({ items, pageInfo: { endCursor: null, hasMore: false } }),
        } as unknown as Pick<WorkItemQueryPort, "list">,
        moveReadings: createMoveMetricPorts(() => service as never).readings,
      });

    it("a read that returns one item adds the baseline, current reading and verdict", async () => {
      const service = metrics(1, 3);
      const [item] = await capability([withMoves], service).query({ ids: ["task.5001"], limit: 1 });
      expect(item?.moves).toMatchObject([
        {
          metricId: "m-1",
          direction: "up",
          baselineObservationId: OBS,
          baseline: { value: 1, observedAt: "2026-11-10T00:00:00.000Z" },
          current: { value: 3, observedAt: "2026-11-10T00:00:00.000Z" },
          moved: "as_declared",
        },
      ]);
      expect(service.workReadBatch).toHaveBeenCalledOnce();
      expect(service.workReadBatch).toHaveBeenCalledWith([{ metricId: "m-1", baselineObservationId: OBS }], expect.any(AbortSignal));
    });

    it("a page of items returns the stored moves and looks up nothing", async () => {
      const service = metrics(1, 3);
      const items = await capability([withMoves, { ...withMoves, id: toWorkItemId("task.5002") }], service).query({});
      expect(items.map((item) => item.moves)).toEqual([
        [{ metricId: "m-1", direction: "up", baselineObservationId: OBS }],
        [{ metricId: "m-1", direction: "up", baselineObservationId: OBS }],
      ]);
      expect(service.workReadBatch).not.toHaveBeenCalled();
    });

    it("a deprecated metric (metric_not_found) reads unknown with metric_deprecated", async () => {
      const service = {
        workReadBatch: vi.fn().mockResolvedValue([{ baseline: null, current: null, unknownReason: "metric_deprecated" }]),
      };
      const [item] = await capability([withMoves], service as never).query({ ids: ["task.5001"] });
      expect(item?.moves?.[0]).toMatchObject({ moved: "unknown", unknownReason: "metric_deprecated" });
      expect(service.workReadBatch).toHaveBeenCalledOnce();
    });

    it("with no metrics service the move reads unknown", async () => {
      const [item] = await capability([withMoves], undefined).query({ ids: ["task.5001"] });
      expect(item?.moves?.[0]).toMatchObject({ moved: "unknown" });
    });

    // task.0118: `read` is the single-item envelope; query and queryPage never resolve the chain.
    describe("read (single-item envelope)", () => {
      const goalsPort = {
        listActiveGoals: vi.fn().mockResolvedValue([
          {
            id: "goal-1",
            title: "Goal one",
            evaluateAt: null,
            kpiBindings: [{ metricId: "m-1", comparator: "gte", target: { value: 5, unit: "items" } }],
          },
        ]),
      };
      const chainService = (service: ReturnType<typeof metrics>) => ({
        ...service,
        describe: vi.fn().mockResolvedValue([{ id: "m-1", title: "Metric one", unit: "items", display: "volume" }]),
        kpi: vi.fn().mockResolvedValue({ viewState: "ok", assessment: { status: "on_track" } }),
      });
      const build = (service: unknown, readLinks?: (id: string) => Promise<never>) =>
        createWorkItemCapability({
          workItemQuery: {} as WorkItemQueryPort,
          workItemCommand: {} as WorkItemCommandPort,
          backlogReader: {
            list: vi.fn().mockResolvedValue({ items: [withMoves], pageInfo: { endCursor: null, hasMore: false } }),
          } as unknown as Pick<WorkItemQueryPort, "list">,
          moveReadings: createMoveMetricPorts(() => service as never, () => goalsPort as never).readings,
          ...(readLinks ? { links: { firstPage: readLinks } } : {}),
        });

      it("adds readings, the chain and (on request) links; query does not", async () => {
        const service = chainService(metrics(1, 3));
        const readLinks = vi.fn().mockResolvedValue({ items: [], nextCursor: "n1" });
        const cap = build(service, readLinks);
        const read = await cap.read?.("task.5001", { includeLinks: true });
        expect(read?.moves?.[0]).toMatchObject({
          moved: "as_declared",
          metric: { id: "m-1", title: "Metric one", unit: "items" },
          kpi: { metricId: "m-1", comparator: "gte", status: "on_track" },
          goal: { id: "goal-1", title: "Goal one" },
        });
        expect(read?.links).toEqual({ items: [], nextCursor: "n1" });
        const [queried] = await cap.query({ ids: ["task.5001"], limit: 1 });
        expect(queried?.moves?.[0]).not.toHaveProperty("kpi");
        expect(queried).not.toHaveProperty("links");
        expect(service.describe).toHaveBeenCalledOnce();
      });

      it("reads links as unavailable when no links reader is wired, and omits them unless asked", async () => {
        const service = chainService(metrics(1, 3));
        const cap = build(service);
        expect((await cap.read?.("task.5001", { includeLinks: true }))?.links).toEqual({
          items: [],
          nextCursor: null,
          unavailable: true,
        });
        expect(await cap.read?.("task.5001")).not.toHaveProperty("links");
        expect(await cap.read?.("task.9999")).toBeNull();
      });

      it("marks the chain unavailable, never absent-as-empty, when the metrics service cannot describe", async () => {
        const service = {
          ...metrics(1, 3),
          describe: vi.fn().mockRejectedValue(new Error("definitions down")),
        };
        const read = await build(service).read?.("task.5001");
        expect(read?.moves?.[0]).toMatchObject({ moved: "as_declared", context: "unavailable" });
        expect(read?.moves?.[0]).not.toHaveProperty("kpi");
      });
    });
  });
});

describe("recordArtifact (task.0122)", () => {
  const body = { kind: "triage", subject: "work:task.5001", verdict: "implement", note: "no KPI measures this yet" };
  const ports = {
    workItemQuery: { list: vi.fn(), get: vi.fn() } as unknown as WorkItemQueryPort,
    workItemCommand: {} as unknown as WorkItemCommandPort,
  };

  it("is absent when no artifact wiring is given, so the tool fails loudly", () => {
    expect(createWorkItemCapability(ports).recordArtifact).toBeUndefined();
  });

  it("calls the route's handler with the run's principal and returns its status and body", async () => {
    const stored: unknown[] = [];
    const cap = createWorkItemCapability({
      ...ports,
      artifacts: {
        principalId: () => "agent-principal",
        deps: () => ({
          items: { get: async () => ({ revision: 3 }) },
          artifacts: {
            insert: async (row: Record<string, unknown>) => {
              stored.push(row);
              return { id: "wia-1", seq: 1, itemRevision: 3, createdAt: "2026-11-14T00:00:00.000Z", ...row };
            },
            list: async () => [],
            latest: async () => [],
          },
        }) as never,
      },
    });
    const result = await cap.recordArtifact?.({ id: "task.5001", body });
    expect(result?.status).toBe(201);
    expect(stored).toEqual([expect.objectContaining({ itemId: "task.5001", kind: "triage", author: "agent-principal" })]);
    expect(result?.body).toMatchObject({ artifact: { id: "wia-1", kind: "triage" } });
  });

  it("answers 503 and writes nothing when this node serves no artifacts", async () => {
    const cap = createWorkItemCapability({
      ...ports,
      artifacts: { principalId: () => "agent-principal", deps: () => undefined },
    });
    const result = await cap.recordArtifact?.({ id: "task.5001", body });
    expect(result).toMatchObject({ status: 503, body: { errorCode: "artifacts_unavailable" } });
  });

  it("resolves the principal at call time: no run subject throws before any write", async () => {
    const cap = createWorkItemCapability({
      ...ports,
      artifacts: {
        principalId: () => {
          throw new Error("a run subject or agent principal is required");
        },
        deps: () => ({ items: { get: async () => ({ revision: 3 }) }, artifacts: {} }) as never,
      },
    });
    await expect(cap.recordArtifact?.({ id: "task.5001", body })).rejects.toThrow("principal is required");
  });
});
