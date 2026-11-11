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

import { WorkItemDtoSchema } from "../src/contracts.js";
import {
  judgeMove,
  judgeMoves,
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
  it("accepts [] (moves nothing), one entry and three entries", () => {
    expect(parse([]).success).toBe(true);
    expect(parse([{ metricId: "m-1", direction: "up" }]).success).toBe(true);
    expect(
      parse(["a", "b", "c"].map((metricId) => ({ metricId, direction: "down" }))).success
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
    ["a repeated id", [{ metricId: "m", direction: "up" }, { metricId: "m", direction: "down" }]],
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
    expect(WorkItemMovesInputSchema.safeParse([{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }]).data).toEqual([
      { metricId: "m", direction: "up" },
    ]);
    expect(
      WorkItemMovesInputSchema.safeParse([
        { metricId: "m", direction: "up" },
        { metricId: "m", direction: "down" },
      ]).success
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
      ])
    ).toEqual([
      "moves[1].metricId repeats m",
      'moves[1].direction must be "up" or "down"',
    ]);
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
        JSON.stringify([{ metricId: "m", direction: "up", baselineObservationId: OBS_1 }])
      )
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
      ])
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
    baselineObservationId: string | null = OBS_1
  ): WorkItemMove => ({ metricId, direction, baselineObservationId });
  const port = (
    baseline: Record<string, MoveReading | null | Error>,
    latest: Record<string, MoveReading | null | Error>
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
    return { port: { observation, latest: current }, observation, current };
  };

  it("reads both ends of each move and judges it", async () => {
    const { port: readings, observation, current } = port(
      { "m-1": reading(10), "m-2": reading(10) },
      { "m-1": reading(12), "m-2": reading(12) }
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

  it("a null baseline is unknown (no_baseline) and costs no lookup", async () => {
    const { port: readings, observation, current } = port({}, { "m-1": reading(3) });
    const [out] = await judgeMoves([move("m-1", "up", null)], readings);
    expect(out).toMatchObject({
      baseline: null,
      current: null,
      moved: "unknown",
      unknownReason: "no_baseline",
    });
    expect(observation).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
  });

  it("an unreadable baseline is unknown and skips the latest lookup", async () => {
    const { port: readings, current } = port({ "m-1": null }, { "m-1": reading(3) });
    const [out] = await judgeMoves([move("m-1", "up")], readings);
    expect(out).toMatchObject({ moved: "unknown", unknownReason: "baseline_unreadable" });
    expect(current).not.toHaveBeenCalled();
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
      { "m-2": reading(2) }
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
    expect(a).toMatchObject({ moved: "unknown", unknownReason: "metric_deprecated", baseline: null });

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
        id === "old" ? Promise.reject(Object.assign(new Error("x"), { name: "MoveMetricGoneError" })) : reading(1),
      latest: async () => reading(2),
    };
    const out = await judgeMoves([move("old", "up"), move("live", "up")], copy);
    expect(out.map((m) => m.unknownReason ?? m.moved)).toEqual(["metric_deprecated", "as_declared"]);
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
      Object.fromEntries([1, 2, 3, 4].map((i) => [`m-${i}`, reading(2)]))
    );
    const out = await judgeMoves(
      [1, 2, 3, 4].map((i) => move(`m-${i}`, "up")),
      readings
    );
    expect(out).toHaveLength(3);
    expect(observation).toHaveBeenCalledTimes(3);
  });
});
