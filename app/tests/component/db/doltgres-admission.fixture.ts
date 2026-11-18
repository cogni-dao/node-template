// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Shared fixture for the doltgres-admission*.int.test.ts files: a migration-CLI sandbox against a
 * live Doltgres 0.57.3 origin, and the late-DML scenario that waits on the CLI's real deadline.
 * The two boundaries run in separate files (one container each) so the lane runs them in
 * parallel (task.0138).
 */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres, { type Sql } from "postgres";
import { expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function cliFixture(origin: string, database: string, nodeName = database.replace(/^knowledge_/, "").replaceAll("_", "-")) {
  const folder = await mkdtemp(path.join(tmpdir(), "doltgres-cli-"));
  await mkdir(path.join(folder, "meta"));
  const entry = (idx: number) => ({ idx, version: "7", when: idx + 1, tag: `000${idx}_probe`, breakpoints: true });
  const table = (name: string) => ({ name, columns: { id: { name: "id", type: "integer", notNull: true } }, indexes: {} });
  const writeJournal = async (pending: boolean) => {
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: pending ? [entry(0), entry(1)] : [entry(0)] }));
    await writeFile(path.join(folder, "0000_probe.sql"), "CREATE TABLE migration_probe (id integer NOT NULL);");
    await writeFile(path.join(folder, "meta/0000_snapshot.json"), JSON.stringify({ tables: { "public.migration_probe": table("migration_probe") } }));
    if (pending) {
      await writeFile(path.join(folder, "0001_probe.sql"), "CREATE TABLE migration_once (id integer NOT NULL);");
      await writeFile(path.join(folder, "meta/0001_snapshot.json"), JSON.stringify({ tables: { "public.migration_probe": table("migration_probe"), "public.migration_once": table("migration_once") } }));
    }
  };
  await writeJournal(false);
  const admin = postgres(`${origin}/postgres`, { max: 1, fetch_types: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = `${origin}/${database}`;
  const root = path.resolve(HERE, "../../../..");
  const migrate = async (timeout = 30_000, databaseUrl = url) => {
    try {
      const result = await promisify(execFile)(process.execPath, [path.join(root, "scripts/db/migrate-doltgres.mjs"), folder], {
        cwd: root, env: { ...process.env, NODE_NAME: nodeName, DATABASE_URL: databaseUrl }, timeout,
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { code: result.code, output: result.stdout + result.stderr };
    }
  };
  expect((await migrate()).code).toBe(0);
  return { admin, url, root, folder, database, migrate, writeJournal, async close() { await admin.end({ timeout: 1 }); await rm(folder, { recursive: true, force: true }); } };
}

/** The late-DML scenario for one boundary: the CLI is killed or hits its public deadline while native DML is still running. */
export async function assertCliKeepsGuardThroughLateDml(origin: string, boundary: "SIGKILL" | "public deadline") {
  const database = boundary === "SIGKILL" ? "knowledge_cli_pending" : "knowledge_cli_deadline";
  const fixture = await cliFixture(origin, database);
  const sleepSeconds = boundary === "SIGKILL" ? 15 : 45;
  const probe = `migration_cli_${database}`;
  let child: ReturnType<typeof spawn> | undefined;
  let observer: Sql | undefined;
  try {
    await fixture.writeJournal(true);
    await writeFile(path.join(fixture.folder, "0001_probe.sql"), `CREATE TABLE migration_once (id integer NOT NULL);
--> statement-breakpoint
INSERT INTO migration_once SELECT 7 WHERE pg_sleep(${sleepSeconds}) IS NULL /* ${probe} */;`);
    child = spawn(process.execPath, [path.join(fixture.root, "scripts/db/migrate-doltgres.mjs"), fixture.folder], {
      cwd: fixture.root, env: { ...process.env, NODE_NAME: database.replace(/^knowledge_/, "").replaceAll("_", "-"), DATABASE_URL: fixture.url }, stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stdout?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { diagnostics += data.toString(); });
    const cli = child;
    let pid = 0;
    let observed: unknown[] = [];
    try { await expect.poll(async () => {
      if (cli.exitCode !== null || cli.signalCode !== null)
        throw new Error(`CLI exited before native delayed SQL: code=${cli.exitCode} signal=${cli.signalCode} ${diagnostics}`);
      const rows = await fixture.admin.unsafe("SELECT pid,datname,state,query FROM pg_catalog.pg_stat_activity");
      observed = rows.slice(0, 40).map(({ pid, datname, state, query }) => ({ pid, datname, state, query: String(query).slice(0, 240) }));
      // Native 0.57.3 reports datname=NULL even during branch SQL. Bind
      // this exact child to its unique fixture query, never infer a DB name.
      const active = rows.filter((row) => row.state === "active" && String(row.query).includes(probe) && String(row.query).includes(`pg_sleep(${sleepSeconds})`));
      if (active.length > 1) throw new Error("duplicate native CLI probe sessions");
      pid = Number(active[0]?.pid ?? 0);
      return pid > 0;
    }, { timeout: 10_000 }).toBe(true);
    } catch (cause) {
      throw new Error(`Native CLI observation failed: exit=${cli.exitCode} signal=${cli.signalCode} output=${diagnostics} census=${JSON.stringify(observed)}`, { cause });
    }
    const census = () => fixture.admin.unsafe(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`);
    const exited = once(child, "exit", { signal: AbortSignal.timeout(40_000) });
    if (boundary === "SIGKILL") child.kill("SIGKILL");
    const [exitCode, signal] = await exited;
    let terminal: { code: string; retryable: boolean; operationId: string; branch: string; commitHash: null } | undefined;
    if (boundary === "public deadline") {
      expect(exitCode).toBe(1);
      expect(signal).toBeNull();
      const line = diagnostics.split("\n").find((value) => value.startsWith("MIGRATION_OUTCOME "));
      expect(line).toBeDefined();
      terminal = JSON.parse(String(line).slice("MIGRATION_OUTCOME ".length));
      expect(terminal).toMatchObject({ code: "migration_write_outcome_unknown", retryable: false, commitHash: null });
      expect(terminal?.operationId).toMatch(new RegExp(`^migration[.]${database}[.][a-f0-9]{64}$`));
    } else expect(signal).toBe("SIGKILL");
    expect(await census()).toHaveLength(1);
    const refused = await fixture.migrate();
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("migration_writer_busy");
    expect(await census()).toHaveLength(1);
    await expect.poll(async () => (await fixture.admin.unsafe(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid}`)).length, { timeout: 25_000 }).toBe(0);
    observer = postgres(fixture.url, { max: 1, fetch_types: false });
    const mainHead = await observer.unsafe("SELECT dolt_hashof('main') AS head");
    expect(await observer.unsafe("SELECT COUNT(*)::integer AS count FROM drizzle.__drizzle_migrations")).toEqual([{ count: 1 }]);
    const branches = await observer.unsafe("SELECT name FROM dolt.branches WHERE name LIKE 'dolt-op/%'");
    expect(branches).toHaveLength(1);
    const branch = String(branches[0]?.name);
    if (terminal) expect(terminal.branch).toBe(branch);
    await observer.unsafe(`SELECT dolt_checkout('${branch}')`);
    expect(await observer.unsafe("SELECT id FROM migration_once")).toEqual([{ id: 7 }]);
    const operationHead = await observer.unsafe("SELECT dolt_hashof('HEAD') AS head");
    // Keep this branch's working set intact. A new process must refuse the
    // existing batch receipt before dispatching the original DML again.
    // Close this branch-scoped observer without checkout, reset or merge.
    await observer.end({ timeout: 1 }); observer = undefined;
    const retry = await fixture.migrate(5_000);
    expect(retry.code).not.toBe(0);
    expect(retry.output).toContain("existing_operation_branch");
    observer = postgres(fixture.url, { max: 1, fetch_types: false });
    expect(await observer.unsafe("SELECT dolt_hashof('main') AS head")).toEqual(mainHead);
    await observer.unsafe(`SELECT dolt_checkout('${branch}')`);
    expect(await observer.unsafe("SELECT dolt_hashof('HEAD') AS head")).toEqual(operationHead);
    expect(await observer.unsafe("SELECT id FROM migration_once")).toEqual([{ id: 7 }]);
  } finally {
    child?.kill("SIGKILL");
    await observer?.end({ timeout: 1 });
    await fixture.close();
  }
}
