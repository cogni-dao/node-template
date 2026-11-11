// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-moves`
 * Purpose: Drives DoltgresWorkItemAdapter.patch() with `set.moves` so the pin-once baseline rule is proven (story.0033).
 * Scope: Fake `Sql` over one in-memory row. No real database.
 * Invariants:
 *   - MOVES_PIN_ONCE: a new entry reads the metric's latest observation once; an entry already on the row keeps its baseline; removing and re-adding pins a new one; no observation stores null.
 *   - NEW_ENTRIES_ARE_RESOLVED: only ids new on the item go through the resolver under rule "metric"; an unknown or deprecated NEW id is EntryUnresolvedError and nothing is written. A stored entry is kept, even if its metric was deprecated since.
 *   - CREATE_PINS_TOO: a create with `moves` validates and pins the baseline the same way, once, and writes nothing on failure.
 *   - BASELINE_FAILURE_IS_ITS_OWN_ERROR: a baseline reader that fails or hangs is MetricBaselineUnavailableError, not the resolver's error.
 *   - INSIDE_THE_LOCK: the resolver and the baseline reader run inside the writer lock and before the branch checkout.
 *   - WIRING_IS_EXPLICIT: a non-empty write with no resolver or baseline reader is MovesUnsupportedError; `[]` needs neither.
 * Side-effects: none
 * Links: hub metric-foundation-design, packages/work-items/src/moves.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
} from "../../src/adapters/doltgres/adapter.js";
import {
  type EntryResolver,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "../../src/cites.js";
import {
  MetricBaselineUnavailableError,
  type MetricBaselinePort,
  MovesInvalidError,
  MovesUnsupportedError,
} from "../../src/moves.js";
import { toWorkItemId } from "../../src/types.js";
import {
  independentReadPool,
  makeFakeDoltgresSql,
} from "./fake-doltgres-sql.js";

const ID = "task.0001";
const PRINCIPAL = "principal-creator";
const COMMIT = "a".repeat(32);
const OBS_1 = "11111111-1111-4111-8111-111111111111";
const OBS_2 = "22222222-2222-4222-8222-222222222222";
const OBS_3 = "33333333-3333-4333-8333-333333333333";

const seed = {
  id: ID,
  type: "task",
  title: "move a metric",
  status: "needs_implement",
  node: "operator",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: [],
  spec_refs: [],
  revision: 3,
  deploy_verified: false,
  created_by_principal_id: PRINCIPAL,
  claimed_by_run: null,
  claimed_at: null,
  claim_owner_principal_id: null,
  claim_expires_at: null,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
};

function harness(adapter: Partial<DoltgresWorkItemAdapterOptions> = {}) {
  const queries: string[] = [];
  const store = new Map<string, Record<string, unknown>>([[ID, { ...seed }]]);
  const respond = (query: string) => {
    if (query.startsWith("SELECT id FROM work_items")) return [];
    if (query.startsWith("UPDATE work_items")) {
      const current = store.get(/WHERE id = '([^']+)'/.exec(query)?.[1] ?? "");
      if (!current) return [];
      const next: Record<string, unknown> = {
        ...current,
        revision: Number(current.revision) + 1,
        claim_active: false,
      };
      const title = /\btitle = '([^']*)'/.exec(query)?.[1];
      if (title !== undefined) next.title = title;
      const moves = /\bmoves = '(.*?)'::jsonb/.exec(query)?.[1];
      if (moves !== undefined) next.moves = JSON.parse(moves.replace(/''/g, "'"));
      store.set(ID, next);
      return [next];
    }
    if (query.startsWith("INSERT INTO work_items")) {
      const id = /VALUES \('([^']+)'/.exec(query)?.[1] ?? "";
      const written = /'(\[.*?\])'::jsonb/.exec(query)?.[1];
      const row: Record<string, unknown> = { ...seed, id, revision: 0 };
      if (written !== undefined) row.moves = JSON.parse(written.replace(/''/g, "'"));
      store.set(id, row);
      return [row];
    }
    const byId = /FROM work_items WHERE id = '([^']+)'/.exec(query)?.[1];
    if (byId) {
      const row = store.get(byId);
      return row ? [{ ...row, claim_active: false }] : [];
    }
    return [];
  };
  const sql = makeFakeDoltgresSql(respond, queries);
  return {
    queries,
    store,
    adapter: new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
      recreateClient: () => sql,
      ...adapter,
    }),
  };
}

const metricResolver = (live: readonly string[]) =>
  vi.fn<EntryResolver["resolve"]>(async (refs, rule) => {
    if (rule !== "metric") throw new Error(`unexpected rule ${rule}`);
    const ghosts = refs.filter((r) => !live.includes(r.id)).map((r) => r.id);
    if (ghosts.length) throw new EntryUnresolvedError(ghosts);
    return refs.map((r) => ({ id: r.id, commit: COMMIT, plane: "main" as const }));
  });

/** A baseline reader that answers each metric from a queue, one observation per call. */
const baselines = (byMetric: Record<string, (string | null)[]>) => {
  const calls: string[] = [];
  const port: MetricBaselinePort = {
    latestObservationId: async (metricId) => {
      calls.push(metricId);
      return byMetric[metricId]?.shift() ?? null;
    },
  };
  return { port, calls };
};

function wired(
  live: readonly string[],
  byMetric: Record<string, (string | null)[]> = {}
) {
  const resolve = metricResolver(live);
  const reader = baselines(byMetric);
  return {
    ...harness({ entryResolver: { resolve }, metricBaseline: reader.port }),
    resolve,
    calls: reader.calls,
  };
}

const patch = (
  adapter: DoltgresWorkItemAdapter,
  set: Record<string, unknown>,
  reason = "this moves the metric"
) => adapter.patch({ id: toWorkItemId(ID), reason, set } as never, PRINCIPAL);
const setMoves = (adapter: DoltgresWorkItemAdapter, moves: unknown) =>
  patch(adapter, { moves });

const update = (queries: string[]) =>
  queries.find((q) => q.startsWith("UPDATE work_items"));
const branched = (queries: string[]) =>
  queries.some((q) => q.includes("dolt_checkout('-b'"));
const committed = (queries: string[]) =>
  queries.some((q) => q.startsWith("SELECT dolt_commit"));
const unlocked = (queries: string[]) =>
  queries.some((q) => q.startsWith("SELECT pg_advisory_unlock"));

describe("DoltgresWorkItemAdapter.patch — moves (story.0033)", () => {
  it("pins the latest observation as the baseline when an entry first appears", async () => {
    const { adapter, queries, store, resolve, calls } = wired(
      ["convergence-ratio"],
      { "convergence-ratio": [OBS_1] }
    );
    const result = await setMoves(adapter, [
      { metricId: "convergence-ratio", direction: "up" },
    ]);
    const stored = [
      { metricId: "convergence-ratio", direction: "up", baselineObservationId: OBS_1 },
    ];
    expect(result.moves).toEqual(stored);
    expect(store.get(ID)?.moves).toEqual(stored);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[1]).toBe("metric");
    expect(resolve.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(calls).toEqual(["convergence-ratio"]);
    expect(update(queries)).toContain("moves = '");
    expect(committed(queries)).toBe(true);
  });

  it("is a write by itself, and its reason is the commit's Reason line", async () => {
    const { adapter, queries } = wired(["m-1"], { "m-1": [OBS_1] });
    await setMoves(adapter, [{ metricId: "m-1", direction: "down" }]);
    expect(update(queries)).toBeDefined();
    const message = /SELECT dolt_commit\('-m', '([\s\S]*)'\)/.exec(
      queries.find((q) => q.startsWith("SELECT dolt_commit")) ?? ""
    )?.[1];
    expect(message).toContain("Reason: this moves the metric");
  });

  it("resolves and reads the baseline inside the writer lock, before the branch checkout", async () => {
    const order: string[] = [];
    const { adapter, queries } = harness({
      entryResolver: {
        resolve: async (refs) => {
          order.push(
            `locked=${queries.some((q) => q.startsWith("SELECT pg_try_advisory_lock"))}`,
            `branch=${branched(queries)}`
          );
          return refs.map((r) => ({ id: r.id, commit: COMMIT, plane: "main" as const }));
        },
      },
      metricBaseline: {
        latestObservationId: async () => {
          order.push(`baseline-branch=${branched(queries)}`);
          return OBS_1;
        },
      },
    });
    await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    expect(order).toEqual(["locked=true", "branch=false", "baseline-branch=false"]);
  });

  it("keeps the stored baseline of an entry that stays, and ignores one the client sends", async () => {
    const { adapter, store, calls } = wired(["m-1", "m-2"], {
      "m-1": [OBS_1, OBS_3],
      "m-2": [OBS_2],
    });
    await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    // The client sends a baseline and a new direction; the baseline stays the server's.
    const result = await setMoves(adapter, [
      { metricId: "m-1", direction: "down", baselineObservationId: OBS_3 },
      { metricId: "m-2", direction: "up" },
    ]);
    expect(result.moves).toEqual([
      { metricId: "m-1", direction: "down", baselineObservationId: OBS_1 },
      { metricId: "m-2", direction: "up", baselineObservationId: OBS_2 },
    ]);
    expect(store.get(ID)?.moves).toEqual(result.moves);
    // m-1 was read once, on the first write; the second write read only the new entry.
    expect(calls).toEqual(["m-1", "m-2"]);
  });

  it("an unrelated patch leaves moves, and their baselines, alone", async () => {
    const { adapter, store, calls } = wired(["m-1"], { "m-1": [OBS_1] });
    await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    const result = await patch(adapter, { title: "renamed" }, "rename");
    expect(result.moves).toEqual([
      { metricId: "m-1", direction: "up", baselineObservationId: OBS_1 },
    ]);
    expect(store.get(ID)?.moves).toHaveLength(1);
    expect(calls).toEqual(["m-1"]);
  });

  it("removing an entry and adding it back pins a new baseline", async () => {
    const { adapter, store, calls } = wired(["m-1"], { "m-1": [OBS_1, OBS_2] });
    await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    await setMoves(adapter, []);
    expect(store.get(ID)?.moves).toEqual([]);
    const result = await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    expect(result.moves).toEqual([
      { metricId: "m-1", direction: "up", baselineObservationId: OBS_2 },
    ]);
    expect(calls).toEqual(["m-1", "m-1"]);
  });

  it("stores a null baseline when the metric has no observation yet", async () => {
    const { adapter, store } = wired(["m-1"], { "m-1": [null] });
    const result = await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    expect(result.moves).toEqual([
      { metricId: "m-1", direction: "up", baselineObservationId: null },
    ]);
    expect(store.get(ID)?.moves).toEqual(result.moves);
  });

  it("stores [] as an explicit declaration and needs no wiring", async () => {
    const { adapter, store, queries } = harness();
    const result = await setMoves(adapter, []);
    expect(result.moves).toEqual([]);
    expect(store.get(ID)?.moves).toEqual([]);
    expect(update(queries)).toContain("moves = '[]'::jsonb");
  });

  it("an unknown or deprecated metric id is EntryUnresolvedError for moves: lock released, nothing written", async () => {
    const { adapter, queries, store, calls } = wired(["m-1"], { "m-1": [OBS_1] });
    const attempt = setMoves(adapter, [
      { metricId: "m-1", direction: "up" },
      { metricId: "ghost", direction: "down" },
    ]);
    await expect(attempt).rejects.toBeInstanceOf(EntryUnresolvedError);
    await expect(attempt).rejects.toMatchObject({ ids: ["ghost"], field: "moves" });
    expect(calls).toEqual([]);
    expect(branched(queries)).toBe(false);
    expect(update(queries)).toBeUndefined();
    expect(unlocked(queries)).toBe(true);
    expect(store.get(ID)?.moves).toBeUndefined();
  });

  it("resolves only ids that are new: a stored entry whose metric was deprecated since is kept, and unrelated saves still work", async () => {
    const first = wired(["m-1"], { "m-1": [OBS_1] });
    await setMoves(first.adapter, [{ metricId: "m-1", direction: "up" }]);
    // m-1 is deprecated since: the resolver no longer lists it. m-2 is new and live.
    const resolve = metricResolver(["m-2"]);
    const reader = baselines({ "m-2": [OBS_2] });
    const later = harness({ entryResolver: { resolve }, metricBaseline: reader.port });
    later.store.set(ID, { ...seed, moves: first.store.get(ID)?.moves });

    // An unrelated patch never touches moves.
    await expect(patch(later.adapter, { title: "renamed" }, "rename")).resolves.toMatchObject({
      title: "renamed",
    });
    expect(resolve).not.toHaveBeenCalled();

    // Re-sending the stored entry (even with a new direction) and adding a live one resolves only m-2.
    const result = await setMoves(later.adapter, [
      { metricId: "m-1", direction: "down" },
      { metricId: "m-2", direction: "up" },
    ]);
    expect(result.moves).toEqual([
      { metricId: "m-1", direction: "down", baselineObservationId: OBS_1 },
      { metricId: "m-2", direction: "up", baselineObservationId: OBS_2 },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toEqual([{ id: "m-2" }]);
    expect(reader.calls).toEqual(["m-2"]);

    // A NEW deprecated id is still refused.
    await expect(
      setMoves(later.adapter, [
        { metricId: "m-1", direction: "down" },
        { metricId: "m-3", direction: "up" },
      ])
    ).rejects.toMatchObject({ name: "EntryUnresolvedError", ids: ["m-3"], field: "moves" });
    // Re-sending only stored entries calls no resolver at all.
    resolve.mockClear();
    await expect(
      setMoves(later.adapter, [{ metricId: "m-1", direction: "up" }])
    ).resolves.toMatchObject({ moves: [{ metricId: "m-1", baselineObservationId: OBS_1 }] });
    expect(resolve).not.toHaveBeenCalled();
    // A deprecated stored entry can be dropped.
    await expect(setMoves(later.adapter, [])).resolves.toMatchObject({ moves: [] });
  });

  it.each([
    ["four entries", [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" }))],
    ["a repeated id", [{ metricId: "m-1", direction: "up" }, { metricId: "m-1", direction: "down" }]],
    ["an empty id", [{ metricId: "", direction: "up" }]],
    ["a 41-character id", [{ metricId: "x".repeat(41), direction: "up" }]],
    ["a bad direction", [{ metricId: "m-1", direction: "sideways" }]],
    ["a non-array", { metricId: "m-1", direction: "up" }],
  ])("refuses %s before any SQL", async (_name, moves) => {
    const { adapter, queries, resolve } = wired(["m-1"]);
    await expect(setMoves(adapter, moves)).rejects.toBeInstanceOf(MovesInvalidError);
    expect(queries).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts three entries and a 40-character id", async () => {
    const long = "x".repeat(40);
    const { adapter } = wired(["m-1", "m-2", long], {
      "m-1": [OBS_1],
      "m-2": [OBS_2],
      [long]: [OBS_3],
    });
    const result = await setMoves(
      adapter,
      ["m-1", "m-2", long].map((metricId) => ({ metricId, direction: "up" }))
    );
    expect(result.moves).toHaveLength(3);
  });

  it.each([
    ["neither", {}],
    ["no baseline reader", { entryResolver: { resolve: metricResolver(["m-1"]) } }],
    ["no resolver", { metricBaseline: baselines({}).port }],
  ])("refuses a non-empty moves with %s wired, before any SQL", async (_name, options) => {
    const { adapter, queries } = harness(options);
    await expect(
      setMoves(adapter, [{ metricId: "m-1", direction: "up" }])
    ).rejects.toBeInstanceOf(MovesUnsupportedError);
    expect(queries).toHaveLength(0);
  });

  it("a baseline reader that fails is MetricBaselineUnavailableError (503 metric_baseline_unavailable) and writes nothing", async () => {
    const { adapter, queries } = harness({
      entryResolver: { resolve: metricResolver(["m-1"]) },
      metricBaseline: {
        latestObservationId: async () => {
          throw new Error("db down");
        },
      },
    });
    await expect(
      setMoves(adapter, [{ metricId: "m-1", direction: "up" }])
    ).rejects.toMatchObject({
      name: "MetricBaselineUnavailableError",
      code: "metric_baseline_unavailable",
    });
    expect(branched(queries)).toBe(false);
    expect(unlocked(queries)).toBe(true);
  });

  it("a baseline reader that never answers is MetricBaselineUnavailableError within the deadline, lock free", async () => {
    const { adapter, queries } = harness({
      queryTimeoutMs: 30,
      entryResolver: { resolve: metricResolver(["m-1"]) },
      metricBaseline: { latestObservationId: () => new Promise(() => undefined) },
    });
    const attempt = setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    await expect(attempt).rejects.toBeInstanceOf(MetricBaselineUnavailableError);
    await expect(attempt).rejects.not.toBeInstanceOf(EntryResolverUnavailableError);
    expect(branched(queries)).toBe(false);
    expect(unlocked(queries)).toBe(true);
  });

  it("a resolver that fails is EntryResolverUnavailableError, not an unknown metric", async () => {
    const { adapter, queries } = harness({
      entryResolver: {
        resolve: async () => {
          throw new Error("dolt down");
        },
      },
      metricBaseline: baselines({}).port,
    });
    await expect(
      setMoves(adapter, [{ metricId: "m-1", direction: "up" }])
    ).rejects.toBeInstanceOf(EntryResolverUnavailableError);
    expect(branched(queries)).toBe(false);
  });

  it("a baseline that is not an observation id is stored as null, never trusted", async () => {
    const { adapter } = wired(["m-1"], { "m-1": ["not-a-uuid"] });
    const result = await setMoves(adapter, [{ metricId: "m-1", direction: "up" }]);
    expect(result.moves?.[0]?.baselineObservationId).toBeNull();
  });

  describe("create (story.0033)", () => {
    const create = (adapter: DoltgresWorkItemAdapter, moves?: unknown) =>
      adapter.create(
        { type: "task", title: "filed with a metric", ...(moves !== undefined && { moves }) } as never,
        PRINCIPAL
      );
    const insert = (queries: string[]) =>
      queries.find((q) => q.startsWith("INSERT INTO work_items"));

    it("validates, pins the baseline once and stores moves on the new row", async () => {
      const { adapter, queries, resolve, calls } = wired(["m-1", "m-2"], {
        "m-1": [OBS_1],
        "m-2": [null],
      });
      const created = await create(adapter, [
        { metricId: "m-1", direction: "up" },
        { metricId: "m-2", direction: "down" },
      ]);
      expect(created.moves).toEqual([
        { metricId: "m-1", direction: "up", baselineObservationId: OBS_1 },
        { metricId: "m-2", direction: "down", baselineObservationId: null },
      ]);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls[0]?.[0]).toEqual([{ id: "m-1" }, { id: "m-2" }]);
      expect(resolve.mock.calls[0]?.[1]).toBe("metric");
      expect(calls).toEqual(["m-1", "m-2"]);
      expect(insert(queries)).toMatch(/^INSERT INTO work_items \([^)]*\bmoves\b[^)]*\) VALUES/);
      expect(committed(queries)).toBe(true);
    });

    it("drops a baseline a client sends only at the HTTP edge; the adapter never reads one from input", async () => {
      const { adapter } = wired(["m-1"], { "m-1": [OBS_1] });
      const created = await create(adapter, [
        { metricId: "m-1", direction: "up", baselineObservationId: OBS_3 },
      ]);
      expect(created.moves?.[0]?.baselineObservationId).toBe(OBS_1);
    });

    it("an item created without moves has none; [] is stored as a declaration and needs no wiring", async () => {
      const plain = wired(["m-1"]);
      expect(insert((await create(plain.adapter, undefined), plain.queries))).not.toMatch(/\bmoves\b/);
      expect(plain.resolve).not.toHaveBeenCalled();
      const bare = harness();
      const created = await create(bare.adapter, []);
      expect(created.moves).toEqual([]);
      expect(insert(bare.queries)).toContain("'[]'::jsonb");
    });

    it("an unknown or deprecated metric writes nothing", async () => {
      const { adapter, queries, calls } = wired(["m-1"], { "m-1": [OBS_1] });
      const attempt = create(adapter, [
        { metricId: "m-1", direction: "up" },
        { metricId: "ghost", direction: "up" },
      ]);
      await expect(attempt).rejects.toBeInstanceOf(EntryUnresolvedError);
      await expect(attempt).rejects.toMatchObject({ ids: ["ghost"], field: "moves" });
      expect(calls).toEqual([]);
      expect(queries).toHaveLength(0);
    });

    it("refuses a bad list and a missing wiring before any SQL, and a failing baseline reader is its own error", async () => {
      const { adapter, queries } = wired(["m-1"]);
      await expect(
        create(adapter, [1, 2, 3, 4].map((i) => ({ metricId: `m-${i}`, direction: "up" })))
      ).rejects.toBeInstanceOf(MovesInvalidError);
      const bare = harness();
      await expect(
        create(bare.adapter, [{ metricId: "m-1", direction: "up" }])
      ).rejects.toBeInstanceOf(MovesUnsupportedError);
      const failing = harness({
        entryResolver: { resolve: metricResolver(["m-1"]) },
        metricBaseline: {
          latestObservationId: async () => {
            throw new Error("db down");
          },
        },
      });
      await expect(
        create(failing.adapter, [{ metricId: "m-1", direction: "up" }])
      ).rejects.toBeInstanceOf(MetricBaselineUnavailableError);
      expect([...queries, ...bare.queries, ...failing.queries]).toHaveLength(0);
    });
  });
});
