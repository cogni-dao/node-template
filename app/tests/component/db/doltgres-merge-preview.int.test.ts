// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/doltgres-merge-preview`
 * Purpose: Prove native conflict checks, fresh metadata and retained session ownership on the qualified engine.
 * Scope: Ephemeral minimal Dolt schema, real adapter/executor and clean packed-consumer proof. No production or mocked database.
 * Invariants: Hidden fields can conflict; clean checks change no refs; timeout never replaces native capacity.
 * Side-effects: IO (Docker, ephemeral schema/native SQL, packed peers and isolated npm install), time (timers)
 * Links: https://cognidao.org/work/items/spike.5016
 * @internal
 */
import {
  buildDoltgresClient,
  DoltBranchSessionRunner,
  DoltgresKnowledgeContributionAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import { KnowledgeBusyError } from "@cogni/knowledge-store";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres, { type Sql } from "postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Same immutable custom engine as runtime Compose and doltgres-migrate tests.
const IMAGE =
  "ghcr.io/cogni-dao/cogni-template@sha256:f892b365ad6fc6c683da839260f20c4015615c105176a3c21c015ca90d2b70a3";
const exec = promisify(execFile);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const hash = (v: unknown) => {
  const h = Array.isArray(v) ? v[0] : v;
  if (typeof h !== "string" || !/^[0-9a-v]{32}$/.test(h))
    throw new Error("unproven native hash");
  return h;
};
async function commit(sql: Sql, message: string) {
  await sql.unsafe("SELECT dolt_add('-A')");
  await sql.unsafe(
    `SELECT dolt_commit('-m', ${literal(message)}, '--author', 'Preview test <preview@test.invalid>')`
  );
  return hash((await sql.unsafe("SELECT dolt_hashof('HEAD') AS h"))[0]?.h);
}

describe("qualified native contribution preview", () => {
  let container: StartedTestContainer;
  let setup: Sql;
  let reader: Sql;
  let branch: Sql;
  let writer: DoltBranchSessionRunner;
  let adapter: DoltgresKnowledgeContributionAdapter;
  const conflictId = "contrib-preview-conflict";
  const cleanId = "contrib-preview-clean";
  let cleanHead: string;
  let databaseUrl: string;

  async function addContribution(id: string, edit: string) {
    const base = hash(
      (await setup.unsafe("SELECT dolt_hashof('main') AS h"))[0]?.h
    );
    const ref = `contrib/${id}`;
    await setup.unsafe(
      `INSERT INTO knowledge_contributions (id,branch,base_commit,head_commit,commit_count,state,principal_kind,principal_id,message,created_at) VALUES (${literal(id)},${literal(ref)},${literal(base)},NULL,0,'open','agent','preview-test','preview',now())`
    );
    await commit(setup, `register ${id}`);
    await setup.unsafe(`SELECT dolt_checkout('-b', ${literal(ref)}, 'main')`);
    await setup.unsafe(edit);
    const head = await commit(setup, `edit ${id}`);
    await setup.unsafe("SELECT dolt_checkout('main')");
    await setup.unsafe(
      `UPDATE knowledge_contributions SET head_commit=${literal(head)},commit_count=1 WHERE id=${literal(id)}`
    );
    await commit(setup, `record ${id}`);
    return head;
  }

  async function refsAndState() {
    return {
      refs: await setup.unsafe(
        "SELECT name, hash FROM dolt.branches ORDER BY name"
      ),
      status: await setup.unsafe("SELECT * FROM dolt.status"),
      merging: await setup.unsafe("SELECT is_merging FROM dolt.merge_status"),
    };
  }

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ DOLTGRES_PASSWORD: "preview-test" })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
          90_000
        )
      )
      .start();
    const origin = `postgresql://postgres:preview-test@${container.getHost()}:${container.getMappedPort(5432)}`;
    const admin = postgres(`${origin}/postgres`, {
      max: 1,
      prepare: false,
      fetch_types: false,
    });
    await admin.unsafe("CREATE DATABASE knowledge_preview");
    await admin.end();
    const url = `${origin}/knowledge_preview`;
    databaseUrl = url;
    setup = buildDoltgresClient({ connectionString: url, max: 1 });
    await setup.unsafe(
      "CREATE TABLE knowledge (id TEXT PRIMARY KEY,title TEXT,content TEXT,confidence_pct INTEGER)"
    );
    await setup.unsafe(
      "CREATE TABLE knowledge_contributions (id TEXT PRIMARY KEY,branch TEXT,base_commit TEXT,head_commit TEXT,commit_count INTEGER,state TEXT,principal_kind TEXT,principal_id TEXT,message TEXT,merged_commit TEXT,closed_reason TEXT,idempotency_key TEXT,created_at TIMESTAMP,resolved_at TIMESTAMP,resolved_by TEXT)"
    );
    await setup.unsafe(
      "INSERT INTO knowledge VALUES ('same-cell','Visible title','Visible body',60)"
    );
    await commit(setup, "initial fixture");
    await addContribution(
      conflictId,
      "UPDATE knowledge SET confidence_pct=70 WHERE id='same-cell'"
    );
    await setup.unsafe(
      "UPDATE knowledge SET confidence_pct=80 WHERE id='same-cell'"
    );
    await commit(setup, "main changes hidden confidence field");
    cleanHead = await addContribution(
      cleanId,
      "INSERT INTO knowledge VALUES ('incoming-only','Independent','Incoming body',60)"
    );
    await setup.unsafe(
      "INSERT INTO knowledge VALUES ('main-only','Independent','Main body',60)"
    );
    await commit(setup, "independent main change");
    reader = buildDoltgresClient({ connectionString: url, max: 1 });
    branch = buildDoltgresClient({ connectionString: url, max: 1 });
    writer = new DoltBranchSessionRunner(branch, {
      writerProtocol: "database",
      queryTimeoutMs: 1000,
      queueWaitMs: 2000,
    });
    adapter = new DoltgresKnowledgeContributionAdapter({
      sql: reader,
      writerSession: writer,
    });
  }, 180_000);

  afterAll(async () => {
    await reader?.end({ timeout: 5 });
    await branch?.end({ timeout: 5 });
    await setup?.end({ timeout: 5 });
    await container?.stop();
  });

  it("detects a real hidden-field conflict without mutating refs or working state", async () => {
    const before = await refsAndState();
    const result = await adapter.previewMerge(conflictId);
    expect(result.status).toBe("conflicted");
    // Doltgres keeps the PostgreSQL schema in TableName.String(); the native
    // summary returns public.knowledge rather than an unqualified table name.
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "public.knowledge",
          dataConflicts: "1",
        }),
      ])
    );
    expect(await refsAndState()).toEqual(before);
  });

  it("passes an independent real change using immutable commit arguments", async () => {
    const before = await refsAndState();
    expect(await adapter.previewMerge(cleanId)).toMatchObject({
      status: "clean",
      contributionCommit: cleanHead,
      conflicts: [],
    });
    expect(await refsAndState()).toEqual(before);
  });

  it("loads real packed peers and executes the installed domain adapter without source aliases", async () => {
    const consumer = await mkdtemp(
      path.join(tmpdir(), "knowledge-preview-consumer-")
    );
    try {
      // CI builds these exact sources before this existing native lane. Pack
      // genuine peers, including private ai-core, rather than fabricate types.
      const assets: Record<string, string> = {};
      for (const [name, directory] of [
        ["@cogni/ai-core", "ai-core"],
        ["@cogni/ai-tools", "ai-tools"],
        ["@cogni-dao/knowledge-store", "knowledge-store"],
      ] as const) {
        const packed = await exec(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            consumer,
          ],
          {
            cwd: path.join(ROOT, "packages", directory),
            timeout: 30_000,
          }
        );
        const filename = JSON.parse(packed.stdout)[0].filename as string;
        const asset = path.join(consumer, filename);
        assets[name] = `file:${asset}`;
        console.info("installed preview artifact", {
          name,
          sha256: createHash("sha256")
            .update(await readFile(asset))
            .digest("hex"),
        });
      }
      const source = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT })
      ).stdout.trim();
      console.info("installed preview source", { source, nativeImage: IMAGE });
      await writeFile(
        path.join(consumer, "package.json"),
        JSON.stringify({
          name: "native-preview-installed-proof",
          private: true,
          type: "module",
          dependencies: { ...assets, typescript: "^5", "@types/node": "^22" },
        })
      );
      await exec(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
        ],
        {
          cwd: consumer,
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      await writeFile(
        path.join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: false,
            noEmit: true,
            types: ["node"],
          },
          include: ["bridge.ts"],
        })
      );
      await writeFile(
        path.join(consumer, "bridge.ts"),
        `
import { buildDoltgresClient, DoltBranchSessionRunner, DoltgresKnowledgeContributionAdapter,
  type DoltgresKnowledgeContributionAdapterConfig } from '@cogni-dao/knowledge-store/adapters/doltgres';
import { ContributionMergePreviewSchema, unavailableContributionMergePreview } from '@cogni-dao/knowledge-store';
const sql = buildDoltgresClient({ connectionString: 'postgresql://test@localhost/test' });
const branch = buildDoltgresClient({ connectionString: 'postgresql://test@localhost/test', max: 1 });
const writer = new DoltBranchSessionRunner(branch);
const config: DoltgresKnowledgeContributionAdapterConfig = { sql, writerSession: writer };
const capability: Pick<DoltgresKnowledgeContributionAdapter, 'previewMerge'> = new DoltgresKnowledgeContributionAdapter(config);
void capability; ContributionMergePreviewSchema.parse(unavailableContributionMergePreview('contrib-proof'));
`
      );
      // The real unwrapped class is assigned to the actual installed public
      // constructor, without casts, generated interfaces or skipLibCheck.
      await exec(
        process.execPath,
        [
          path.join(consumer, "node_modules/typescript/bin/tsc"),
          "-p",
          consumer,
        ],
        {
          cwd: consumer,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      const installed = path.join(
        consumer,
        "node_modules/@cogni-dao/knowledge-store"
      );
      expect(await realpath(installed)).toBe(installed);
      await writeFile(
        path.join(consumer, "proof.mjs"),
        `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDoltgresClient, DoltBranchSessionRunner, DoltgresKnowledgeContributionAdapter } from '@cogni-dao/knowledge-store/adapters/doltgres';
const manifest = JSON.parse(readFileSync('./node_modules/@cogni-dao/knowledge-store/package.json', 'utf8'));
assert.equal(manifest.dependencies?.['@cogni-dao/doltgres-admission'], undefined);
for (const subpath of Object.keys(manifest.exports)) {
  const name = '@cogni-dao/knowledge-store' + (subpath === '.' ? '' : subpath.slice(1));
  const resolved = fileURLToPath(import.meta.resolve(name));
  assert.ok(realpathSync(resolved).startsWith(process.cwd() + '/node_modules/@cogni-dao/knowledge-store/'));
  await import(name); console.log('installed export', name, resolved);
}
const reader = buildDoltgresClient({ connectionString: process.env.PREVIEW_DATABASE, max: 1 });
const pool = buildDoltgresClient({ connectionString: process.env.PREVIEW_DATABASE, max: 1 });
const owner = new DoltBranchSessionRunner(pool, { writerProtocol: 'database' });
// This is the actual public runner, not a hand-built writer interface.
const adapter = new DoltgresKnowledgeContributionAdapter({ sql: reader, writerSession: owner });
try {
  assert.equal((await adapter.previewMerge('contrib-preview-conflict')).status, 'conflicted');
  assert.equal((await adapter.previewMerge('contrib-preview-clean')).status, 'clean');
  assert.equal(owner.client, pool);
  console.log('installed native preview clean/conflicted and same owner PASS');
} finally { await reader.end({ timeout: 5 }); await pool.end({ timeout: 5 }); }
`
      );
      const before = await refsAndState();
      const result = await exec(
        process.execPath,
        [path.join(consumer, "proof.mjs")],
        {
          cwd: consumer,
          timeout: 30_000,
          env: { ...process.env, PREVIEW_DATABASE: databaseUrl },
        }
      );
      expect(result.stdout).toContain("same owner PASS");
      console.info(result.stdout);
      expect(await refsAndState()).toEqual(before);
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  }, 180_000);

  it("retains a late native query, serves ordinary reads, then admits a queued mutation", async () => {
    // This real server function does not honor PostgreSQL cancellation. Its
    // running query outlives the caller's1s budget on the SAME native owner.
    let heldKeys: readonly string[] = [];
    const originalRun = writer.run.bind(writer);
    let injected = false;
    // Test instrumentation preserves THIS actual writer object and owner.
    // Every query/result is native; only a real server sleep is inserted before
    // the summary to deterministically exceed the query deadline.
    writer.run = async (operation, fn, options) =>
      originalRun(
        operation,
        async (conn, guard, owner) => {
          heldKeys = guard.keys;
          return fn(
            {
              unsafe: async (query) => {
                if (
                  !injected &&
                  query.includes("dolt_preview_merge_conflicts_summary")
                ) {
                  injected = true;
                  await conn.unsafe("SELECT pg_sleep(2)");
                }
                return conn.unsafe(query);
              },
            },
            guard,
            owner
          );
        },
        options
      );
    const preview = adapter.previewMerge(cleanId);
    // Observe native ownership while the actual public preview is pending.
    const started = Date.now() + 3000;
    while (
      !(
        await setup.unsafe(
          "SELECT query,state FROM pg_catalog.pg_stat_activity"
        )
      ).some(
        (row) =>
          String(row.query).includes("pg_sleep(2)") && row.state === "active"
      )
    ) {
      if (Date.now() > started)
        throw new Error("actual preview delay never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(injected).toBe(true);
    expect(writer.client).toBe(branch);
    expect(
      (await reader.unsafe("SELECT COUNT(*) AS n FROM knowledge"))[0]
    ).toBeDefined();
    let queuedSettled = false;
    const queued = adapter
      .close({
        contributionId: conflictId,
        principal: { id: "preview-test", kind: "agent" },
        reason: "queued during delayed preview",
      })
      .then(
        () => ({ ok: true as const }),
        (error) => ({ ok: false as const, error })
      )
      .finally(() => {
        queuedSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queuedSettled).toBe(false);
    expect(heldKeys.length).toBeGreaterThan(0);
    const assertHeld = async () => {
      for (const key of heldKeys) {
        expect(key).toMatch(/^-?[0-9]+$/);
        expect(
          (
            await setup.unsafe(
              `SELECT pg_try_advisory_lock(${key}) AS acquired`
            )
          )[0]?.acquired
        ).toBe(false);
      }
    };
    await assertHeld();
    const readStartedAt = performance.now();
    expect(
      (await reader.unsafe("SELECT COUNT(*) AS n FROM knowledge"))[0]
    ).toBeDefined();
    expect(performance.now() - readStartedAt).toBeLessThan(400);
    const result = await preview;
    writer.run = originalRun;
    expect(result.status).toBe("unavailable");
    const stillActive = (
      await setup.unsafe("SELECT query,state FROM pg_catalog.pg_stat_activity")
    ).filter(
      (row) =>
        String(row.query).includes("pg_sleep(2)") && row.state === "active"
    );
    if (stillActive.length) {
      expect(stillActive).toHaveLength(1);
      await assertHeld();
      expect((await adapter.previewMerge(cleanId)).status).toBe("unavailable");
      expect(
        (await reader.unsafe("SELECT COUNT(*) AS n FROM knowledge"))[0]
      ).toBeDefined();
    }
    expect(writer.client).toBe(branch);
    // Polling the product operation is bounded; unavailable retains capacity.
    const deadline = Date.now() + 5000;
    let status = "unavailable";
    while (Date.now() < deadline && status === "unavailable") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (await adapter.previewMerge(cleanId)).status;
    }
    expect(status).toBe("clean");
    const queuedResult = await queued;
    expect(queuedResult.ok).toBe(false);
    if (!queuedResult.ok)
      expect(queuedResult.error).toBeInstanceOf(KnowledgeBusyError);
    await setup.unsafe("SELECT dolt_checkout('main')");
    expect(
      (
        await setup.unsafe(
          `SELECT state FROM knowledge_contributions WHERE id=${literal(conflictId)}`
        )
      )[0]?.state
    ).toBe("open");
    expect(result.status).toBe("unavailable"); // Never upgraded after late settlement.
    for (const key of heldKeys) {
      expect(
        (
          await setup.unsafe(`SELECT pg_try_advisory_lock(${key}) AS acquired`)
        )[0]?.acquired
      ).toBe(true);
      await setup.unsafe(`SELECT pg_advisory_unlock(${key})`);
    }
    // Hold a known, non-timed-out native read on that same owner; start an
    // actual contribution mutation while it owns the session and native lock.
    const barrier = writer.run(
      "test.queued_after_preview",
      async (conn, _guard, owner) => {
        owner.registerReconciliation(
          async () => !(await conn.unsafe("SELECT * FROM dolt.status")).length
        );
        await conn.unsafe("SELECT pg_sleep(0.5)");
      },
      { awaitSettlement: true }
    );
    const startedDeadline = Date.now() + 3000;
    while (
      !(
        await setup.unsafe(
          "SELECT query,state FROM pg_catalog.pg_stat_activity"
        )
      ).some(
        (r) => String(r.query).includes("pg_sleep(0.5)") && r.state === "active"
      )
    ) {
      if (Date.now() > startedDeadline)
        throw new Error("queued-read fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let mutationSettled = false;
    const mutation = adapter
      .close({
        contributionId: conflictId,
        principal: { id: "preview-test", kind: "agent" },
        reason: "native fixture cleanup",
      })
      .finally(() => {
        mutationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationSettled).toBe(false);
    await barrier;
    await mutation;
    await setup.unsafe("SELECT dolt_checkout('main')");
    expect(
      (
        await setup.unsafe(
          `SELECT state FROM knowledge_contributions WHERE id=${literal(conflictId)}`
        )
      )[0]?.state
    ).toBe("closed");
  });

  it("refreshes a warmed native session after another connection closes the inbox", async () => {
    expect((await adapter.previewMerge(cleanId)).status).toBe("clean");
    await setup.unsafe(
      `UPDATE knowledge_contributions SET state='closed' WHERE id=${literal(cleanId)}`
    );
    await commit(setup, "another connection closes contribution");
    expect(await adapter.previewMerge(cleanId)).toMatchObject({
      status: "changed",
      reason: "not_open",
    });
  });

  it("never repairs dirty main to manufacture a clean native result", async () => {
    const dirtyPool = buildDoltgresClient({
      connectionString: databaseUrl,
      max: 1,
    });
    const dirtyWriter = new DoltBranchSessionRunner(dirtyPool, {
      writerProtocol: "database",
    });
    const diagnostic = new DoltgresKnowledgeContributionAdapter({
      sql: reader,
      writerSession: dirtyWriter,
    });
    await setup.unsafe(
      "UPDATE knowledge SET title='uncommitted fixture' WHERE id='same-cell'"
    );
    const before = await refsAndState();
    expect(before.status.length).toBeGreaterThan(0);
    try {
      expect((await diagnostic.previewMerge(cleanId)).status).toBe(
        "unavailable"
      );
      expect(await refsAndState()).toEqual(before);
    } finally {
      // Fixture-only cleanup after the diagnostic refused; product code never
      // invokes reset or claims ownership of the foreign dirty state.
      await setup.unsafe("SELECT dolt_reset('--hard')");
      await dirtyPool.end({ timeout: 5 });
    }
  });
});
