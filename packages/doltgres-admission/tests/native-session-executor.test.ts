// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** The executor and branch helper must share the installed module's opaque guard realm. */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  DoltNativeSessionExecutor,
  runDoltBranchMutation,
  type DoltWriterConnection,
} from "../src/index.js";

const HASH = "a".repeat(32);
const BASE = "b".repeat(32);
function engine(
  overrides: {
    lostMergeAck?: boolean;
    cleanupFails?: boolean;
    callbackSqlFails?: boolean;
    existing?: boolean;
    malformedMerge?: boolean;
    commitFails?: boolean;
    targetDirty?: boolean;
  } = {}
) {
  let active = "main";
  let dirty = false;
  let head = BASE;
  let mergeRows: Record<string, unknown>[] = [{ is_merging: false }];
  let conflicts: Record<string, unknown>[] = [];
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
      if (query.startsWith("SELECT dolt_checkout('contrib/")) {
        active = query.split("'")[1] ?? "";
        if (overrides.targetDirty) dirty = true;
        return [{ dolt_checkout: 0 }];
      }
      if (query.includes("active_branch()")) return [{ branch_name: active }];
      if (query === "SELECT is_merging FROM dolt.merge_status")
        return mergeRows;
      if (query === "SELECT * FROM dolt.conflicts") return conflicts;
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
        if (overrides.commitFails) throw new Error("terminal commit failed");
        dirty = false;
        head = HASH;
        return [{ dolt_commit: [HASH] }];
      }
      if (query.startsWith("SELECT dolt_hashof"))
        return [{ commit_hash: query.includes("'HEAD'") ? head : HASH }];
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
  return {
    connection,
    queries,
    setActive: (value: string) => {
      active = value;
    },
    setHead: (value: string) => {
      head = value;
    },
    setDirty: (value: boolean) => {
      dirty = value;
    },
    setMerge: (value: Record<string, unknown>[]) => {
      mergeRows = value;
    },
    setConflicts: (value: Record<string, unknown>[]) => {
      conflicts = value;
    },
  };
}

const errors = {
  busy: (message: string) => new Error(message),
  outcomeUnknown: (id: string) => new Error(`Uncertain ${id}`),
  fault: (message: string) => new Error(message),
};
function session() {
  const f = engine();
  const release = vi.fn();
  const pool = {
    unsafe: async () => [],
    reserve: async () => ({ ...f.connection, release }),
  };
  return {
    ...f,
    release,
    executor: new DoltNativeSessionExecutor(pool, { errors }),
  };
}

describe("native executor module identity", () => {
  it("passes its real guarded session to the helper exported by the same index", async () => {
    const f = session();
    const value = await f.executor.run(
      "identity.same",
      async (connection, guard, owner) => {
        const result = await runDoltBranchMutation(connection, {
          guard,
          operationId: "identity.same",
          message: "same module graph",
          onSessionUncertain: (error) => f.executor.retire(connection, error),
          onReconcile: owner.registerReconciliation,
          onCommitted: owner.committed,
          run: async (sql) => {
            await sql.unsafe("INSERT domain row");
            return "committed";
          },
        });
        return result.value;
      }
    );
    expect(value).toBe("committed");
    // Public success may precede the private native ref cleanup.
    await expect.poll(() => f.release.mock.calls.length).toBe(1);
    expect(
      f.queries.filter((query) => query === "INSERT domain row")
    ).toHaveLength(1);
    expect(
      f.queries.some((query) => query.startsWith("SELECT dolt_branch('-D'"))
    ).toBe(true);
  });

  it("rejects a guard from a physically separate complete helper module graph before DML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dolt-admission-realm-"));
    try {
      const source = fileURLToPath(new URL("../src/", import.meta.url));
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      for (const file of await readdir(source)) {
        if (!file.endsWith(".ts")) continue;
        const input = await readFile(join(source, file), "utf8");
        const output = ts.transpileModule(input, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText;
        await writeFile(join(directory, file.replace(/\.ts$/, ".js")), output);
      }
      const foreign = await import(
        /* @vite-ignore */ pathToFileURL(join(directory, "index.js")).href
      );
      const f = session();
      const run = vi.fn(async () => "must not run");
      await f.executor.run("identity.foreign", async (connection, guard) => {
        const before = f.queries.length;
        await expect(
          foreign.runDoltBranchMutation(connection, {
            guard,
            operationId: "identity.foreign",
            message: "foreign graph",
            onSessionUncertain: vi.fn(async () => {}),
            run,
          })
        ).rejects.toMatchObject({ reason: "guard_invalid" });
        expect(f.queries).toHaveLength(before);
      });
      expect(run).not.toHaveBeenCalled();
      await expect.poll(() => f.release.mock.calls.length).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
