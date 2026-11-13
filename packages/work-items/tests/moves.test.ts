// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/moves`
 * Purpose: Pins the moves contract: the PATCH schema, the DTO, the stored-column reader, and the read-time verdict (story.0033).
 * Scope: Pure functions and zod parses over fake ports. No adapter, no database.
 * Invariants:
 *   - SERVER_OWNS_BASELINE: the PATCH schema drops `baselineObservationId` and every read-time field from an entry.
 *   - MOVES_BOUNDED: at most 3 entries, unique ids, id 1..40 characters; `[]` is valid.
 *   - NULL_BASELINE_READS_UNKNOWN: a null or unreadable baseline, or no current reading, is `unknown`, never zero or flat.
 *   - READ_IS_BOUNDED: one baseline and one latest lookup per move, within one deadline; a failure or a hang reads `unknown`.
 * Side-effects: none
 * Links: hub metric-foundation-design, packages/work-items/src/moves.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { WorkItemDtoSchema, WorkItemSummarySchema } from "../src/contracts.js";
import { composeItemEnvelope } from "../src/envelope.js";
import { DoltgresWorkItemAdapter } from "../src/adapters/doltgres/adapter.js";
import { independentReadPool, makeFakeDoltgresSql } from "./adapters/fake-doltgres-sql.js";
import {
  judgeMove,
  judgeMoves,
  judgeMoveSummaries,
  MoveMetricGoneError,
  type MoveReading,
  type MoveReadingPort,
  moveIssues,
  parseStoredMoves,
  type WorkItemMove,
} from "../src/moves.js";
import { WorkItemPatchInputSchema } from "../src/patch-contract.js";
import { toWorkItemDto, type WorkItem } from "../src/types.js";

const OBS_1 = "11111111-1111-4111-8111-111111111111";
const reading = (value: number, observedAt = "2026-11-10T00:00:00.000Z"): MoveReading => ({
  value,
  observedAt,
});

const parse = (moves: unknown) =>
  WorkItemPatchInputSchema.safeParse({
    id: "task.1",
    reason: "r",
    set: { moves },
  });

describe("WorkItemPatchInputSchema moves", () => {
  it("does not claim movement for a directionless association", () => {
    expect(judgeMove(null, reading(1), reading(2))).toBeNull();
    expect(judgeMove(null, null, null)).toBeNull();
  });

  it("parses directionless associations without activating store writes", () => {
    // Shape compatibility also lets the prioritizer recognize unchanged null links;
    // reader-first adapter rejection is proved below before any SQL access.
    expect(parse([{ metricId: "edits-7d", direction: null }]).success).toBe(true);
    expect(WorkItemDtoSchema.shape.moves.safeParse([{ metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 }]).success).toBe(true);
    expect(
      parseStoredMoves([{ metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 }]),
    ).toEqual([{ metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 }]);
  });

  it("accepts [] (moves nothing), one entry and three entries", () => {
    expect(parse([]).success).toBe(true);
    expect(parse([{ metricId: "m-1", direction: "up" }]).success).toBe(true);
    expect(
      parse(["a", "b", "c"].map((metricId) => ({ metricId, direction: "down" }))).success,
    ).toBe(true);
  });

  it("is optional: a patch that leaves moves alone parses without the key", () => {
    const result = WorkItemPatchInputSchema.parse({
      id: "task.1",
      reason: "r",
      set: { title: "t" },
    });
    expect(result.set).not.toHaveProperty("moves");
  });

  it.each([
    ["four entries", [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" }))],
    [
      "a repeated id",
      [
        { metricId: "m", direction: "up" },
        { metricId: "m", direction: "down" },
      ],
    ],
    ["an empty id", [{ metricId: "", direction: "up" }]],
    ["a 41-character id", [{ metricId: "x".repeat(41), direction: "up" }]],
    ["a bad direction", [{ metricId: "m", direction: "sideways" }]],
    ["a missing direction", [{ metricId: "m" }]],
    ["null", null],
    ["an object", { metricId: "m", direction: "up" }],
  ])("refuses %s", (_name, moves) => {
    expect(parse(moves).success).toBe(false);
  });

  it("accepts a 40-character id", () => {
    expect(parse([{ metricId: "x".repeat(40), direction: "up" }]).success).toBe(true);
  });

  it("drops baselineObservationId and read-time fields: a client never sets the baseline", () => {
    const result = parse([
      {
        metricId: "m-1",
        direction: "up",
        baselineObservationId: OBS_1,
        baseline: { value: 1, observedAt: "x" },
        current: { value: 2, observedAt: "y" },
        moved: "as_declared",
      },
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.set.moves).toEqual([{ metricId: "m-1", direction: "up" }]);
  });
});

describe("WorkItemMovesInputSchema (create and patch share it)", () => {
  it("is the schema of both writes", async () => {
    const { WorkItemMovesInputSchema } = await import("../src/patch-contract.js");
    expect(WorkItemMovesInputSchema.safeParse([]).success).toBe(true);
    expect(
      WorkItemMovesInputSchema.safeParse([
        { metricId: "m", direction: "up", baselineObservationId: OBS_1 },
      ]).data,
    ).toEqual([{ metricId: "m", direction: "up" }]);
    expect(
      WorkItemMovesInputSchema.safeParse([
        { metricId: "m", direction: "up" },
        { metricId: "m", direction: "down" },
      ]).success,
    ).toBe(false);
  });
});

describe("moveIssues", () => {
  it("is empty for a valid list and says what is wrong otherwise", () => {
    expect(moveIssues([])).toEqual([]);
    expect(moveIssues([{ metricId: "m", direction: "up" }])).toEqual([]);
    expect(moveIssues("nope")).toEqual(["moves must be an array"]);
    expect(
      moveIssues([
        { metricId: "m", direction: "up" },
        { metricId: "m", direction: "left" },
      ]),
    ).toEqual(["moves[1].metricId repeats m", 'moves[1].direction must be "up", "down" or null']);
  });

  it("refuses directionless writes until readers are upgraded", () => {
    expect(moveIssues([{ metricId: "edits-7d", direction: null }])).toEqual([
      "moves[0].direction null is not enabled until readers are upgraded",
    ]);
  });
});

describe("reader-first store gate", () => {
  it("rejects null writes on create and patch before any database access", async () => {
    const sql = vi.fn();
    const adapter = new DoltgresWorkItemAdapter(sql as never, {
      recreateClient: () => sql as never,
    });
    const moves = [{ metricId: "edits-7d", direction: null }];
    await expect(
      adapter.create({ type: "task", title: "t", node: "shared", moves } as never, "principal"),
    ).rejects.toMatchObject({ code: "moves_invalid" });
    await expect(
      adapter.patch({ id: "task.1", reason: "test gate", set: { moves } } as never, "principal"),
    ).rejects.toMatchObject({ code: "moves_invalid" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("retains directionless links in summary wire projection", () => {
    const result = WorkItemSummarySchema.parse({
      id: "task.1",
      title: "t",
      type: "task",
      status: "needs_implement",
      labels: [],
      createdAt: "t",
      updatedAt: "t",
      moves: [{ metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 }],
    });
    expect(result.moves).toEqual([
      { metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 },
    ]);
  });

  it("selects stored links in a bounded summary page", async () => {
    const queries: string[] = [];
    const moves = [{ metricId: "edits-7d", direction: null, baselineObservationId: OBS_1 }];
    const sql = makeFakeDoltgresSql(
      (query) =>
        query.includes("FROM (SELECT")
          ? [
              {
                id: "task.1",
                title: "t",
                type: "task",
                status: "needs_implement",
                labels: [],
                moves,
                __sort_key: null,
              },
            ]
          : [],
      queries,
    );
    const adapter = new DoltgresWorkItemAdapter(independentReadPool(sql), { readClient: sql });
    const page = await adapter.listSummaries({ limit: 1 });
    expect(page.items[0]?.moves).toEqual(moves);
    expect(queries.find((query) => query.includes("FROM (SELECT"))).toContain(
      "labels, moves, created_at",
    );
  });
});

describe("parseStoredMoves", () => {
  it("reads absent, null and non-array columns as absent", () => {
    expect(parseStoredMoves(undefined)).toBeUndefined();
    expect(parseStoredMoves(null)).toBeUndefined();
    expect(parseStoredMoves({ metricId: "m" })).toBeUndefined();
    expect(parseStoredMoves("not json")).toBeUndefined();
  });

  it("keeps [] as a declaration and reads a JSON string column", () => {
    expect(parseStoredMoves([])).toEqual([]);
    expect(
      parseStoredMoves(
        JSON.stringify([{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }]),
      ),
    ).toEqual([{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }]);
  });

  it("reads a missing or malformed baseline as null and skips a bad entry", () => {
    expect(
      parseStoredMoves([
        { metricId: "a", direction: "up" },
        { metricId: "b", direction: "down", baselineObservationId: "nope" },
        { metricId: "c", direction: "sideways" },
        { direction: "up" },
        null,
      ]),
    ).toEqual([
      { metricId: "a", direction: "up", baselineObservationId: null },
      { metricId: "b", direction: "down", baselineObservationId: null },
    ]);
  });
});

describe("WorkItemDto moves", () => {
  const item = (moves: readonly WorkItemMove[] | undefined): WorkItem =>
    ({
      id: "task.1",
      type: "task",
      title: "t",
      status: "needs_implement",
      node: "operator",
      actor: "either",
      assignees: [],
      externalRefs: [],
      labels: [],
      specRefs: [],
      revision: 0,
      deployVerified: false,
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
      ...(moves !== undefined && { moves }),
    }) as unknown as WorkItem;

  it("carries stored moves through, with a null baseline kept", () => {
    const stored: WorkItemMove[] = [
      { metricId: "m-1", direction: "up", baselineObservationId: OBS_1 },
      { metricId: "m-2", direction: "down", baselineObservationId: null },
    ];
    const dto = WorkItemDtoSchema.parse(toWorkItemDto(item(stored)));
    expect(dto.moves).toEqual(stored);
  });

  it("keeps [] distinct from absent", () => {
    expect(WorkItemDtoSchema.parse(toWorkItemDto(item([]))).moves).toEqual([]);
    expect(WorkItemDtoSchema.parse(toWorkItemDto(item(undefined)))).not.toHaveProperty("moves");
  });

  it("accepts the read-time fields", () => {
    const dto = WorkItemDtoSchema.parse({
      ...toWorkItemDto(item([])),
      moves: [
        {
          metricId: "m-1",
          direction: "up",
          baselineObservationId: OBS_1,
          baseline: reading(1),
          current: reading(2),
          moved: "as_declared",
        },
        {
          metricId: "m-2",
          direction: "up",
          baselineObservationId: null,
          baseline: null,
          current: null,
          moved: "unknown",
          unknownReason: "no_baseline",
        },
        {
          metricId: "m-3",
          direction: "down",
          baselineObservationId: OBS_1,
          baseline: null,
          current: null,
          moved: "unknown",
          unknownReason: "metric_deprecated",
        },
      ],
    });
    expect(dto.moves?.[1]?.moved).toBe("unknown");
    expect(dto.moves?.[2]?.unknownReason).toBe("metric_deprecated");
  });
});

describe("judgeMove", () => {
  it.each([
    ["up", 1, 2, "as_declared"],
    ["up", 2, 1, "against"],
    ["down", 2, 1, "as_declared"],
    ["down", 1, 2, "against"],
    ["up", 5, 5, "flat"],
    ["down", 0, 0, "flat"],
    ["up", -3, -1, "as_declared"],
  ] as const)("direction %s, %s -> %s reads %s", (direction, from, to, expected) => {
    expect(judgeMove(direction, reading(from), reading(to))).toBe(expected);
  });

  it("is unknown without both readings or with a non-finite value, never zero or flat", () => {
    expect(judgeMove("up", null, reading(1))).toBe("unknown");
    expect(judgeMove("up", reading(1), null)).toBe("unknown");
    expect(judgeMove("up", null, null)).toBe("unknown");
    expect(judgeMove("up", reading(Number.NaN), reading(1))).toBe("unknown");
    expect(judgeMove("up", reading(1), reading(Number.POSITIVE_INFINITY))).toBe("unknown");
  });
});

describe("judgeMoves", () => {
  const move = (
    metricId: string,
    direction: "up" | "down",
    baselineObservationId: string | null = OBS_1,
  ): WorkItemMove => ({ metricId, direction, baselineObservationId });
  const port = (
    baseline: Record<string, MoveReading | null | Error>,
    latest: Record<string, MoveReading | null | Error>,
  ) => {
    const observation = vi.fn<MoveReadingPort["observation"]>(async (metricId) => {
      const found = baseline[metricId];
      if (found instanceof Error) throw found;
      return found ?? null;
    });
    const current = vi.fn<MoveReadingPort["latest"]>(async (metricId) => {
      const found = latest[metricId];
      if (found instanceof Error) throw found;
      return found ?? null;
    });
    return { port: { observation, latest: current, assess: judgeMove }, observation, current };
  };

  it("reads both ends of each move and judges it", async () => {
    const {
      port: readings,
      observation,
      current,
    } = port(
      { "m-1": reading(10), "m-2": reading(10) },
      { "m-1": reading(12), "m-2": reading(12) },
    );
    const out = await judgeMoves([move("m-1", "up"), move("m-2", "down")], readings);
    expect(out).toEqual([
      {
        ...move("m-1", "up"),
        baseline: reading(10),
        current: reading(12),
        moved: "as_declared",
      },
      {
        ...move("m-2", "down"),
        baseline: reading(10),
        current: reading(12),
        moved: "against",
      },
    ]);
    // One baseline and one latest lookup per move, and the baseline is looked up by its pinned id.
    expect(observation).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledTimes(2);
    expect(observation.mock.calls[0]?.[1]).toBe(OBS_1);
  });

  it("a null baseline remains unknown while showing the current observation", async () => {
    const { port: readings, observation, current } = port({}, { "m-1": reading(3) });
    const [out] = await judgeMoves([move("m-1", "up", null)], readings);
    expect(out).toMatchObject({
      baseline: null,
      current: reading(3),
      moved: "unknown",
      unknownReason: "no_baseline",
    });
    expect(observation).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("an unreadable baseline is unknown while retaining the latest reading", async () => {
    const { port: readings, current } = port({ "m-1": null }, { "m-1": reading(3) });
    const [out] = await judgeMoves([move("m-1", "up")], readings);
    expect(out).toMatchObject({ moved: "unknown", unknownReason: "baseline_unreadable" });
    expect(out?.current).toEqual(reading(3));
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("no current reading is unknown and keeps the baseline it read", async () => {
    const { port: readings } = port({ "m-1": reading(3) }, { "m-1": null });
    const [out] = await judgeMoves([move("m-1", "up")], readings);
    expect(out).toMatchObject({
      baseline: reading(3),
      current: null,
      moved: "unknown",
      unknownReason: "no_current",
    });
  });

  it("a failing lookup reads unknown for that move only", async () => {
    const { port: readings } = port(
      { "m-1": new Error("db down"), "m-2": reading(1) },
      { "m-2": reading(2) },
    );
    const out = await judgeMoves([move("m-1", "up"), move("m-2", "up")], readings);
    expect(out.map((m) => m.moved)).toEqual(["unknown", "as_declared"]);
  });

  it("a metric that is gone reads unknown (metric_deprecated), from either lookup", async () => {
    const gone = (id: string) => new MoveMetricGoneError(id);
    const onBaseline: MoveReadingPort = {
      observation: async (id) => {
        throw gone(id);
      },
      latest: async () => reading(1),
    };
    const [a] = await judgeMoves([move("m-1", "up")], onBaseline);
    expect(a).toMatchObject({
      moved: "unknown",
      unknownReason: "metric_deprecated",
      baseline: null,
    });

    const onLatest: MoveReadingPort = {
      observation: async () => reading(1),
      latest: async (id) => {
        throw gone(id);
      },
    };
    const [b] = await judgeMoves([move("m-1", "up")], onLatest);
    expect(b).toMatchObject({
      moved: "unknown",
      unknownReason: "metric_deprecated",
      baseline: reading(1),
      current: null,
    });
    // A bundled copy of the class is matched by name; one bad move does not hide the others.
    const copy: MoveReadingPort = {
      observation: async (id) =>
        id === "old"
          ? Promise.reject(Object.assign(new Error("x"), { name: "MoveMetricGoneError" }))
          : reading(1),
      latest: async () => reading(2),
      assess: judgeMove,
    };
    const out = await judgeMoves([move("old", "up"), move("live", "up")], copy);
    expect(out.map((m) => m.unknownReason ?? m.moved)).toEqual([
      "metric_deprecated",
      "as_declared",
    ]);
  });

  it("with no metrics service every move is unknown (metrics_unavailable)", async () => {
    const out = await judgeMoves([move("m-1", "up")], undefined);
    expect(out[0]).toMatchObject({ moved: "unknown", unknownReason: "metrics_unavailable" });
  });

  it("a port that hangs past the deadline reads unknown and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const hang: MoveReadingPort = {
      observation: (_id, _obs, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
      latest: () => new Promise(() => undefined),
    };
    const out = await judgeMoves([move("m-1", "up")], hang, { deadlineMs: 20 });
    expect(out[0]).toMatchObject({ moved: "unknown", unknownReason: "metrics_unavailable" });
    expect(seen?.aborted).toBe(true);
  });

  it("reads at most three moves", async () => {
    const { port: readings, observation } = port(
      Object.fromEntries([1, 2, 3, 4].map((i) => [`m-${i}`, reading(1)])),
      Object.fromEntries([1, 2, 3, 4].map((i) => [`m-${i}`, reading(2)])),
    );
    const out = await judgeMoves(
      [1, 2, 3, 4].map((i) => move(`m-${i}`, "up")),
      readings,
    );
    expect(out).toHaveLength(3);
    expect(observation).toHaveBeenCalledTimes(3);
  });
});

describe("bounded summary assessment", () => {
  it("does not fall back to per-row reads when batching is unavailable", async () => {
    const observation = vi.fn(async () => reading(1));
    const latest = vi.fn(async () => reading(2));
    const port: MoveReadingPort = { observation, latest, assess: judgeMove };
    const [item] = await judgeMoveSummaries(
      [{ id: "task.1", moves: [{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }] }],
      port,
    );
    expect(item?.moves?.[0]).toMatchObject({
      moved: "unknown",
      unknownReason: "metrics_unavailable",
    });
    expect(observation).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  });
  it("joins the page through one batch port without individual lookups", async () => {
    const observation = vi.fn(async () => reading(1));
    const latest = vi.fn(async () => reading(2));
    const batch = vi.fn(async (moves: readonly WorkItemMove[]) =>
      moves.map(() => ({ baseline: reading(1), current: reading(2) })),
    );
    const port = { observation, latest, batch, assess: judgeMove };
    const items = ["a", "b"].map((id) => ({
      id,
      moves: [{ metricId: id, direction: "up" as const, baselineObservationId: OBS_1 }],
    }));
    const result = await judgeMoveSummaries(items, port);
    expect(batch).toHaveBeenCalledOnce();
    expect(observation).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(result.map((row) => row.moves?.[0]?.moved)).toEqual(["as_declared", "as_declared"]);
  });
  it("marks links beyond the page assessment cap as budget-limited", async () => {
    const port: MoveReadingPort = {
      observation: async () => reading(1),
      latest: async () => reading(2),
      batch: async (moves) => moves.map(() => ({ baseline: reading(1), current: reading(2) })),
      assess: judgeMove,
    };
    const items = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `task.${i}` })),
      {
        id: "task.100",
        moves: [{ metricId: "m", direction: "up" as const, baselineObservationId: OBS_1 }],
      },
    ];
    const out = await judgeMoveSummaries(items, port);
    expect(out[100]?.moves?.[0]).toMatchObject({
      moved: "unknown",
      unknownReason: "projection_budget",
    });
  });
  it("fails closed when an old reader does not supply the metrics assessor", async () => {
    const port: MoveReadingPort = {
      observation: async () => reading(1),
      latest: async () => reading(2),
    };
    const [result] = await judgeMoves(
      [{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }],
      port,
    );
    expect(result?.moved).toBe("unknown");
  });
  it("enriches declared moves and leaves unrelated items untouched", async () => {
    const assess = vi.fn(() => "against" as const);
    const port: MoveReadingPort = {
      observation: async () => reading(1),
      latest: async () => reading(2),
      batch: async (moves) => moves.map(() => ({ baseline: reading(1), current: reading(2) })),
      assess,
    };
    const items = [
      {
        id: "task.1",
        moves: [{ metricId: "m", direction: "up" as const, baselineObservationId: OBS_1 }],
      },
      { id: "task.2" },
    ];
    const out = await judgeMoveSummaries(items, port);
    expect(out[0]?.moves?.[0]).toMatchObject({
      metricId: "m",
      moved: "against",
      baseline: reading(1),
      current: reading(2),
    });
    expect(out[1]).toEqual({ id: "task.2" });
    expect(assess).toHaveBeenCalledOnce();
  });
});

describe("single-item move context (task.0118)", () => {
  const chainRead = <T extends { id: string; moves?: WorkItemMove[] | undefined }>(
    item: T,
    readings: MoveReadingPort | undefined,
    options: { deadline?: number } = {},
  ) => composeItemEnvelope(item, { readings }, options);
  const move = { metricId: "m", direction: "up" as const, baselineObservationId: OBS_1 };
  const item = { id: "task.1", moves: [move, { ...move, metricId: "gone" }] };
  const chain = {
    metric: { id: "m", title: "M", unit: "items", display: "progress" as const },
    kpi: {
      metricId: "k",
      title: "K",
      comparator: "gte" as const,
      target: { value: 10, unit: "items" },
      status: "behind",
    },
    goal: { id: "goal-x", title: "Goal X" },
  };
  const port = (context?: MoveReadingPort["context"]): MoveReadingPort => ({
    observation: async () => reading(1),
    latest: async () => reading(2),
    batch: async (moves) => moves.map(() => ({ baseline: reading(1), current: reading(2) })),
    assess: () => "as_declared",
    ...(context ? { context } : {}),
  });

  it("adds the chain to a resolved move and marks an unresolved one unavailable, beside the readings", async () => {
    const context = vi.fn(async () => new Map([["m", chain]]));
    const out = await chainRead(item, port(context));
    expect(out.moves?.[0]).toMatchObject({ ...chain, moved: "as_declared", baseline: reading(1) });
    expect(out.moves?.[1]).toMatchObject({ metricId: "gone", context: "unavailable" });
    expect(out.moves?.[1]).not.toHaveProperty("kpi");
    expect(out.moves?.[1]).not.toHaveProperty("goal");
    expect(context).toHaveBeenCalledOnce();
    expect(context.mock.calls[0]?.[0]).toEqual(["m", "gone"]);
  });

  it("marks every move unavailable when the resolution fails, times out or has no port, and keeps the readings", async () => {
    for (const readings of [
      port(async () => {
        throw new Error("goals down");
      }),
      port(),
      undefined,
    ]) {
      const out = await chainRead(item, readings);
      for (const entry of out.moves ?? []) {
        expect(entry.context).toBe("unavailable");
        expect(entry).not.toHaveProperty("metric");
        expect(entry).not.toHaveProperty("kpi");
      }
    }
    const hung = await chainRead(item, port(() => new Promise(() => undefined)), {
      deadline: Date.now() + 20,
    });
    expect(hung.moves?.map((entry) => entry.context)).toEqual(["unavailable", "unavailable"]);
  });

  it("leaves an item without moves untouched and never calls the port", async () => {
    const context = vi.fn();
    expect(await chainRead({ id: "task.2" }, port(context))).toEqual({ id: "task.2" });
    expect(await chainRead({ id: "task.3", moves: [] }, port(context))).toEqual({
      id: "task.3",
      moves: [],
    });
    expect(context).not.toHaveBeenCalled();
  });

  it("the chain and links schemas are optional and additive on the one DTO", () => {
    const base = {
      id: "task.1",
      type: "task",
      title: "t",
      status: "needs_triage",
      assignees: [],
      externalRefs: [],
      labels: [],
      specRefs: [],
      revision: 1,
      deployVerified: false,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(WorkItemDtoSchema.safeParse(base).success).toBe(true);
    const parsed = WorkItemDtoSchema.parse({
      ...base,
      moves: [{ metricId: "m", direction: "up", baselineObservationId: null, ...chain }],
      links: { items: [], nextCursor: null, unavailable: true },
    });
    expect(parsed.moves?.[0]).toMatchObject(chain);
    expect(parsed.links).toEqual({ items: [], nextCursor: null, unavailable: true });
    expect(
      WorkItemDtoSchema.safeParse({
        ...base,
        moves: [{ metricId: "m", direction: "up", baselineObservationId: null, context: "ok" }],
      }).success,
    ).toBe(false);
  });
});
