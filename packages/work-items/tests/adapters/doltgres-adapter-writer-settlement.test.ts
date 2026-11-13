// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.0042: one Doltgres transport failure must not hold every write until a
 * restart. A failure before the writer-lock request holds nothing; a real
 * outcome-unknown is settled by fencing (fresh session wins the writer lock,
 * then the restart reconciliation runs) without replaying the write.
 */

import { toWorkItemId } from "@cogni-dao/work-items";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type WorkItemLogger,
} from "../../src/adapters/doltgres/adapter.js";

type Rows = ReadonlyArray<Record<string, unknown>>;

interface Generation {
  readonly number: number;
  ended: boolean;
}

interface Behaviour {
  /** Answer for one query on one pool generation; `undefined` falls through to the healthy default. */
  (query: string, generation: Generation): Promise<Rows> | undefined;
}

function transportError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

function makeHarness(behaviour: Behaviour, options: Record<string, number> = {}) {
  const queries: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const generations: Generation[] = [];
  const logger: WorkItemLogger = {
    info: (fields) => events.push(fields),
    warn: (fields) => events.push(fields),
    error: (fields) => events.push(fields),
  };
  const buildPool = (): Sql => {
    const generation: Generation = { number: generations.length + 1, ended: false };
    generations.push(generation);
    const unsafe = async (query: string): Promise<Rows> => {
      queries.push(`pool-${generation.number}:${query}`);
      const scripted = behaviour(query, generation);
      if (scripted) return scripted;
      if (generation.ended) throw transportError("CONNECTION_ENDED");
      if (query.includes("current_database"))
        return [{ dolt_writer_database: "native_test" }];
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query === "SELECT dolt_checkout('main')")
        return [{ dolt_checkout: [0, ""] }];
      return [];
    };
    return {
      options: { max: 1 },
      unsafe,
      reserve: async () => ({ unsafe, release: () => undefined }),
      end: async () => {
        generation.ended = true;
      },
    } as unknown as Sql;
  };
  const adapter = new DoltgresWorkItemAdapter(buildPool(), {
    logger,
    queryTimeoutMs: 5,
    reserveTimeoutMs: 100,
    lockWaitMs: 1,
    settleBaseMs: 2,
    settleMaxMs: 8,
    settleGraceMs: 5,
    settleWaitMs: 10,
    recreateClient: buildPool,
    readClient: { options: { max: 1 }, unsafe: async () => [] } as unknown as Sql,
    ...options,
  });
  const named = (event: string) =>
    events.filter((fields) => fields.event === `adapter.work_items.${event}`);
  return { adapter, queries, events, generations, named };
}

async function eventually(check: () => boolean, milliseconds = 1_000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const probe = (id = "task.9998") =>
  ({ reason: "test change", id: toWorkItemId(id), set: { title: "after" } }) as const;

describe("writer recovers from transport failures without a restart (bug.0042)", () => {
  it("a connect timeout on the pool probe never holds the writer (production 2026-11-13)", async () => {
    let connected = false;
    const { adapter, named, generations, queries } = makeHarness((query) => {
      if (query !== "SELECT 1 AS work_items_ready" || connected) return undefined;
      connected = true;
      // The caller's 5 ms budget expires first; the socket gives up later.
      return new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(transportError("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT cogni-substrate:5435")),
          20
        )
      );
      // As in production: connect_timeout (10 s) settles inside the grace (15 s).
    }, { settleGraceMs: 200 });

    await expect(adapter.patch(probe(), "principal-1")).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    await eventually(() => adapter.writerHealth().state === "available");

    expect(named("writer_held")).toEqual([
      expect.objectContaining({ holdReason: "caller_abandoned", nativeState: "pending" }),
    ]);
    expect(named("writer_recovered")).toEqual([
      expect.objectContaining({ settledBy: "execution" }),
    ]);
    expect(named("stage_error")).toContainEqual(
      expect.objectContaining({
        stage: "connection.probe",
        errorCode: "CONNECT_TIMEOUT",
        effectsPossible: false,
      })
    );
    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(/not found/);
    expect(generations).toHaveLength(1);
    expect(queries.some((query) => /INSERT|UPDATE|DELETE/.test(query))).toBe(false);
  });

  it("a connect failure inside the budget is a plain retryable error", async () => {
    let failed = false;
    const { adapter, named } = makeHarness(
      (query) => {
        if (query !== "SELECT 1 AS work_items_ready" || failed) return undefined;
        failed = true;
        return Promise.reject(transportError("ECONNREFUSED"));
      },
      { queryTimeoutMs: 50 }
    );

    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(
      /connection failed before any write/
    );
    expect(adapter.writerHealth()).toEqual({ state: "available" });
    expect(named("writer_held")).toHaveLength(0);
    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(/not found/);
  });

  it("an outcome-unknown lock request holds, refuses, then settles by fencing", async () => {
    const { adapter, named, generations, queries } = makeHarness((query, generation) =>
      generation.number === 1 && query.includes("pg_try_advisory_lock")
        ? Promise.reject(transportError("ECONNRESET"))
        : undefined
    , { settleBaseMs: 40, settleMaxMs: 40 });

    await expect(adapter.patch(probe(), "principal-1")).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    const held = adapter.writerHealth();
    expect(held).toMatchObject({
      state: "held",
      nativeState: "unknown",
      reason: "outcome_unknown",
      stage: "lock.try",
    });
    await expect(adapter.patch(probe(), "principal-1")).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    expect(named("writer_refused")).toHaveLength(1);

    await eventually(() => named("writer_recovered").length > 0);
    expect(named("writer_recovered")[0]).toMatchObject({
      settledBy: "fencing",
      holdReason: "outcome_unknown",
      errorCode: "ECONNRESET",
    });
    expect(generations[0]?.ended).toBe(true);
    expect(generations).toHaveLength(2);
    // The fresh session won the lock and swept op branches before admitting writes.
    expect(queries).toContain("pool-2:SELECT name, hash FROM dolt.branches");
    expect(adapter.writerHealth()).toEqual({ state: "available" });
    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(/not found/);
    expect(queries.some((query) => /INSERT|UPDATE|DELETE/.test(query))).toBe(false);
  });

  it("a contended writer lock backs off until the old session lets go", async () => {
    let contended = 3;
    const { adapter, named } = makeHarness((query, generation) => {
      if (!query.includes("pg_try_advisory_lock")) return undefined;
      if (generation.number === 1) return Promise.reject(transportError("EPIPE"));
      if (contended > 0) {
        contended -= 1;
        return Promise.resolve([{ pg_try_advisory_lock: false }]);
      }
      return undefined;
    });

    await expect(adapter.patch(probe(), "principal-1")).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    await eventually(() => named("writer_recovered").length > 0);
    const outcomes = named("writer_settle_attempt").map((fields) => fields.outcome);
    expect(outcomes[0]).toBe("lock_contended");
    expect(outcomes.at(-1)).toBe("recovered");
    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(/not found/);
  });

  it("settles a half-open session and ignores its late failure", async () => {
    let rejectHung: ((error: Error) => void) | undefined;
    const { adapter, named } = makeHarness((query, generation) =>
      generation.number === 1 && query.includes("pg_try_advisory_lock")
        ? new Promise<Rows>((_resolve, reject) => {
            rejectHung = reject;
          })
        : undefined
    );

    await expect(adapter.patch(probe(), "principal-1")).rejects.toMatchObject({
      code: "work_items_native_capacity_held",
    });
    await eventually(() => named("writer_recovered").length > 0);
    expect(named("writer_settle_attempt").at(-1)).toMatchObject({
      outcome: "recovered",
      executionSettled: false,
    });

    rejectHung?.(transportError("ECONNRESET"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(named("stage_error")).toContainEqual(
      expect.objectContaining({ reason: "retired_generation_ignored" })
    );
    expect(adapter.writerHealth()).toEqual({ state: "available" });
    await expect(adapter.patch(probe(), "principal-1")).rejects.toThrow(/not found/);
  });
});
