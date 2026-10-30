// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleConfig,
  type GovernanceScheduleSyncDeps,
  governanceGraphMessage,
  type ScheduleDescription,
  syncGovernanceSchedules,
} from "../src/routing";

const entry = {
  charter: "MISSION_DECIDE",
  cron: "0 * * * *",
  timezone: "UTC",
  entrypoint: "DECIDE",
  graph: "langgraph:cogni-decide",
  model: "deepseek-v4-flash",
};
const id = "governance:node-a:mission_decide";
function deps() {
  return {
    nodeId: "node-a",
    systemUserId: "system",
    scheduleIdFor: (charter: string) =>
      `governance:node-a:${charter.toLowerCase()}`,
    ownsScheduleId: (value: string) =>
      value.startsWith("governance:node-a:") && value.split(":").length === 3,
    isConflictError: (error: unknown) => error === "conflict",
    isNotFoundError: (error: unknown) => error === "missing",
    ensureGovernanceGrant: vi.fn().mockResolvedValue("sandbox-grant"),
    ensureGraphGrant: vi.fn().mockResolvedValue("graph-grant"),
    resolveLedgerIngestExecution: vi
      .fn<GovernanceScheduleSyncDeps["resolveLedgerIngestExecution"]>()
      .mockResolvedValue(null),
    upsertGovernanceScheduleRow: vi.fn().mockResolvedValue("db-id"),
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi
        .fn<GovernanceScheduleSyncDeps["scheduleControl"]["describeSchedule"]>()
        .mockResolvedValue(null),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
    },
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies GovernanceScheduleSyncDeps;
}
function conflict(
  d: ReturnType<typeof deps>,
  desc: Partial<ScheduleDescription> = {}
) {
  d.scheduleControl.createSchedule.mockRejectedValue("conflict");
  d.scheduleControl.describeSchedule.mockResolvedValue({
    scheduleId: id,
    isPaused: true,
    cron: null,
    timezone: "UTC",
    input: {
      messages: [{ role: "user", content: "DECIDE" }],
      modelRef: { providerKey: "platform", modelId: entry.model },
    },
    dbScheduleId: "db-id",
    nextRunAtIso: null,
    lastRunAtIso: null,
    ...desc,
  });
}
describe("published governance routing", () => {
  it("routes declared graph/model with its own grant and exact optional payload", async () => {
    const d = deps();
    await syncGovernanceSchedules(
      { schedules: [{ ...entry, payload: { trusted: true } }] },
      d
    );
    expect(d.ensureGraphGrant).toHaveBeenCalledWith(entry.graph);
    expect(d.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: id,
        nodeId: "node-a",
        dbScheduleId: "db-id",
        graphId: entry.graph,
        executionGrantId: "graph-grant",
        overlapPolicy: "skip",
        catchupWindowMs: 0,
        input: {
          messages: [
            {
              role: "user",
              content: 'DECIDE\n\n```json\n{"trusted":true}\n```',
            },
          ],
          modelRef: { providerKey: "platform", modelId: entry.model },
        },
      })
    );
    expect(governanceGraphMessage("DECIDE", undefined)).toBe("DECIDE");
  });
  it("reapplies full graph action before resume even when description matches", async () => {
    const d = deps();
    conflict(d);
    await syncGovernanceSchedules(
      { schedules: [{ ...entry, cron: "0 */2 * * *" }] },
      d
    );
    expect(d.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        cron: "0 */2 * * *",
        graphId: entry.graph,
        executionGrantId: "graph-grant",
        dbScheduleId: "db-id",
      })
    );
    expect(
      d.scheduleControl.updateSchedule.mock.invocationCallOrder[0]
    ).toBeLessThan(
      d.scheduleControl.resumeSchedule.mock.invocationCallOrder[0] ?? 0
    );
  });
  it("never resumes after failed desired-action update", async () => {
    const d = deps();
    conflict(d);
    d.scheduleControl.updateSchedule.mockRejectedValue(
      new Error("unavailable")
    );
    await expect(
      syncGovernanceSchedules({ schedules: [entry] }, d)
    ).rejects.toThrow("unavailable");
    expect(d.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });
  it("preserves legacy sandbox and injected ledger envelope, grant and queue drift", async () => {
    const d = deps();
    const envelope = { version: 1, scopeId: "scope" };
    d.resolveLedgerIngestExecution.mockResolvedValue({
      desiredInput: envelope,
      graphId: "ledger:ingest",
      grantId: "sandbox-grant",
      workflowType: "CollectEpochWorkflow",
      taskQueueOverride: "ledger-tasks-node-a",
    });
    conflict(d, {
      isPaused: false,
      input: envelope,
      taskQueue: "ledger-tasks-old",
    });
    const ledger = { ...entry, charter: "LEDGER_INGEST" };
    await syncGovernanceSchedules({ schedules: [ledger] }, d);
    expect(d.ensureGovernanceGrant).toHaveBeenCalledTimes(1);
    expect(d.resolveLedgerIngestExecution).toHaveBeenCalledWith(
      expect.objectContaining({ governanceGrantId: "sandbox-grant" })
    );
    expect(d.ensureGraphGrant).not.toHaveBeenCalled();
    expect(d.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:node-a:ledger_ingest",
      expect.objectContaining({
        input: envelope,
        taskQueueOverride: "ledger-tasks-node-a",
        workflowType: "CollectEpochWorkflow",
        executionGrantId: "sandbox-grant",
      })
    );
    const fallback = deps();
    await syncGovernanceSchedules(
      { schedules: [{ ...entry, graph: undefined }] },
      fallback
    );
    expect(fallback.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "sandbox:openclaw",
        input: { message: "DECIDE", model: "kimi-k2.5" },
        executionGrantId: "sandbox-grant",
      })
    );
  });
  it("supports ledger resolver null fallthrough without reminting governance grant", async () => {
    const d = deps();
    await syncGovernanceSchedules(
      { schedules: [{ ...entry, charter: "LEDGER_INGEST" }] },
      d
    );
    expect(d.ensureGovernanceGrant).toHaveBeenCalledTimes(1);
    expect(d.ensureGraphGrant).toHaveBeenCalledWith(entry.graph);
  });
  it.each([
    [{ ...entry }, { ...entry, charter: "mission_decide" }],
    [{ ...entry, charter: "bad:separator" }],
  ])(
    "rejects duplicate or separator IDs before grants/writes",
    async (...schedules) => {
      const d = deps();
      await expect(
        syncGovernanceSchedules({ schedules } as GovernanceScheduleConfig, d)
      ).rejects.toThrow();
      expect(d.ensureGovernanceGrant).not.toHaveBeenCalled();
      expect(d.upsertGovernanceScheduleRow).not.toHaveBeenCalled();
      expect(d.scheduleControl.createSchedule).not.toHaveBeenCalled();
    }
  );
  it("rejects mismatched ownership and node separators before writes", async () => {
    const d = deps();
    d.scheduleIdFor = () => "governance:node-b:x";
    await expect(
      syncGovernanceSchedules({ schedules: [entry] }, d)
    ).rejects.toThrow();
    expect(d.ensureGovernanceGrant).not.toHaveBeenCalled();
    const invalid = deps();
    invalid.nodeId = "node:a";
    await expect(
      syncGovernanceSchedules({ schedules: [] }, invalid)
    ).rejects.toThrow();
    expect(invalid.ensureGovernanceGrant).not.toHaveBeenCalled();
  });
  it("prunes own removed IDs but never sibling or arbitrary legacy IDs", async () => {
    const d = deps();
    d.listGovernanceScheduleIds.mockResolvedValue([
      "governance:node-a:removed",
      "governance:node-b:removed",
      "governance:ledger_ingest",
    ]);
    const result = await syncGovernanceSchedules({ schedules: [] }, d);
    expect(result.paused).toEqual(["governance:node-a:removed"]);
    expect(d.disableSchedule).toHaveBeenCalledExactlyOnceWith(
      "governance:node-a:removed"
    );
    expect(d.scheduleControl.pauseSchedule).toHaveBeenCalledExactlyOnceWith(
      "governance:node-a:removed"
    );
  });
  it("pauses stale own graph when graph grant capability is absent", async () => {
    const d: GovernanceScheduleSyncDeps = deps();
    d.ensureGraphGrant = undefined;
    d.listGovernanceScheduleIds = async () => [id];
    const result = await syncGovernanceSchedules({ schedules: [entry] }, d);
    expect(result).toMatchObject({ skipped: [id], paused: [id], created: [] });
  });
});

it("supports a scoped mission with only the exact legacy ledger exception", async () => {
  const d = deps();
  const prefix = "governance:node-a:";
  d.scheduleIdFor = (charter) =>
    charter === "LEDGER_INGEST"
      ? "governance:ledger_ingest"
      : `${prefix}${charter.toLowerCase()}`;
  d.ownsScheduleId = (value) =>
    value === "governance:ledger_ingest" ||
    (value.startsWith(prefix) && value.split(":").length === 3);
  d.resolveLedgerIngestExecution.mockResolvedValue({
    desiredInput: { version: 1 },
    graphId: "ledger:ingest",
    grantId: "sandbox-grant",
    workflowType: "CollectEpochWorkflow",
    taskQueueOverride: "ledger-tasks",
  });
  d.listGovernanceScheduleIds.mockResolvedValue([
    "governance:node-a:removed",
    "governance:other",
    "governance:node-b:mission_decide",
  ]);
  await syncGovernanceSchedules(
    { schedules: [entry, { ...entry, charter: "LEDGER_INGEST" }] },
    d
  );
  expect(
    d.scheduleControl.createSchedule.mock.calls.map(
      ([params]) => params.scheduleId
    )
  ).toEqual([id, "governance:ledger_ingest"]);
  expect(d.scheduleControl.pauseSchedule).toHaveBeenCalledExactlyOnceWith(
    "governance:node-a:removed"
  );
});
