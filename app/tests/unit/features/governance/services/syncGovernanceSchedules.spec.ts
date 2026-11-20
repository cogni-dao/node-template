// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/services/syncGovernanceSchedules`
 * Purpose: Unit tests for governance schedule sync logic.
 * Scope: Tests sync function with mocked ScheduleControlPort; verifies node-scoped ids, the operator-owned ledger skip, update/prune behavior and that no flat or foreign id is ever written. Does not test Temporal integration or DB operations.
 * Invariants: Prune pauses (never deletes); conflict = update or skip or resume; idempotent on repeat.
 * Side-effects: none (all deps mocked)
 * Links: src/features/governance/services/syncGovernanceSchedules.ts
 * @public
 */

import {
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleDescription,
} from "../../../../../../packages/scheduler-core/src/ports/schedule-control.port";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleSyncDeps,
  governanceScheduleId,
  isLegacyFlatGovernanceScheduleId,
  isOwnGovernanceScheduleId,
  syncGovernanceSchedules,
} from "../../../../../../packages/scheduler-core/src/services/syncGovernanceSchedules";
import type { GovernanceConfig } from "@/shared/config";

const GRANT_ID = "test-grant-id-001";
const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const MOCK_DB_SCHEDULE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DEFAULT_GRAPH = "langgraph:cogni";
const DEFAULT_MODEL = "gpt-oss-120b";
const NODE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";
const OTHER_NODE_ID = "11111111-2222-4333-8444-555555555555";
/** The operator's FLAT ledger schedule: a node must never write, update or pause it. */
const FLAT_LEDGER_ID = "governance:ledger_ingest";
/** The operator's dispatch schedule for THIS node: operator-owned, never written by the node. */
const OWN_LEDGER_ID = `governance:${NODE_ID}:ledger_ingest`;
/** Scoped id helper for a charter of this node. */
const own = (charter: string) => `governance:${NODE_ID}:${charter}`;

/** Counter-based mock to return unique dbScheduleIds per call */
let upsertCallCount = 0;

function makeMockDeps(
  overrides?: Partial<GovernanceScheduleSyncDeps>
): GovernanceScheduleSyncDeps {
  upsertCallCount = 0;
  return {
    ensureGovernanceGrant: vi.fn().mockResolvedValue(GRANT_ID),
    ensureGraphGrant: vi.fn().mockResolvedValue(GRANT_ID),
    upsertGovernanceScheduleRow: vi.fn().mockImplementation(() => {
      upsertCallCount++;
      return Promise.resolve(`${MOCK_DB_SCHEDULE_ID}-${upsertCallCount}`);
    }),
    systemUserId: SYSTEM_USER_ID,
    nodeId: NODE_ID,
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi.fn().mockResolvedValue(null),
      listScheduleIds: vi.fn().mockResolvedValue([]),
    },
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

/** Charters default to a graph charter (`langgraph:cogni` + platform model). */
function makeConfig(
  charters: Array<{
    charter: string;
    cron: string;
    entrypoint: string;
    timezone?: string;
    graph?: string;
    model?: string;
  }>
): GovernanceConfig {
  return {
    schedules: charters.map((c) => ({
      charter: c.charter,
      cron: c.cron,
      timezone: c.timezone ?? "UTC",
      entrypoint: c.entrypoint,
      graph: c.graph ?? DEFAULT_GRAPH,
      model: c.model ?? DEFAULT_MODEL,
    })),
  };
}

/** Ledger-only config: the repo-spec synthesizes this charter for any node with an activity ledger. */
function makeLedgerConfig(): GovernanceConfig {
  return {
    schedules: [
      {
        charter: "LEDGER_INGEST",
        cron: "0 0 * * *",
        timezone: "UTC",
        entrypoint: "LEDGER_INGEST",
      },
    ],
    ledger: LEDGER,
  };
}

/** Helper: a Temporal description of an existing community schedule. */
function makeDesc(
  scheduleId: string,
  opts?: { isPaused?: boolean; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron: null,
    timezone: "UTC",
    input: {
      messages: [{ role: "user", content: "COMMUNITY" }],
      modelRef: { providerKey: "platform", modelId: DEFAULT_MODEL },
    },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

function mockExistingSchedule(
  deps: GovernanceScheduleSyncDeps,
  desc: ScheduleDescription
): void {
  deps.scheduleControl.createSchedule = vi
    .fn()
    .mockRejectedValue(new ScheduleControlConflictError(desc.scheduleId));
  deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(desc);
}

/** Every schedule id a sync touched through the Temporal port. */
function touchedIds(deps: GovernanceScheduleSyncDeps): string[] {
  const sc = deps.scheduleControl;
  const ids = [
    ...vi.mocked(sc.createSchedule).mock.calls.map(([p]) => p.scheduleId),
    ...vi.mocked(sc.updateSchedule).mock.calls.map(([id]) => id),
    ...vi.mocked(sc.pauseSchedule).mock.calls.map(([id]) => id),
    ...vi.mocked(sc.resumeSchedule).mock.calls.map(([id]) => id),
  ];
  return ids;
}

describe("syncGovernanceSchedules", () => {
  let deps: GovernanceScheduleSyncDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  it("creates node-scoped schedules for each charter in config", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      { charter: "GOVERN", cron: "0 * * * *", entrypoint: "GOVERN" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([own("community"), own("govern")]);
    // Upsert called for each schedule before Temporal creation
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(2);
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalScheduleId: own("community"),
        ownerUserId: SYSTEM_USER_ID,
        graphId: DEFAULT_GRAPH,
      })
    );
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(2);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: own("community"),
        nodeId: NODE_ID,
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
        cron: "0 */6 * * *",
        timezone: "UTC",
        graphId: DEFAULT_GRAPH,
        executionGrantId: GRANT_ID,
        input: {
          messages: [{ role: "user", content: "COMMUNITY" }],
          modelRef: { providerKey: "platform", modelId: DEFAULT_MODEL },
        },
        overlapPolicy: "skip",
        catchupWindowMs: 0,
      })
    );
  });

  it("NODE_SCOPED_SCHEDULE_ID: never writes a flat id for any charter", async () => {
    await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
        { charter: "WORK_PRIORITIZER", cron: "0 * * * *", entrypoint: "WP" },
      ]),
      deps
    );

    const ids = touchedIds(deps);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.startsWith(`governance:${NODE_ID}:`)).toBe(true);
    }
    expect(deps.upsertGovernanceScheduleRow).not.toHaveBeenCalledWith(
      expect.objectContaining({ temporalScheduleId: "governance:community" })
    );
  });

  it("ensures governance grant before creating schedules", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    await syncGovernanceSchedules(config, deps);

    expect(deps.ensureGovernanceGrant).toHaveBeenCalledOnce();
  });

  it("LEDGER_COLLECT_IS_OPERATOR_OWNED: skips the ledger charter with no DB row and no Temporal write", async () => {
    const result = await syncGovernanceSchedules(makeLedgerConfig(), deps);

    expect(result.skipped).toEqual([OWN_LEDGER_ID]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(deps.upsertGovernanceScheduleRow).not.toHaveBeenCalled();
    expect(touchedIds(deps)).toEqual([]);
    expect(deps.scheduleControl.describeSchedule).not.toHaveBeenCalled();
  });

  it("updates an existing schedule in place (GRAPH_REAPPLY) and keeps a running one running", async () => {
    mockExistingSchedule(deps, makeDesc(own("community")));

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.updated).toEqual([own("community")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      own("community"),
      expect.objectContaining({ scheduleId: own("community") })
    );
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates and resumes a paused schedule", async () => {
    mockExistingSchedule(deps, makeDesc(own("community"), { isPaused: true }));

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.updated).toEqual([own("community")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledOnce();
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      own("community")
    );
  });

  it("repairs dbScheduleId link drift", async () => {
    mockExistingSchedule(
      deps,
      makeDesc(own("community"), { dbScheduleId: null })
    );

    await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      own("community"),
      expect.objectContaining({ dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1` })
    );
  });

  it("skips when the schedule disappears between create and describe", async () => {
    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(own("community")));
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(null);

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.skipped).toEqual([own("community")]);
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("pauses this node's stale governance schedules not in config", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([own("community"), own("old-charter")]),
    });

    const result = await syncGovernanceSchedules(
      makeConfig([
        { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      ]),
      deps
    );

    expect(result.paused).toEqual([own("old-charter")]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      own("old-charter")
    );
    expect(deps.disableSchedule).toHaveBeenCalledWith(own("old-charter"));
  });

  // CROSS_TENANT_PRUNE (bug.5009 / bug.0026): the shared Temporal namespace holds the
  // operator's flat schedules, the operator's per-node ledger dispatch schedules and
  // sibling nodes' schedules. Pausing any of them stops epochs or governance runs.
  it("matrix: no create/update/pause/resume ever targets a flat, foreign or operator-owned id", async () => {
    const legacyAndForeign = [
      FLAT_LEDGER_ID,
      "governance:work_prioritizer",
      "governance:community",
      own("community"),
      OWN_LEDGER_ID,
      `governance:${OTHER_NODE_ID}:community`,
      `governance:${OTHER_NODE_ID}:ledger_ingest`,
    ];
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi.fn().mockResolvedValue(legacyAndForeign),
    });

    const result = await syncGovernanceSchedules(
      {
        schedules: [
          ...makeConfig([
            { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
          ]).schedules,
          ...makeLedgerConfig().schedules,
        ],
        ledger: LEDGER,
      },
      deps
    );

    for (const id of touchedIds(deps)) {
      expect(id).toBe(own("community"));
    }
    expect(result.paused).toEqual([]);
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalled();
  });

  it("LEGACY_FLAT_IDS: disables only the DB row of a legacy flat id and never pauses it in Temporal", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([FLAT_LEDGER_ID, "governance:work_prioritizer"]),
    });

    const result = await syncGovernanceSchedules(makeConfig([]), deps);

    expect(deps.disableSchedule).toHaveBeenCalledWith(FLAT_LEDGER_ID);
    expect(deps.disableSchedule).toHaveBeenCalledWith(
      "governance:work_prioritizer"
    );
    expect(deps.scheduleControl.pauseSchedule).not.toHaveBeenCalled();
    expect(result.paused).toEqual([]);
  });

  it("handles externally deleted schedules during prune gracefully", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([own("deleted-charter")]),
    });
    deps.scheduleControl.pauseSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlNotFoundError(own("deleted-charter"))
      );

    const result = await syncGovernanceSchedules(makeConfig([]), deps);

    // Should not throw, and should not list as paused
    expect(result.paused).toEqual([]);
  });

  it("is idempotent: a repeat call updates in place and creates nothing new", async () => {
    const stableDbId = "stable-db-id-for-idempotency";
    deps.upsertGovernanceScheduleRow = vi.fn().mockResolvedValue(stableDbId);
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result1 = await syncGovernanceSchedules(config, deps);
    expect(result1.created).toEqual([own("community")]);

    mockExistingSchedule(
      deps,
      makeDesc(own("community"), { dbScheduleId: stableDbId })
    );

    const result2 = await syncGovernanceSchedules(config, deps);
    expect(result2.created).toEqual([]);
    expect(result2.updated).toEqual([own("community")]);
    expect(result2.paused).toEqual([]);
  });

  it("returns empty result for config with no schedules", async () => {
    const result = await syncGovernanceSchedules(makeConfig([]), deps);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resumed).toEqual([]);
    expect(result.paused).toEqual([]);
  });
});

const LEDGER: NonNullable<GovernanceConfig["ledger"]> = {
  scopeId: "scope-uuid-001",
  scopeKey: "default",
  epochLengthDays: 7,
  activitySources: {
    github: {
      attributionPipeline: "cogni-v0.0",
      sourceRefs: ["cogni-dao/cogni"],
    },
  },
  poolConfig: { baseIssuanceCredits: 10000n },
  baseIssuanceCredits: "10000",
  approvers: ["0x070075F1389Ae1182aBac722B36CA12285d0c949"],
};

describe("GRAPH_CHARTER — governance schedule `graph:` (task.5282)", () => {
  const GRAPH_GRANT_ID = "test-graph-grant-id-001";
  const DECIDE = {
    charter: "COGNI_DECIDE",
    cron: "*/30 * * * *",
    timezone: "UTC",
    entrypoint: "DECIDE",
    graph: "langgraph:work-prioritizer",
    model: "gpt-oss-120b",
  };
  const created = (deps: GovernanceScheduleSyncDeps) =>
    vi
      .mocked(deps.scheduleControl.createSchedule)
      .mock.calls.map(([params]) => params);

  it("runs the declared langgraph graph via GraphRunWorkflow with a messages + platform modelRef input", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    const result = await syncGovernanceSchedules({ schedules: [DECIDE] }, deps);

    expect(result.created).toEqual([own("cogni_decide")]);
    const [params] = created(deps);
    expect(params).toMatchObject({
      scheduleId: own("cogni_decide"),
      graphId: "langgraph:work-prioritizer",
      executionGrantId: GRAPH_GRANT_ID,
      cron: "*/30 * * * *",
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "DECIDE" }],
        modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
      },
    });
    // undefined workflowType ⇒ adapter default GraphRunWorkflow; default queue.
    expect(params?.workflowType).toBeUndefined();
    expect(params?.taskQueueOverride).toBeUndefined();
    expect(deps.ensureGraphGrant).toHaveBeenCalledWith(
      "langgraph:work-prioritizer",
    );
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "langgraph:work-prioritizer",
        executionGrantId: GRAPH_GRANT_ID,
      }),
    );
  });

  it.each([
    { change: "graph only", graph: "langgraph:cogni", grant: GRAPH_GRANT_ID, cron: DECIDE.cron, paused: false },
    { change: "rotated grant", graph: DECIDE.graph, grant: "replacement-grant", cron: DECIDE.cron, paused: false },
    { change: "cadence sharing the next tick", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: "15 * * * *", paused: false },
    { change: "paused cadence", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: "15 * * * *", paused: true },
    { change: "unchanged desired state", graph: DECIDE.graph, grant: GRAPH_GRANT_ID, cron: DECIDE.cron, paused: false },
  ])("reapplies full graph action for $change", async ({ graph, grant, cron, paused }) => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(grant),
    });
    deps.scheduleControl.createSchedule = vi.fn().mockRejectedValue(
      new ScheduleControlConflictError(own("cogni_decide"))
    );
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue({
      scheduleId: own("cogni_decide"),
      nextRunAtIso: "2026-10-21T12:15:00.000Z",
      lastRunAtIso: null,
      isPaused: paused,
      cron: null,
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: DECIDE.entrypoint }],
        modelRef: { providerKey: "platform", modelId: DECIDE.model },
      },
      dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
    });
    const result = await syncGovernanceSchedules(
      { schedules: [{ ...DECIDE, graph, cron }] }, deps
    );
    expect(result.updated).toEqual([own("cogni_decide")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      own("cogni_decide"),
      expect.objectContaining({ graphId: graph, executionGrantId: grant, cron })
    );
    if (paused) {
      expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(own("cogni_decide"));
      expect(vi.mocked(deps.scheduleControl.updateSchedule).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(deps.scheduleControl.resumeSchedule).mock.invocationCallOrder[0]!
      );
    } else {
      expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
    }
  });

  it("skips a charter WITHOUT graph with a warning (and lets prune pause an existing copy)", async () => {
    const deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([own("heartbeat")]),
    });

    const result = await syncGovernanceSchedules(
      {
        schedules: [
          {
            charter: "HEARTBEAT",
            cron: "0 * * * *",
            timezone: "UTC",
            entrypoint: "HEARTBEAT",
          },
        ],
      },
      deps,
    );

    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(deps.upsertGovernanceScheduleRow).not.toHaveBeenCalled();
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([own("heartbeat")]);
    expect(result.paused).toEqual([own("heartbeat")]);
    expect(deps.log.warn).toHaveBeenCalledWith(
      { scheduleId: own("heartbeat") },
      expect.stringContaining("declares no `graph`"),
    );
  });

  it("a graph charter beside the ledger charter: only the graph schedule is written", async () => {
    const ledgerCharter = {
      charter: "LEDGER_INGEST",
      cron: "0 0 * * *",
      timezone: "UTC",
      entrypoint: "LEDGER_INGEST",
    };
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const result = await syncGovernanceSchedules(
      { schedules: [DECIDE, ledgerCharter], ledger: LEDGER },
      deps,
    );

    expect(result.created).toEqual([own("cogni_decide")]);
    expect(result.skipped).toEqual([OWN_LEDGER_ID]);
    expect(created(deps).map((p) => p.scheduleId)).toEqual([own("cogni_decide")]);
    expect(result.paused).toEqual([]);
  });

  it("ignores `graph` on LEDGER_INGEST (still operator-owned, never scheduled)", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const result = await syncGovernanceSchedules(
      {
        schedules: [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
            graph: "langgraph:work-prioritizer",
            model: "gpt-oss-120b",
          },
        ],
        ledger: LEDGER,
      },
      deps,
    );
    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(deps.upsertGovernanceScheduleRow).not.toHaveBeenCalled();
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([OWN_LEDGER_ID]);
  });

  it("skips (and lets prune pause) a graph charter when no graph grant dep is wired", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: undefined,
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([own("cogni_decide")]),
    });

    const result = await syncGovernanceSchedules({ schedules: [DECIDE] }, deps);

    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([own("cogni_decide")]);
    expect(result.paused).toEqual([own("cogni_decide")]);
  });
});

describe("governance schedule ids", () => {
  it("scopes the id to the node and lowercases the charter", () => {
    expect(governanceScheduleId(NODE_ID, "COMMUNITY")).toBe(
      `governance:${NODE_ID}:community`
    );
    expect(governanceScheduleId(NODE_ID, "LEDGER_INGEST")).toBe(OWN_LEDGER_ID);
  });

  it("isOwnGovernanceScheduleId: only this node's non-ledger ids", () => {
    expect(isOwnGovernanceScheduleId(NODE_ID, own("community"))).toBe(true);
    expect(isOwnGovernanceScheduleId(NODE_ID, OWN_LEDGER_ID)).toBe(false);
    expect(isOwnGovernanceScheduleId(NODE_ID, FLAT_LEDGER_ID)).toBe(false);
    expect(isOwnGovernanceScheduleId(NODE_ID, "governance:community")).toBe(false);
    expect(
      isOwnGovernanceScheduleId(NODE_ID, `governance:${OTHER_NODE_ID}:community`)
    ).toBe(false);
    expect(isOwnGovernanceScheduleId(NODE_ID, `governance:${NODE_ID}:`)).toBe(false);
  });

  it("isLegacyFlatGovernanceScheduleId: two-segment ids only", () => {
    expect(isLegacyFlatGovernanceScheduleId(FLAT_LEDGER_ID)).toBe(true);
    expect(isLegacyFlatGovernanceScheduleId("governance:work_prioritizer")).toBe(true);
    expect(isLegacyFlatGovernanceScheduleId(own("community"))).toBe(false);
    expect(isLegacyFlatGovernanceScheduleId("node-task:x:y")).toBe(false);
  });
});

// Startup is tested at the real job boundary; no HTTP auth or Temporal harness.
describe("governance startup reconciliation", () => {
  it("starts once without an ops token and retries lock contention", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("INTERNAL_OPS_TOKEN", "");
    const job = vi.fn().mockRejectedValueOnce(new Error("lock busy"))
      .mockResolvedValue({ created: 1 });
    vi.doMock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
      runGovernanceSchedulesSyncJob: job,
    }));
    vi.doMock("@/shared/observability", () => ({
      makeLogger: () => ({ warn: vi.fn() }),
    }));
    try {
      const { startGovernanceSyncOnBoot } = await import("@/bootstrap/startup-reconcile");
      startGovernanceSyncOnBoot();
      startGovernanceSyncOnBoot();
      await vi.dynamicImportSettled();
      expect(job).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(job).toHaveBeenCalledTimes(2);
      expect(job).toHaveBeenLastCalledWith({ throwIfLocked: true });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(job).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.doUnmock("@/bootstrap/jobs/syncGovernanceSchedules.job");
      vi.doUnmock("@/shared/observability");
    }
  });

  it("bounds repeated failures to eight attempts", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("VITEST", "false");
    const job = vi.fn().mockRejectedValue(new Error("Temporal unavailable"));
    vi.doMock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
      runGovernanceSchedulesSyncJob: job,
    }));
    vi.doMock("@/shared/observability", () => ({
      makeLogger: () => ({ warn: vi.fn() }),
    }));
    try {
      const { startGovernanceSyncOnBoot } = await import("@/bootstrap/startup-reconcile");
      startGovernanceSyncOnBoot();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(job).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      vi.doUnmock("@/bootstrap/jobs/syncGovernanceSchedules.job");
      vi.doUnmock("@/shared/observability");
    }
  });
});
