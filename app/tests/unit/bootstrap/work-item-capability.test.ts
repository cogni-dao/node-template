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

  it("WRITES_NOT_WIDENED: transitionStatus/patch stay on workItemQuery + workItemCommand, never the backlogReader", async () => {
    const item = storedItem;
    const markdown = { list: vi.fn(), get: vi.fn().mockResolvedValue(item) };
    const command = {
      transitionStatus: vi
        .fn()
        .mockResolvedValue({ ...item, status: "done", revision: 4 }),
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
    await cap.transitionStatus({ id: "task.5001", toStatus: "done" });
    await cap.patch({ reason: "test change", id: "task.5001", set: { priority: 3 } });
    expect(markdown.get).toHaveBeenCalledTimes(2);
    expect(command.transitionStatus).toHaveBeenCalledTimes(1);
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
    const ok = (value: number) => ({ id: OBS, status: "ok", value, observedAt: "2026-11-10T00:00:00.000Z" });
    const metrics = (baseline: number, current: number) => ({
      observation: vi.fn().mockResolvedValue({ observation: ok(baseline) }),
      read: vi.fn().mockResolvedValue({ lastGood: ok(current) }),
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
      expect(item?.moves).toEqual([
        {
          metricId: "m-1",
          direction: "up",
          baselineObservationId: OBS,
          baseline: { value: 1, observedAt: "2026-11-10T00:00:00.000Z" },
          current: { value: 3, observedAt: "2026-11-10T00:00:00.000Z" },
          moved: "as_declared",
        },
      ]);
      expect(service.observation).toHaveBeenCalledTimes(1);
      expect(service.read).toHaveBeenCalledTimes(1);
    });

    it("a page of items returns the stored moves and looks up nothing", async () => {
      const service = metrics(1, 3);
      const items = await capability([withMoves, { ...withMoves, id: toWorkItemId("task.5002") }], service).query({});
      expect(items.map((item) => item.moves)).toEqual([
        [{ metricId: "m-1", direction: "up", baselineObservationId: OBS }],
        [{ metricId: "m-1", direction: "up", baselineObservationId: OBS }],
      ]);
      expect(service.observation).not.toHaveBeenCalled();
      expect(service.read).not.toHaveBeenCalled();
    });

    it("with no metrics service the move reads unknown", async () => {
      const [item] = await capability([withMoves], undefined).query({ ids: ["task.5001"] });
      expect(item?.moves?.[0]).toMatchObject({ moved: "unknown" });
    });
  });
});
