// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Behavioral proof for isolated logical writes; native engine semantics remain a CI gate. */
import { describe, expect, it, vi } from "vitest";
import {
  DoltBranchMutationUncertainError,
  runDoltBranchMutation,
} from "../src/branch-mutation.js";
import {
  acquireDoltWriterLocks,
  type DoltWriterConnection,
} from "../src/locks.js";

const HASH = "a".repeat(32);
function engine(
  overrides: {
    lostMergeAck?: boolean;
    cleanupFails?: boolean;
    callbackSqlFails?: boolean;
    existing?: boolean;
    malformedMerge?: boolean;
  } = {}
) {
  let active = "main";
  let dirty = false;
  const queries: string[] = [];
  const connection: DoltWriterConnection = {
    async unsafe(query) {
      queries.push(query);
      if (query.includes("current_database()"))
        return [{ dolt_writer_database: "knowledge_operator" }];
      if (query.includes("pg_try_advisory_lock"))
        return [{ pg_try_advisory_lock: true }];
      if (query.includes("pg_advisory_unlock"))
        return [{ pg_advisory_unlock: true }];
      if (query.startsWith("SELECT name FROM dolt.branches"))
        return overrides.existing ? [{ name: "retained" }] : [];
      if (query === "SELECT dolt_checkout('main')") {
        active = "main";
        return [{ dolt_checkout: 0 }];
      }
      if (query.startsWith("SELECT dolt_checkout('-b'")) {
        active = query.split("'")[3] ?? "";
        return [{ dolt_checkout: 0 }];
      }
      if (query.includes("active_branch()")) return [{ branch_name: active }];
      if (query === "SELECT * FROM dolt.status")
        return dirty ? [{ table_name: "knowledge" }] : [];
      if (query === "INSERT domain row") {
        dirty = true;
        if (overrides.callbackSqlFails) throw new Error("connection lost");
        return [];
      }
      if (query.startsWith("SELECT dolt_reset")) {
        expect(active).not.toBe("main");
        dirty = false;
        return [{ dolt_reset: 0 }];
      }
      if (query.startsWith("SELECT dolt_commit")) {
        dirty = false;
        return [{ dolt_commit: [HASH] }];
      }
      if (query.startsWith("SELECT dolt_hashof"))
        return [{ commit_hash: HASH }];
      if (query.startsWith("SELECT hash, fast_forward")) {
        if (overrides.lostMergeAck)
          throw new Error("merge acknowledgement lost");
        return overrides.malformedMerge
          ? [{}]
          : [
              {
                hash: HASH,
                fast_forward: true,
                conflicts: 0,
                message: "merged",
              },
            ];
      }
      if (query.startsWith("SELECT dolt_merge_base"))
        return [{ merge_base: HASH }];
      if (query.startsWith("SELECT dolt_branch('-D'")) {
        if (overrides.cleanupFails) throw new Error("cleanup failed");
        return [{ dolt_branch: 0 }];
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };
  return { connection, queries };
}
async function setup(options: Parameters<typeof engine>[0] = {}) {
  const fixture = engine(options);
  const guard = await acquireDoltWriterLocks(fixture.connection);
  const poison = vi.fn(async () => {});
  return { ...fixture, guard, poison };
}

describe("runDoltBranchMutation", () => {
  it("commits one logical unit and proves its exact hash on main", async () => {
    const f = await setup();
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "knowledge:test",
      message: "entry plus edge",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
        return "result";
      },
    });
    expect(result).toEqual({
      value: "result",
      commitHash: HASH,
      cleanupUncertain: false,
    });
    expect(
      f.queries.filter((q) => q.startsWith("SELECT dolt_commit"))
    ).toHaveLength(1);
    expect(f.poison).not.toHaveBeenCalled();
  });
  it("requires a real guard before issuing mutation SQL", async () => {
    const f = await setup();
    await f.guard.release();
    const count = f.queries.length;
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        run: async () => {},
        onSessionUncertain: f.poison,
      })
    ).rejects.toThrow();
    expect(f.queries).toHaveLength(count);
  });
  it("refuses a retained operation without replaying its callback", async () => {
    const f = await setup({ existing: true });
    const run = vi.fn(async () => {});
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        run,
        onSessionUncertain: f.poison,
      })
    ).rejects.toMatchObject({
      reason: "existing_operation_branch",
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("cleans domain failure only by resetting its owned branch before switching to main", async () => {
    const f = await setup();
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
          throw new Error("invalid citation");
        },
      })
    ).rejects.toThrow("invalid citation");
    const reset = f.queries.findIndex((q) => q.startsWith("SELECT dolt_reset"));
    expect(reset).toBeGreaterThan(0);
    expect(
      f.queries.indexOf("SELECT dolt_checkout('main')", reset)
    ).toBeGreaterThan(reset);
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_commit"))).toBe(
      false
    );
  });
  it("preserves query uncertainty even when the disposer throws", async () => {
    const f = await setup({ callbackSqlFails: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: async () => {
          throw new Error("disposer failed");
        },
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toBeInstanceOf(DoltBranchMutationUncertainError);
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_branch('-D'"))).toBe(
      false
    );
  });
  it("classifies a lost merge acknowledgement by exact ancestry", async () => {
    const f = await setup({ lostMergeAck: true });
    expect(
      (
        await runDoltBranchMutation(f.connection, {
          guard: f.guard,
          operationId: "x",
          message: "x",
          onSessionUncertain: f.poison,
          run: async (sql) => {
            await sql.unsafe("INSERT domain row");
          },
        })
      ).commitHash
    ).toBe(HASH);
  });
  it("preserves committed success when branch cleanup acknowledgement fails", async () => {
    const f = await setup({ cleanupFails: true });
    const result = await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "x",
      message: "x",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        await sql.unsafe("INSERT domain row");
      },
    });
    expect(result.cleanupUncertain).toBe(true);
    expect(result.commitHash).toBe(HASH);
    expect(f.poison).toHaveBeenCalledOnce();
  });
  it("rejects escaped SQL after scope closure", async () => {
    const f = await setup();
    let escaped!: DoltWriterConnection;
    await runDoltBranchMutation(f.connection, {
      guard: f.guard,
      operationId: "x",
      message: "x",
      onSessionUncertain: f.poison,
      run: async (sql) => {
        escaped = sql;
      },
    });
    const count = f.queries.length;
    await expect(escaped.unsafe("INSERT domain row")).rejects.toThrow(
      "scope has closed"
    );
    expect(f.queries).toHaveLength(count);
  });
  it("never treats a malformed merge receipt as success", async () => {
    const f = await setup({ malformedMerge: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          await sql.unsafe("INSERT domain row");
        },
      })
    ).rejects.toMatchObject({
      reason: "merge_result_invalid",
      retryable: false,
    });
  });
  it("never commits after the callback swallowed a database rejection", async () => {
    const f = await setup({ callbackSqlFails: true });
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run: async (sql) => {
          try {
            await sql.unsafe("INSERT domain row");
          } catch {
            /* application swallowed it */
          }
        },
      })
    ).rejects.toMatchObject({ retryable: false });
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_commit"))).toBe(
      false
    );
    expect(f.queries.some((q) => q.startsWith("SELECT dolt_reset"))).toBe(
      false
    );
    expect(f.poison).toHaveBeenCalledOnce();
  });
  it("never resets while an unawaited query is pending when the callback throws", async () => {
    const f = await setup();
    const previous = f.connection.unsafe.bind(f.connection);
    let finish!: (rows: readonly Record<string, unknown>[]) => void;
    const pending = new Promise<readonly Record<string, unknown>[]>(
      (resolve) => {
        finish = resolve;
      }
    );
    f.connection.unsafe = (query) =>
      query === "INSERT deferred" ? pending : previous(query);
    try {
      await expect(
        runDoltBranchMutation(f.connection, {
          guard: f.guard,
          operationId: "x",
          message: "x",
          onSessionUncertain: f.poison,
          run: async (sql) => {
            void sql.unsafe("INSERT deferred");
            throw new Error("domain rejection");
          },
        })
      ).rejects.toMatchObject({ retryable: false });
      expect(f.queries.some((q) => q.startsWith("SELECT dolt_reset"))).toBe(
        false
      );
      expect(
        f.queries.some((q) => q.startsWith("SELECT dolt_branch('-D'"))
      ).toBe(false);
      expect(f.poison).toHaveBeenCalledOnce();
    } finally {
      finish([]);
    }
  });
  it("never checks out main over a dirty current working set", async () => {
    const f = await setup();
    const previous = f.connection.unsafe.bind(f.connection);
    f.connection.unsafe = (query) =>
      query === "SELECT * FROM dolt.status"
        ? Promise.resolve([{ table_name: "foreign_dirty" }])
        : previous(query);
    const run = vi.fn(async () => {});
    await expect(
      runDoltBranchMutation(f.connection, {
        guard: f.guard,
        operationId: "x",
        message: "x",
        onSessionUncertain: f.poison,
        run,
      })
    ).rejects.toMatchObject({
      reason: "current_working_set_is_dirty",
      retryable: false,
    });
    expect(f.queries).not.toContain("SELECT dolt_checkout('main')");
    expect(run).not.toHaveBeenCalled();
    expect(f.poison).toHaveBeenCalledOnce();
  });
});
