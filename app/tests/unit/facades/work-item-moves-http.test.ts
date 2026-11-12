// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-moves-http`
 * Purpose: The HTTP boundary of work-item `moves`: the PATCH contract and error mapping, and the read-time verdict on a single-item read (story.0033).
 * Scope: Real route and facade over a stubbed container and metrics service. No database.
 * Invariants:
 *   - SERVER_OWNS_BASELINE: a baseline in the request body never reaches the store.
 *   - READ_TIME_ENRICHMENT: a single-item read and a patch response carry `{ baseline, current, moved }` per move; `unknown` names a missing reading and is never zero.
 *   - READ_IS_BOUNDED: one batch covers all visible moves; no-move items do no lookup.
 *   - UNKNOWN_METRIC_IS_400: an unknown or deprecated metric id is HTTP400 `cite_unresolved` at `set.moves`.
 * Side-effects: none
 * Links: hub metric-foundation-design, packages/work-items/src/moves.ts
 */

import {
  EntryUnresolvedError,
  MovesInvalidError,
  MovesUnsupportedError,
} from "@cogni/work-items";
import type { MetricObservation } from "@cogni-dao/metrics/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { GET, PATCH } from "@/app/api/v1/work/items/[id]/route";
import { POST } from "@/app/api/v1/work/items/route";
import { getContainer } from "@/bootstrap/container";

type Handler = (
  context: unknown,
  request: Request,
  user: unknown,
  route: unknown,
) => Promise<Response>;

const OBS_BASE = "11111111-1111-4111-8111-111111111111";
const OBS_B2 = "22222222-2222-4222-8222-222222222222";
const patch = vi.fn();
const get = vi.fn();
const batch = vi.fn();

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
const ok = (
  id: string,
  value: number,
  observedAt = "2026-11-10T00:00:00.000Z",
  metricId = "m-1",
) =>
  ({
    id,
    metricId,
    status: "ok" as const,
    value,
    observedAt,
    definitionRevision: "1",
    definitionHash: "definition",
    calculatorVersion: "work.count@1",
    paramsHash: "params",
    node: "node-template",
    environment: "test",
    dataScope: "node-members",
    unit: "items",
    window: {
      start: new Date(Date.parse(observedAt) - 3600000).toISOString(),
      end: observedAt,
    },
    sourceWatermarks: [{ source: "test", asOf: observedAt }],
    evidenceRefs: [],
    reason: null,
    viewState: "ok" as const,
    maxAgeSeconds: 7200,
  }) satisfies MetricObservation & { viewState: "ok"; maxAgeSeconds: number };

const patchRequest = (body: unknown) =>
  (PATCH as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) },
  );
const postRequest = (body: unknown) =>
  (POST as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { id: "principal-1" },
    undefined,
  );
const create = vi.fn();
const getRequest = () =>
  (GET as unknown as Handler)(
    { log: { info: vi.fn() } },
    new Request("http://localhost/api/v1/work/items/task.0001"),
    { id: "principal-1" },
    { params: Promise.resolve({ id: "task.0001" }) },
  );

describe("work-item moves HTTP boundary (story.0033)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch, get, create },
      goalMetrics: { workReadBatch: batch },
    } as never);
  });

  describe("PATCH", () => {
    it("forwards moves and never a client baseline", async () => {
      patch.mockResolvedValue(stored(["convergence-ratio", "up", OBS_BASE]));
      batch.mockResolvedValue([
        {
          baseline: ok(OBS_BASE, 0.2, undefined, "convergence-ratio"),
          current: ok(OBS_B2, 0.4, undefined, "convergence-ratio"),
        },
      ]);
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
        "principal-1",
      );
      expect((await response.json()).moves).toMatchObject([
        {
          metricId: "convergence-ratio",
          direction: "up",
          baselineObservationId: OBS_BASE,
          baseline: {
            id: OBS_BASE,
            metricId: "convergence-ratio",
            value: 0.2,
            observedAt: "2026-11-10T00:00:00.000Z",
          },
          current: {
            id: OBS_B2,
            metricId: "convergence-ratio",
            value: 0.4,
            observedAt: "2026-11-10T00:00:00.000Z",
            unit: "items",
          },
          moved: "as_declared",
        },
      ]);
    });

    it("accepts [] and forwards it", async () => {
      patch.mockResolvedValue({ ...base, moves: [] });
      const response = await patchRequest({
        reason: "docs only",
        set: { moves: [] },
      });
      expect(response.status).toBe(200);
      expect(patch.mock.calls[0]?.[0].set).toEqual({ moves: [] });
      expect((await response.json()).moves).toEqual([]);
      expect(batch).not.toHaveBeenCalled();
    });

    it.each([
      [
        "four entries",
        [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" })),
      ],
      [
        "a repeated id",
        [
          { metricId: "m", direction: "up" },
          { metricId: "m", direction: "down" },
        ],
      ],
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
      expect((await response.json()).issues[0]).toMatchObject({
        path: ["cites"],
      });
    });

    it("maps adapter-bundle copies by name, and moves_unsupported and moves_invalid to 400", async () => {
      const moves = [{ metricId: "m", direction: "up" }];
      patch.mockRejectedValue(
        Object.assign(new Error("copy"), {
          name: "EntryUnresolvedError",
          ids: ["ghost"],
          field: "moves",
        }),
      );
      const unresolved = await patchRequest({ reason: "r", set: { moves } });
      expect(unresolved.status).toBe(400);
      expect((await unresolved.json()).issues[0]).toMatchObject({
        path: ["set", "moves"],
      });

      patch.mockRejectedValue(new MovesUnsupportedError());
      const unsupported = await patchRequest({ reason: "r", set: { moves } });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({
        errorCode: "moves_unsupported",
      });

      patch.mockRejectedValue(
        Object.assign(new Error("bad"), {
          name: "MovesInvalidError",
          issues: ["moves must be an array"],
        }),
      );
      const invalid = await patchRequest({ reason: "r", set: { moves } });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        errorCode: "moves_invalid",
        issues: [{ path: ["set", "moves"], message: "moves must be an array" }],
      });
      patch.mockRejectedValue(new MovesInvalidError(["x"]));
      expect((await patchRequest({ reason: "r", set: { moves } })).status).toBe(
        400,
      );
    });

    it("maps a resolver failure and a baseline failure to their own 503 codes", async () => {
      const moves = [{ metricId: "m", direction: "up" }];
      patch.mockRejectedValue(
        Object.assign(new Error("down"), {
          name: "EntryResolverUnavailableError",
        }),
      );
      const resolver = await patchRequest({ reason: "r", set: { moves } });
      expect(resolver.status).toBe(503);
      expect(await resolver.json()).toMatchObject({
        errorCode: "cite_resolver_unavailable",
      });

      patch.mockRejectedValue(
        Object.assign(new Error("baseline down"), {
          name: "MetricBaselineUnavailableError",
        }),
      );
      const baseline = await patchRequest({ reason: "r", set: { moves } });
      expect(baseline.status).toBe(503);
      expect(await baseline.json()).toMatchObject({
        error: "metric_baseline_unavailable",
        errorCode: "metric_baseline_unavailable",
      });
    });
  });

  describe("POST (create with moves)", () => {
    const filed = { type: "task", title: "Filed with a metric" };

    it("forwards moves, strips a client baseline, and returns the readings", async () => {
      create.mockResolvedValue({
        ...stored(["convergence-ratio", "up", OBS_BASE]),
        id: "task.0002",
      });
      batch.mockResolvedValue([
        {
          baseline: ok(OBS_BASE, 0.25, undefined, "convergence-ratio"),
          current: ok(OBS_B2, 0.5, undefined, "convergence-ratio"),
        },
      ]);
      const response = await postRequest({
        ...filed,
        moves: [
          {
            metricId: "convergence-ratio",
            direction: "up",
            baselineObservationId: OBS_B2,
          },
        ],
      });
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(
        {
          ...filed,
          moves: [{ metricId: "convergence-ratio", direction: "up" }],
        },
        "principal-1",
      );
      expect((await response.json()).moves[0]).toMatchObject({
        baselineObservationId: OBS_BASE,
        baseline: { value: 0.25 },
        current: { value: 0.5 },
        moved: "as_declared",
      });
    });

    it("accepts [] and omits moves when absent", async () => {
      create.mockResolvedValue({ ...base, moves: [] });
      expect((await postRequest({ ...filed, moves: [] })).status).toBe(201);
      expect(create.mock.calls[0]?.[0].moves).toEqual([]);
      create.mockResolvedValue(base);
      expect((await postRequest(filed)).status).toBe(201);
      expect(create.mock.calls[1]?.[0]).not.toHaveProperty("moves");
    });

    it.each([
      [
        "four entries",
        [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" })),
      ],
      [
        "a repeated id",
        [
          { metricId: "m", direction: "up" },
          { metricId: "m", direction: "up" },
        ],
      ],
      ["a bad direction", [{ metricId: "m", direction: "left" }]],
    ])("rejects %s with 400 before the store", async (_name, moves) => {
      expect((await postRequest({ ...filed, moves })).status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });

    it("maps an unknown metric to 400 at the moves path, unsupported to 400, and a baseline failure to 503", async () => {
      const moves = [{ metricId: "ghost", direction: "up" }];
      create.mockRejectedValue(new EntryUnresolvedError(["ghost"], "moves"));
      const unknown = await postRequest({ ...filed, moves });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({
        errorCode: "cite_unresolved",
        issues: [
          { path: ["moves"], message: "metric not found or deprecated: ghost" },
        ],
      });

      create.mockRejectedValue(new MovesUnsupportedError());
      const unsupported = await postRequest({ ...filed, moves });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({
        errorCode: "moves_unsupported",
      });

      create.mockRejectedValue(
        Object.assign(new Error("down"), {
          name: "MetricBaselineUnavailableError",
        }),
      );
      const baseline = await postRequest({ ...filed, moves });
      expect(baseline.status).toBe(503);
      expect(await baseline.json()).toMatchObject({
        errorCode: "metric_baseline_unavailable",
      });
    });
  });

  describe("GET (read-time enrichment)", () => {
    const readings = (baseline: number | null, current: number | null) => {
      batch.mockImplementation(
        async (
          requests: {
            metricId: string;
            baselineObservationId: string | null;
          }[],
        ) =>
          requests.map(({ metricId, baselineObservationId }) => ({
            baseline:
              baseline === null || baselineObservationId === null
                ? null
                : ok(OBS_BASE, baseline, "2026-11-01T00:00:00.000Z", metricId),
            current:
              current === null
                ? null
                : ok(OBS_B2, current, "2026-11-10T00:00:00.000Z", metricId),
          })),
      );
    };
    const moveOf = async () => (await (await getRequest()).json()).moves[0];

    it.each([
      ["up", 1, 2, "as_declared"],
      ["up", 2, 1, "against"],
      ["down", 2, 1, "as_declared"],
      ["down", 1, 2, "against"],
      ["up", 3, 3, "flat"],
    ] as const)(
      "%s from %s to %s is %s",
      async (direction, from, to, expected) => {
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
      },
    );

    it("a null baseline keeps the current reading and reads unknown (no_baseline), never zero", async () => {
      get.mockResolvedValue(stored(["m-1", "up", null]));
      readings(1, 5);
      expect(await moveOf()).toMatchObject({
        baselineObservationId: null,
        baseline: null,
        current: { value: 5 },
        moved: "unknown",
        unknownReason: "no_baseline",
      });
      expect(batch).toHaveBeenCalledOnce();
    });

    it("a pinned observation that cannot be read, or no current reading, reads unknown", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      readings(null, 5);
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "baseline_unreadable",
      });
      readings(1, null);
      expect(await moveOf()).toMatchObject({
        baseline: { value: 1 },
        current: null,
        moved: "unknown",
        unknownReason: "no_current",
      });
    });

    it("a deprecated metric reads unknown (metric_deprecated), not a failure, and a stored entry shows its pinned baseline id", async () => {
      get.mockResolvedValue(
        stored(["old-metric", "up", OBS_BASE], ["live", "up", OBS_BASE]),
      );
      batch.mockResolvedValue([
        { baseline: null, current: null, unknownReason: "metric_deprecated" },
        {
          baseline: ok(OBS_BASE, 1, undefined, "live"),
          current: ok(OBS_B2, 2, undefined, "live"),
        },
      ]);
      const response = await getRequest();
      expect(response.status).toBe(200);
      const moves = (await response.json()).moves;
      expect(moves[0]).toMatchObject({
        metricId: "old-metric",
        baselineObservationId: OBS_BASE,
        moved: "unknown",
        unknownReason: "metric_deprecated",
      });
      expect(moves[1]).toMatchObject({ moved: "as_declared" });
    });

    it("a missing observation is not a deprecated metric", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      batch.mockResolvedValue([{ baseline: null, current: ok(OBS_B2, 2) }]);
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "baseline_unreadable",
      });
    });

    it("a failing metrics service reads unknown and never fails the item read", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      batch.mockRejectedValue(new Error("db down"));
      const response = await getRequest();
      expect(response.status).toBe(200);
      expect((await response.json()).moves[0]).toMatchObject({
        moved: "unknown",
      });
    });

    it("a node with no metrics service reads every move unknown (metrics_unavailable)", async () => {
      vi.mocked(getContainer).mockReturnValue({
        doltgresWorkItems: { patch, get },
      } as never);
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "metrics_unavailable",
      });
    });

    it("reads all three ordered moves through one batch", async () => {
      get.mockResolvedValue(
        stored(
          ["m-1", "up", OBS_BASE],
          ["m-2", "down", OBS_BASE],
          ["m-3", "up", OBS_BASE],
        ),
      );
      readings(1, 2);
      const moves = (await (await getRequest()).json()).moves;
      expect(moves.map((m: { moved: string }) => m.moved)).toEqual([
        "as_declared",
        "against",
        "as_declared",
      ]);
      expect(batch).toHaveBeenCalledOnce();
      expect(batch.mock.calls[0]?.[0]).toEqual([
        { metricId: "m-1", baselineObservationId: OBS_BASE },
        { metricId: "m-2", baselineObservationId: OBS_BASE },
        { metricId: "m-3", baselineObservationId: OBS_BASE },
      ]);
    });

    it("an item that declares no moves costs no lookup, and [] stays []", async () => {
      get.mockResolvedValue(base);
      const plain = await (await getRequest()).json();
      expect(plain).not.toHaveProperty("moves");
      get.mockResolvedValue({ ...base, moves: [] });
      expect((await (await getRequest()).json()).moves).toEqual([]);
      expect(batch).not.toHaveBeenCalled();
    });

    it("a failed observation never counts as a reading", async () => {
      get.mockResolvedValue(stored(["m-1", "up", OBS_BASE]));
      batch.mockResolvedValue([
        {
          baseline: { ...ok(OBS_BASE, 1), status: "error" },
          current: ok(OBS_B2, 2),
        },
      ]);
      expect(await moveOf()).toMatchObject({
        moved: "unknown",
        unknownReason: "incompatible_reading",
      });
    });
  });
});
