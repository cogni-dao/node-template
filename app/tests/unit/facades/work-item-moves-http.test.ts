// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-moves-http`
 * Purpose: The HTTP boundary of work-item `moves`: the PATCH contract and error mapping, and the read-time verdict on a single-item read (story.0033).
 * Scope: Real route and facade over a stubbed container and metrics service. No database.
 * Invariants:
 *   - SERVER_OWNS_BASELINE: a baseline in the request body never reaches the store.
 *   - READ_TIME_ENRICHMENT: a single-item read and a patch response carry `{ baseline, current, moved }` per move; `unknown` names a missing reading and is never zero.
 *   - READ_IS_BOUNDED: at most one baseline lookup and one latest lookup per move; a list read does no metric lookup.
 *   - UNKNOWN_METRIC_IS_400: an unknown or deprecated metric id is HTTP400 `cite_unresolved` at `set.moves`.
 * Side-effects: none
 * Links: hub metric-foundation-design, packages/work-items/src/moves.ts
 */

import { EntryUnresolvedError, MovesInvalidError, MovesUnsupportedError } from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { GET, PATCH } from "@/app/api/v1/work/items/[id]/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route: unknown
) => Promise<Response>;

const OBS_BASE = "11111111-1111-4111-8111-111111111111";
const OBS_B2 = "22222222-2222-4222-8222-222222222222";
const patch = vi.fn();
const get = vi.fn();
const read = vi.fn();
const observation = vi.fn();

const base = {
  id: "task.0001",
  type: "task",
  title: "Moves fixture",
  status: "needs_implement",
  node: "operator",
  actor: "either",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};
const stored = (...moves: [string, "up" | "down", string | null][]) => ({
  ...base,
  moves: moves.map(([metricId, direction, baselineObservationId]) => ({
    metricId,
    direction,
    baselineObservationId,
  })),
});
const ok = (id: string, value: number, observedAt = "2026-11-10T00:00:00.000Z") => ({
  id,
  status: "ok",
  value,
  observedAt,
});

const patchRequest = (body: unknown) =>
  (PATCH as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) }
  );
const getRequest = () =>
  (GET as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001"),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) }
  );

describe("work-item moves HTTP boundary (story.0033)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch, get },
      goalMetrics: { read, observation },
    } as never);
  });

  describe("PATCH", () => {
    it("forwards moves and never a client baseline", async () => {
      patch.mockResolvedValue(stored(["convergence-ratio", "up", OBS_BASE]));
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 0.4) });
      observation.mockResolvedValue({ observation: ok(OBS_BASE, 0.2) });
      const response = await patchRequest({
        reason: "this raises the ratio",
        set: {
          moves: [
            {
              metricId: "convergence-ratio",
              direction: "up",
              baselineObservationId: "99999999-9999-4999-8999-999999999999",
              moved: "against",
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      expect(patch).toHaveBeenCalledWith(
        {
          id: "task.0001",
          reason: "this raises the ratio",
          set: { moves: [{ metricId: "convergence-ratio", direction: "up" }] },
        },
        "principal-1"
      );
      expect((await response.json()).moves).toEqual([
        {
          metricId: "convergence-ratio",
          direction: "up",
          baselineObservationId: OBS_BASE,
          baseline: { value: 0.2, observedAt: "2026-11-10T00:00:00.000Z" },
          current: { value: 0.4, observedAt: "2026-11-10T00:00:00.000Z" },
          moved: "as_declared",
        },
      ]);
    });

    it("accepts [] and forwards it", async () => {
      patch.mockResolvedValue({ ...base, moves: [] });
      const response = await patchRequest({ reason: "docs only", set: { moves: [] } });
      expect(response.status).toBe(200);
      expect(patch.mock.calls[0]?.[0].set).toEqual({ moves: [] });
      expect((await response.json()).moves).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });

    it.each([
      ["four entries", [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" }))],
      ["a repeated id", [{ metricId: "m", direction: "up" }, { metricId: "m", direction: "down" }]],
      ["a bad direction", [{ metricId: "m", direction: "sideways" }]],
      ["a 41-character id", [{ metricId: "x".repeat(41), direction: "up" }]],
    ])("rejects %s with 400 before the store", async (_name, moves) => {
      const response = await patchRequest({ reason: "r", set: { moves } });
      expect(response.status).toBe(400);
      expect(patch).not.toHaveBeenCalled();
    });

    it("maps an unknown or deprecated metric to 400 cite_unresolved at set.moves", async () => {
      patch.mockRejectedValue(new EntryUnresolvedError(["ghost"], "moves"));
      const response = await patchRequest({
        reason: "r",
        set: { moves: [{ metricId: "ghost", direction: "up" }] },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid input",
        errorCode: "cite_unresolved",
        ids: ["ghost"],
        issues: [
          {
            code: "custom",
            path: ["set", "moves"],
            message: "metric not found or deprecated: ghost",
          },
        ],
      });
    });

    it("keeps a cite failure at the cites path", async () => {
      patch.mockRejectedValue(new EntryUnresolvedError(["ghost"]));
      const response = await patchRequest({
        reason: "r",
        cites: [{ id: "ghost" }],
        set: { summary: "x" },
      });
      expect((await response.json()).issues[0]).toMatchObject({ path: ["cites"] });
    });

    it("maps adapter-bundle copies by name, and moves_unsupported and moves_invalid to 400", async () => {
      const moves = [{ metricId: "m", direction: "up" }];
      patch.mockRejectedValue(
        Object.assign(new Error("copy"), {
          name: "EntryUnresolvedError",
          ids: ["ghost"],
          field: "moves",
        })
      );
      const unresolved = await patchRequest({ reason: "r", set: { moves } });
      expect(unresolved.status).toBe(400);
      expect((await unresolved.json()).issues[0]).toMatchObject({ path: ["set", "moves"] });

      patch.mockRejectedValue(new MovesUnsupportedError());
      const unsupported = await patchRequest({ reason: "r", set: { moves } });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({ errorCode: "moves_unsupported" });

      patch.mockRejectedValue(
        Object.assign(new Error("bad"), { name: "MovesInvalidError", issues: ["moves must be an array"] })
      );
      const invalid = await patchRequest({ reason: "r", set: { moves } });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        errorCode: "moves_invalid",
        issues: [{ path: ["set", "moves"], message: "moves must be an array" }],
      });
      patch.mockRejectedValue(new MovesInvalidError(["x"]));
      expect((await patchRequest({ reason: "r", set: { moves } })).status).toBe(400);
    });

    it("maps a resolver or baseline failure to 503", async () => {
      patch.mockRejectedValue(
        Object.assign(new Error("down"), { name: "EntryResolverUnavailableError" })
      );
      const response = await patchRequest({
        reason: "r",
        set: { moves: [{ metricId: "m", direction: "up" }] },
      });
      expect(response.status).toBe(503);
    });
  });

  describe("GET (read-time enrichment)", () => {
    const readings = (baseline: number | null, current: number | null) => {
      observation.mockImplementation(async () => ({
        observation: baseline === null ? null : ok(OBS_BASE, baseline, "2026-11-01T00:00:00.000Z"),
      }));
      read.mockImplementation(async () => ({
        lastGood: current === null ? null : ok(OBS_B2, current, "2026-11-10T00:00:00.000Z"),
      }));
    };
    const moveOf = async () => (await (await getRequest()).json()).moves[0];

    it.each([
      ["up", 1, 2, "as_declared"],
      ["up", 2, 1, "against"],
      ["down", 2, 1, "as_declared"],
      ["down", 1, 2, "against"],
      ["up", 3, 3, "flat"],
    ] as const)("%s from %s to %s is %s", async (direction, from, to, expected) => {
      get.mockResolvedValue(stored(["m-1", direction, OBS_BASE]));
      readings(from, to);
      expect(await moveOf()).toMatchObject({
        metricId: "m-1",
        direction,
        baselineObservationId: OBS_BASE,
        baseline: { value: from, observedAt: "2026-11-01T00:00:00.000Z" },
        current: { value: to, observedAt: "2026-11-10T00:00:00.000Z" },
        moved: expected,
      });
    });

    it("a null baseline reads unknown (no_baseline) with no lookup, never zero", async () => {
      get.mockResolvedValue(stored(["m-1", "up", null]));
      readings(1, 5);
      expect(await moveOf()).toMatchObject({
        baselineObservationId: null,
        baseline: null,
        current: null,
        moved: "unknown",
        unknownReason: "no_baseline",
      });
      expect(observation).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it("a pinned observation that cannot be read, or no current reading, reads unknown", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      readings(null, 5);
      expect(await moveOf()).toMatchObject({ moved: "unknown", unknownReason: "baseline_unreadable" });
      readings(1, null);
      expect(await moveOf()).toMatchObject({
        baseline: { value: 1 },
        current: null,
        moved: "unknown",
        unknownReason: "no_current",
      });
    });

    it("a failing metrics service reads unknown and never fails the item read", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      observation.mockRejectedValue(new Error("db down"));
      const response = await getRequest();
      expect(response.status).toBe(200);
      expect((await response.json()).moves[0]).toMatchObject({ moved: "unknown" });
    });

    it("a node with no metrics service reads every move unknown (metrics_unavailable)", async () => {
      vi.mocked(getContainer).mockReturnValue({ doltgresWorkItems: { patch, get } } as never);
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      expect(await moveOf()).toMatchObject({ moved: "unknown", unknownReason: "metrics_unavailable" });
    });

    it("looks up at most one baseline and one latest reading per move, three moves at most", async () => {
      get.mockResolvedValue(
        stored(["m-1", "up", OBS_BASE], ["m-2", "down", OBS_BASE], ["m-3", "up", OBS_BASE])
      );
      readings(1, 2);
      const moves = (await (await getRequest()).json()).moves;
      expect(moves.map((m: { moved: string }) => m.moved)).toEqual(["as_declared", "against", "as_declared"]);
      expect(observation).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenCalledTimes(3);
    });

    it("an item that declares no moves costs no lookup, and [] stays []", async () => {
      get.mockResolvedValue(base);
      const plain = await (await getRequest()).json();
      expect(plain).not.toHaveProperty("moves");
      get.mockResolvedValue({ ...base, moves: [] });
      expect((await (await getRequest()).json()).moves).toEqual([]);
      expect(observation).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it("a failed observation never counts as a reading", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      observation.mockResolvedValue({ observation: { id: OBS_BASE, status: "error", value: 1, observedAt: "x" } });
      read.mockResolvedValue({ lastGood: ok(OBS_B2, 2) });
      expect(await moveOf()).toMatchObject({ moved: "unknown", unknownReason: "baseline_unreadable" });
    });
  });
});
