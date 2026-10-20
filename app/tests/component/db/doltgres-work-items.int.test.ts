// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 acceptance for the deployed work-item mutation flow.
 *
 * node-template owns `@cogni/work-items`' Doltgres adapter, so the real-engine
 * proof belongs here rather than only in a fork (task.5199). Fake-SQL unit
 * tests cannot see Dolt branch semantics; bug.5358 shipped green against them.
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { toWorkItemId } from "@cogni/work-items";
import { acquireDoltWriterLocks } from "@cogni-dao/doltgres-admission";
import postgres, { type Sql } from "postgres";
import {
	DoltBranchSessionRunner,
	DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DoltgresWorkItemAdapter,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATE_SCRIPT = path.resolve(
	REPO_ROOT,
	"scripts/db/migrate-doltgres.mjs",
);
const MIGRATIONS_DIR = path.resolve(
	REPO_ROOT,
	"app/src/adapters/server/db/doltgres-migrations",
);
const DOLTGRES_IMAGE = "dolthub/doltgresql:0.57.3";
const DB_NAME = "knowledge_node_template_work_items";
const PASSWORD = "doltgres";

describe("Doltgres 0.57.3 work-item acceptance", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let dbUrl: string;
	const stageLogger = {
		info: (fields: unknown, message?: string) =>
			console.info(message, JSON.stringify(fields)),
		warn: (fields: unknown, message?: string) =>
			console.warn(message, JSON.stringify(fields)),
		error: (fields: unknown, message?: string) =>
			console.error(message, JSON.stringify(fields)),
	};

	beforeAll(async () => {
		container = await new GenericContainer(DOLTGRES_IMAGE)
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();

		const host = container.getHost();
		const port = container.getMappedPort(5432);
		const baseUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/postgres`;
		dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
		const bootstrap = postgres(baseUrl, { max: 1, fetch_types: false });
		try {
			await bootstrap.unsafe(`CREATE DATABASE ${DB_NAME}`);
		} finally {
			await bootstrap.end({ timeout: 5 });
		}

		execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				NODE_NAME: "node-template-work-items",
			},
			encoding: "utf8",
			stdio: "pipe",
		});
		sql = postgres(dbUrl, { max: 1, fetch_types: false });
	}, 180_000);

	afterAll(async () => {
		if (sql) await sql.end({ timeout: 5 });
		if (container) await container.stop();
	});

	it("creates, lists, patches, and retains versioned content through Dolt branches", async () => {
		const createWorkItemClient = () =>
			postgres(dbUrl, { max: 1, fetch_types: false });
		// An EXPLICIT read pool, so `recreateClient` below stays a pure
		// write-pool factory and `sql` keeps tracking the write pool — which the
		// pool-death scenario further down depends on. The 0.1.7 derivation path
		// (no readClient, pool built from recreateClient) is covered in the unit
		// lane; mixing it in here would mean `sql` sometimes pointed at the read
		// pool and the pool-death assertions would kill the wrong connection.
		const readSql = createWorkItemClient();
		const adapter = new DoltgresWorkItemAdapter(sql, {
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
			readClient: readSql,
			recreateReadClient: createWorkItemClient,
			recreateClient: () => {
				sql = createWorkItemClient();
				return sql;
			},
		});
		const id = toWorkItemId("task.9501");
		const principalId = "doltgres-acceptance-agent";
		const searchId = toWorkItemId("task.9500");

		await adapter.create(
			{
				id: searchId,
				type: "task",
				title: "Out-of-line text search",
				summary: `prefix ${"x".repeat(8_000)} panic-proof-needle`,
			},
			principalId,
		);
		await expect(
			adapter.list({ text: "PANIC-PROOF-NEEDLE" }),
		).resolves.toMatchObject({
			items: [expect.objectContaining({ id: searchId })],
		});

		const created = await adapter.create(
			{ id, type: "task", title: "Doltgres acceptance" },
			principalId,
		);
		expect(created.id).toBe(id);
		expect((await adapter.list({ ids: [id] })).items).toHaveLength(1);

		const patched = await adapter.patch(
			{ id, set: { title: "Doltgres accepted" } },
			principalId,
		);
		expect(patched.title).toBe("Doltgres accepted");

		// bug.5358's core guarantee, against a REAL held lock: a write holding
		// the global work-items lock must not take reads down with it. Before
		// 0.1.7 this same lock made `get` reject with WorkItemsBusyError, because
		// reads shared the write lane. The write lane still fails closed — the
		// `patch` below proves that on the same held lock.
		const blocker = createWorkItemClient();
		try {
			await blocker.unsafe("SELECT pg_advisory_lock(5001001)");
			await expect(adapter.get(id)).resolves.toMatchObject({ id });
			await expect(
				adapter.patch({ id, set: { title: "blocked" } }, principalId),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
		} finally {
			await blocker
				.unsafe("SELECT pg_advisory_unlock(5001001)")
				.catch(() => undefined);
			await blocker.end({ timeout: 0 });
		}

		// The common scope used by knowledge and work items must cover the
		// whole write, even while a different client holds a database-only guard.
		const scopedBlocker = createWorkItemClient();
		await scopedBlocker.unsafe("SELECT 1");
		const scopedSession = await scopedBlocker.reserve();
		const writerGuard = await acquireDoltWriterLocks(scopedSession, {
			protocol: "database",
		});
		try {
			await expect(adapter.get(id)).resolves.toMatchObject({ id });
			await expect(
				adapter.patch({ id, set: { title: "scoped blocked" } }, principalId),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
		} finally {
			await writerGuard.release();
			scopedSession.release();
			await scopedBlocker.end({ timeout: 0 });
		}

		const maintenance = createWorkItemClient();
		try {
			await maintenance.unsafe(
				"SELECT dolt_checkout('-b', 'work-item-op/acceptance-orphan', 'main')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");
		} finally {
			await maintenance.end({ timeout: 0 });
		}

		const oldPool = sql;
		const lockHolder = createWorkItemClient();
		try {
			await lockHolder.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedQuery = oldPool.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedResult = blockedQuery.then(
				() => undefined,
				(error) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			// A WRITE, not a read: the write pool is the only pool a write uses,
			// so it is the only operation that can observe that pool dying and
			// then prove `recreateClient` rebuilt it. Before 0.1.7 a read shared
			// that pool and stood in for this; it no longer does, and a read
			// standing in would now assert nothing.
			const recoveryAttempt = adapter.patch(
				{ id, set: { title: "pool death" } },
				principalId,
			);
			const destroyTimer = setTimeout(() => {
				void oldPool.end({ timeout: 0 });
			}, 100);
			await expect(blockedResult).resolves.toBeInstanceOf(Error);
			await expect(recoveryAttempt).rejects.toBeInstanceOf(WorkItemsBusyError);
			clearTimeout(destroyTimer);
		} finally {
			await oldPool.end({ timeout: 0 });
			await lockHolder
				.unsafe("SELECT pg_advisory_unlock(9501002)")
				.catch(() => undefined);
			await lockHolder.end({ timeout: 0 });
		}

		// Reads kept serving throughout — including while the write pool was
		// dead, which is the bug.5358 guarantee.
		await expect(adapter.get(id)).resolves.toMatchObject({ id });
		// ...and the next WRITE both proves the pool was rebuilt and sweeps the
		// orphan branch. Sweeping is a branch mutation, so it belongs to the
		// write plane (COMMAND_QUERY_SEPARATION); a read used to do it here only
		// because a read used to take the write lock.
		await expect(
			adapter.patch({ id, set: { title: "Doltgres accepted" } }, principalId),
		).resolves.toMatchObject({ id, title: "Doltgres accepted" });
		const verifier = createWorkItemClient();
		try {
			await expect(
				verifier.unsafe(
					"SELECT name FROM dolt.branches WHERE name = 'work-item-op/acceptance-orphan'",
				),
			).resolves.toHaveLength(0);
		} finally {
			await verifier.end({ timeout: 0 });
		}

		await expect(adapter.delete(id, principalId)).rejects.toMatchObject({
			name: "WorkItemDeletionRetiredError",
		});
		await adapter.patch({ id, set: { status: "cancelled" } }, principalId);
		await adapter.patch(
			{ id: searchId, set: { status: "cancelled" } },
			principalId,
		);
		await expect(adapter.get(id)).resolves.toMatchObject({
			id,
			status: "cancelled",
		});
		await readSql.end({ timeout: 0 });
	}, 60_000);

	it("serves reads past an unprovable operation branch and quarantines it so writes recover", async () => {
		const branch = "work-item-op/component-unreachable";
		const maintenance = postgres(dbUrl, { max: 1, fetch_types: false });
		try {
			await maintenance.unsafe(
				`SELECT dolt_checkout('-b', '${branch}', 'main')`,
			);
			await maintenance.unsafe(
				"INSERT INTO work_items (id, type, title, status, node, created_by_principal_id) VALUES ('task.9599', 'task', 'Unreachable evidence', 'needs_implement', 'shared', 'component-agent')",
			);
			await maintenance.unsafe(
				"SELECT dolt_commit('-Am', 'component unreachable evidence')",
			);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			const adapter = new DoltgresWorkItemAdapter(sql, {
				recreateReadClient: () =>
					postgres(dbUrl, { max: 2, fetch_types: false }),
				logger: stageLogger,
				lockWaitMs: 250,
				lockRetryMs: 25,
			});
			// bug.5358: an unprovable branch must not take reads down. The read is
			// served from committed `main` — which does not carry task.9599, so null
			// is the correct answer — while the evidence branch stays untouched.
			// Reads still fail closed on lock contention and on a destroyed
			// connection; both are asserted above. Only branch-proof residue is
			// tolerated.
			await expect(adapter.get(toWorkItemId("task.9599"))).resolves.toBeNull();
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(1);

			// CONTRACT CHANGE, deliberate (bug.5358). This case previously asserted
			// that the write stays 503 forever. That is what made operator
			// production unwritable: nothing deletes this ref, the sweep re-walks
			// `dolt.branches` on every request, and no restart clears it — 88
			// consecutive write 503s over two hours while reads stayed 200.
			//
			// The safety property is unchanged: the write still does not build on
			// unproven evidence. Instead the ref is RENAMED out of the swept
			// namespace, so its commits survive byte-for-byte for a human to
			// merge, and the write then proceeds. Here it proceeds to a genuine
			// "not found", because committed `main` does not carry task.9599 —
			// which is exactly the point: the branch no longer decides the
			// outcome.
			await expect(
				adapter.patch(
					{
						id: toWorkItemId("task.9599"),
						set: { title: "must not land" },
					},
					"component-agent",
				),
			).rejects.toThrow(/Work item not found/);
			// Parked, never deleted: gone from the op namespace, present under
			// quarantine with its row intact.
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${branch}'`,
				),
			).resolves.toHaveLength(0);
			const quarantined = `work-item-quarantine/${branch.slice(
				"work-item-op/".length,
			)}`;
			await expect(
				maintenance.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${quarantined}'`,
				),
			).resolves.toHaveLength(1);
			// Proving the ROW survived is the point of quarantine. Doltgres is
			// Postgres dialect, so MySQL backtick branch-qualification does not
			// parse; check the branch out on the maintenance session instead.
			await maintenance.unsafe(`SELECT dolt_checkout('${quarantined}')`);
			await expect(
				maintenance.unsafe("SELECT id FROM work_items WHERE id = 'task.9599'"),
			).resolves.toHaveLength(1);
			await maintenance.unsafe("SELECT dolt_checkout('main')");

			// `branch` no longer exists — quarantine renamed it — so drop the
			// quarantined ref to prove a clean store still reads null.
			await maintenance.unsafe(`SELECT dolt_branch('-D', '${quarantined}')`);
			await expect(adapter.get(toWorkItemId("task.9599"))).resolves.toBeNull();
		} finally {
			await maintenance
				.unsafe("SELECT dolt_checkout('main')")
				.catch(() => undefined);
			await maintenance
				.unsafe(`SELECT dolt_branch('-D', '${branch}')`)
				.catch(() => undefined);
			await maintenance
				.unsafe(
					`SELECT dolt_branch('-D', 'work-item-quarantine/${branch.slice("work-item-op/".length)}')`,
				)
				.catch(() => undefined);
			await maintenance.end({ timeout: 0 });
		}
	}, 60_000);

	it("commits only work_items while preserving and deterministically cleaning dirty knowledge", async () => {
		const adapter = new DoltgresWorkItemAdapter(sql, {
			recreateReadClient: () => postgres(dbUrl, { max: 2, fetch_types: false }),
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9502");
		const knowledgeId = "component-dirty-knowledge";
		const knowledgeBranch = "knowledge-component-dirty";
		const principalId = "doltgres-scoped-staging-agent";
		const knowledgeSql = postgres(dbUrl, { max: 1, fetch_types: false });
		let knowledgeSession:
			| Awaited<ReturnType<typeof knowledgeSql.reserve>>
			| undefined;
		let workItemCreated = false;
		let before = "";
		let beforeBranches: ReadonlyArray<Record<string, unknown>> = [];
		let beforeStatus: ReadonlyArray<Record<string, unknown>> = [];

		try {
			const beforeRows = await sql.unsafe("SELECT dolt_hashof('main') AS hash");
			before = String(beforeRows[0]?.hash ?? "");
			expect(before).not.toBe("");
			beforeBranches = await sql.unsafe(
				"SELECT name, hash FROM dolt.branches ORDER BY name",
			);
			beforeStatus = await sql.unsafe(
				"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
			);
			// Pin checkout, dirty write, assertions, and cleanup to one Dolt session.
			// A max:1 pool limits concurrency but does not itself reserve a session.
			await knowledgeSql.unsafe("SELECT 1 AS knowledge_ready");
			knowledgeSession = await knowledgeSql.reserve();
			await knowledgeSession.unsafe(
				`SELECT dolt_checkout('-b', '${knowledgeBranch}', 'main')`,
			);
			await knowledgeSession.unsafe(
				`INSERT INTO knowledge (id, domain, title, content, source_type) VALUES ('${knowledgeId}', 'shared', 'Dirty fixture', 'Must remain outside work-item commit', 'agent')`,
			);

			await adapter.create(
				{ id, type: "task", title: "Scoped staging acceptance" },
				principalId,
			);
			workItemCreated = true;

			const afterRows = await sql.unsafe("SELECT dolt_hashof('main') AS hash");
			const after = String(afterRows[0]?.hash ?? "");
			expect(after).not.toBe(before);
			await expect(
				sql.unsafe(
					`SELECT * FROM dolt_diff('${before}', '${after}', 'knowledge')`,
				),
			).resolves.toHaveLength(0);
			await expect(
				knowledgeSession.unsafe(
					`SELECT table_name FROM dolt.status WHERE table_name = 'public.knowledge'`,
				),
			).resolves.toHaveLength(1);
			await expect(
				knowledgeSession.unsafe(
					`SELECT id FROM knowledge WHERE id = '${knowledgeId}'`,
				),
			).resolves.toHaveLength(1);
		} finally {
			if (workItemCreated) {
				await adapter
					.patch({ id, set: { status: "cancelled" } }, principalId)
					.catch(() => undefined);
			}
			if (knowledgeSession) {
				await knowledgeSession
					.unsafe("SELECT dolt_reset('--hard', 'HEAD')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe("SELECT dolt_checkout('main')")
					.catch(() => undefined);
				await knowledgeSession
					.unsafe(`SELECT dolt_branch('-D', '${knowledgeBranch}')`)
					.catch(() => undefined);
				knowledgeSession.release();
			}
			await knowledgeSql.end({ timeout: 0 });
			await sql.unsafe("SELECT dolt_checkout('main')").catch(() => undefined);
			if (before) {
				await sql.unsafe(`SELECT dolt_reset('--hard', '${before}')`);
			}
			await expect(
				sql.unsafe("SELECT dolt_hashof('main') AS hash"),
			).resolves.toEqual([{ hash: before }]);
			await expect(
				sql.unsafe("SELECT name, hash FROM dolt.branches ORDER BY name"),
			).resolves.toEqual(beforeBranches);
			await expect(
				sql.unsafe(
					"SELECT table_name, staged FROM dolt.status ORDER BY table_name",
				),
			).resolves.toEqual(beforeStatus);
		}
	}, 60_000);
	it("a timed-out GET preserves healthy old and new readers while draining its own generation", async () => {
		const clients: Sql[] = [];
		const createReader = () => {
			const client = postgres(dbUrl, { max: 2, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			client.unsafe = ((query: string) =>
				query.includes("task.9001")
					? unsafe("SELECT pg_sleep(3)").then(() => [])
					: query.includes("task.9002")
						? unsafe("SELECT pg_sleep(0.5)").then(() => [])
						: unsafe(query)) as typeof client.unsafe;
			clients.push(client);
			return client;
		};
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = createReader();
		try {
			await reader.unsafe("SELECT 1");
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader,
				recreateReadClient: createReader,
				queryTimeoutMs: 1_000,
				readConnectionBudget: 4,
			});
			const first = adapter
				.get(toWorkItemId("task.9001"))
				.catch((error) => error);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const healthyOld = adapter.get(toWorkItemId("task.9002"));
			expect(await first).toBeInstanceOf(WorkItemsBusyError);
			await expect(adapter.get(toWorkItemId("task.9003"))).resolves.toBeNull();
			await expect(healthyOld).resolves.toBeNull();
			expect(clients).toHaveLength(2);
			// The expired read does not destroy siblings or poison the replacement.
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			await expect(adapter.get(toWorkItemId("task.9003"))).resolves.toBeNull();
		} finally {
			await Promise.all([
				writer.end({ timeout: 0 }),
				...clients.map((client) => client.end({ timeout: 0 })),
			]);
		}
	}, 5_000);
	it("bounds native writer sessions across timeout retries and a fresh process", async () => {
		const sleepSeconds = 12;
		const queryTimeoutMs = 500;
		// The owning DI declares ONE writer connection. Destroying JS clients or
		// restarting their process must not reset this native outstanding budget.
		const nativeWriterBudget = 1;
		const clients: Sql[] = [];
		const producerPids: number[] = [];
		const snapshots: unknown[] = [];
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		let retirements = 0;
		let recreations = 0;
		let admissions = 0;
		let mutationQueries = 0;
		let lastSleepStartedAt = 0;
		const pause = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));
		const makeWriter = () => {
			const client = postgres(dbUrl, { max: 1, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			const end = client.end.bind(client);
			const reserve = client.reserve.bind(client);
			client.unsafe = ((query: string) => {
				if (query === "SELECT 1 AS work_items_ready") {
					lastSleepStartedAt = Date.now();
					// Real finite engine work at the production pre-guard prime seam.
					return unsafe(`SELECT pg_sleep(${sleepSeconds})`).then(() => []);
				}
				if (/INSERT|UPDATE|DELETE|dolt_|advisory/i.test(query)) mutationQueries++;
				return unsafe(query);
			}) as typeof client.unsafe;
			client.reserve = (() => {
				admissions++;
				return reserve();
			}) as typeof client.reserve;
			client.end = (async (options) => {
				await end(options);
				retirements++;
			}) as typeof client.end;
			clients.push(client);
			return client;
		};
		let writer = makeWriter();
		const adapter = new DoltgresWorkItemAdapter(writer, {
			readClient: reader,
			writerLockProtocol: "database",
			queryTimeoutMs,
			recreateClient: () => {
				recreations++;
				writer = makeWriter();
				return writer;
			},
		});
		const census = async () =>
			observer.unsafe<{ pid: number; state: string; query: string }[]>(
				`SELECT DISTINCT pid, state, query FROM pg_catalog.pg_stat_activity WHERE pid IN (${producerPids.join(",")}) ORDER BY pid`,
			);
		const confirmNativeSleep = async (pid: number) => {
			const deadline = Date.now() + queryTimeoutMs;
			while (Date.now() < deadline) {
				const rows = await census();
				if (
					rows.some(
						(row) =>
							Number(row.pid) === pid &&
							row.state === "active" &&
							row.query.includes("pg_sleep"),
					)
				)
					return;
				await pause(5);
			}
			throw new Error(
				`Native sleep did not start before retirement for PID ${pid}`,
			);
		};
		let child: ReturnType<typeof spawn> | undefined;
		let childDeadline: ReturnType<typeof setTimeout> | undefined;
		let childClosed:
			| Promise<{ code: number | null; signal: string | null }>
			| undefined;
		let firstSleepStartedAt = 0;
		try {
			const observerPid = Number(
				(await observer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			for (let wave = 0; wave < 4; wave++) {
				const previous = writer;
				const pid = Number(
					(await writer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
				);
				expect(Number.isInteger(pid)).toBe(true);
				expect(pid).not.toBe(observerPid);
				producerPids.push(pid);
				const result = adapter
					.create(
						{
							id: toWorkItemId("task.9610"),
							type: "task",
							title: "Must never execute",
						},
						"orphan-budget-probe",
					)
					.catch((error: unknown) => error);
				await confirmNativeSleep(pid);
				firstSleepStartedAt ||= lastSleepStartedAt;
				expect(await result).toBeInstanceOf(WorkItemsBusyError);
				expect(retirements).toBe(wave + 1);
				expect(recreations).toBe(wave + 1);
				expect(writer).not.toBe(previous);
				snapshots.push({ wave, rows: await census() });
			}

			// A separate Node process imports the BUILT public adapter, not Vitest's
			// workspace alias, and exits after its actual end(0)/recreate path.
			const adapterUrl = pathToFileURL(
				path.join(
					REPO_ROOT,
					"packages/work-items/dist/adapters/doltgres/index.js",
				),
			).href;
			const source = `
	import postgres from 'postgres';
	import { DoltgresWorkItemAdapter, WorkItemsBusyError } from ${JSON.stringify(adapterUrl)};
	const pools = [];
	let retired = 0, recreated = 0, admissions = 0, mutations = 0;
	function makeWriter() {
	  const pool = postgres(process.env.ORPHAN_PROBE_DB_URL, {max: 1, fetch_types: false});
	  const unsafe = pool.unsafe.bind(pool), end = pool.end.bind(pool), reserve = pool.reserve.bind(pool);
	  pool.unsafe = query => query === 'SELECT 1 AS work_items_ready'
	    ? unsafe('SELECT pg_sleep(${sleepSeconds})').then(() => [])
	    : (mutations += /INSERT|UPDATE|DELETE|dolt_|advisory/i.test(query) ? 1 : 0, unsafe(query));
	  pool.reserve = () => { admissions++; return reserve(); };
	  pool.end = async options => { await end(options); retired++; };
	  pools.push(pool); return pool;
	}
	const writer = makeWriter();
	const reader = postgres(process.env.ORPHAN_PROBE_DB_URL, {max: 1, fetch_types: false});
	const adapter = new DoltgresWorkItemAdapter(writer, {readClient: reader, writerLockProtocol: 'database', queryTimeoutMs: ${queryTimeoutMs},
	  recreateClient: () => { recreated++; return makeWriter(); }});
	const pid = Number((await writer.unsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
	process.send({phase: 'ready', pid, processPid: process.pid});
	await new Promise(resolve => process.once('message', resolve));
	const result = await adapter.create({id: 'task.9611', type: 'task', title: 'Must never execute'}, 'orphan-child').catch(error => error);
	process.send({phase: 'result', busy: result instanceof WorkItemsBusyError, retired, recreated, admissions, mutations}, async () => {
	  await Promise.allSettled([...pools, reader].map(pool => pool.end({timeout: 0})));
	  process.exit(0);
	});`;
			child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
				cwd: path.join(REPO_ROOT, "app"),
				env: { ...process.env, ORPHAN_PROBE_DB_URL: dbUrl },
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			});
			const childProcess = child;
			let diagnostics = "";
			child.stderr?.on("data", (data: Buffer) => {
				diagnostics += data.toString();
			});
			childClosed = new Promise((resolve, reject) => {
				childProcess.once("error", reject);
				childProcess.once("close", (code, signal) => resolve({ code, signal }));
			});
			childDeadline = setTimeout(() => childProcess.kill("SIGKILL"), 6_000);
			const message = (phase: string) =>
				new Promise<Record<string, unknown>>((resolve, reject) => {
					const receive = (value: unknown) => {
						if (
							value &&
							typeof value === "object" &&
							"phase" in value &&
							value.phase === phase
						) {
							childProcess.off("message", receive);
							resolve(value as Record<string, unknown>);
						}
					};
					childProcess.on("message", receive);
					void childClosed?.then(
						() =>
							reject(new Error(`Child exited before ${phase}: ${diagnostics}`)),
						reject,
					);
				});
			const ready = await message("ready");
			expect(ready.processPid).toBe(child.pid);
			expect(ready.processPid).not.toBe(process.pid);
			const childPid = Number(ready.pid);
			expect(Number.isInteger(childPid)).toBe(true);
			expect(childPid).toBeGreaterThan(0);
			expect(childPid).not.toBe(observerPid);
			expect(producerPids).not.toContain(childPid);
			producerPids.push(childPid);
			const resultMessage = message("result");
			// Preserve a setup/invariant failure if the teardown closes IPC before
			// this result is awaited; the original promise still propagates below.
			void resultMessage.catch(() => undefined);
			lastSleepStartedAt = Date.now();
			child.send({ phase: "retry" });
			await confirmNativeSleep(childPid);
			expect(await resultMessage).toMatchObject({
				busy: true,
				retired: 1,
				recreated: 1,
				admissions: 0,
				mutations: 0,
			});
			expect(await childClosed, diagnostics).toEqual({ code: 0, signal: null });
			clearTimeout(childDeadline);
			expect(admissions).toBe(0);
			expect(mutationQueries).toBe(0);
			expect(new Set(producerPids).size).toBe(5);
			const remaining = await census();
			snapshots.push({ phase: "after-child-exit", rows: remaining });
			console.info(
				"native orphan writer budget",
				JSON.stringify({ nativeWriterBudget, producerPids, snapshots }),
			);
			// Reject a timing-induced false pass: no sleep may have finished
			// naturally before the native resource bound is measured.
			expect(Date.now() - firstSleepStartedAt).toBeLessThan(
				(sleepSeconds - 1) * 1_000,
			);
			expect(remaining.length, JSON.stringify(snapshots)).toBeLessThanOrEqual(
				nativeWriterBudget,
			);
		} finally {
			if (childDeadline) clearTimeout(childDeadline);
			if (child && child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await childClosed?.catch(() => undefined);
			await Promise.allSettled(
				[...clients, reader].map((client) => client.end({ timeout: 0 })),
			);
			// Finite owned work only: let the last sleep finish before closing
			// the auditor; suite teardown then destroys the disposable engine.
			await pause(
				Math.max(0, lastSleepStartedAt + sleepSeconds * 1_000 + 250 - Date.now()),
			);
			await observer.end({ timeout: 0 });
		}
	}, 30_000);
	it("knowledge and work-item writers share one database scope throughout a logical write", async () => {
		const knowledgeSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const knowledgeRead = postgres(dbUrl, { max: 1, fetch_types: false });
		const workSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const workRead = postgres(dbUrl, { max: 1, fetch_types: false });
		const store = new DoltgresKnowledgeStoreAdapter({
			sql: knowledgeRead,
			writerSession: new DoltBranchSessionRunner(knowledgeSql, {
				writerProtocol: "database",
			}),
		});
		const work = new DoltgresWorkItemAdapter(workSql, {
			writerLockProtocol: "database",
			readClient: workRead,
			lockWaitMs: 100,
			lockRetryMs: 10,
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered: () => void = () => {};
		let failed: (error: unknown) => void = () => {};
		const ready = new Promise<void>((resolve, reject) => {
			entered = resolve;
			failed = reject;
		});
		let holding: Promise<unknown> | undefined;
		const id = toWorkItemId("task.9600");
		try {
			await store.registerDomain({ id: "scope-mix", name: "Scope proof" });
			await work.create(
				{ id, type: "task", title: "before mixed write" },
				"mixed-principal",
			);
			holding = store.withWrite(
				{
					operationId: "native.knowledge.workitem.mix",
					message: "mixed writer proof",
				},
				async (write) => {
					await write.addKnowledge({
						id: "native-mixed-scope",
						domain: "scope-mix",
						title: "Scoped knowledge",
						content: "Atomic content",
						entryType: "finding",
						sourceType: "agent",
					});
					entered();
					await gate;
					return "committed";
				},
			);
			void holding.catch(failed);
			await ready;
			await expect(
				work.patch({ id, set: { title: "must wait" } }, "mixed-principal"),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
			await expect(work.get(id)).resolves.toMatchObject({
				title: "before mixed write",
			});
			release();
			await expect(holding).resolves.toBe("committed");
			await expect(
				store.getKnowledge("native-mixed-scope"),
			).resolves.toMatchObject({ content: "Atomic content" });
			await expect(
				work.patch(
					{ id, set: { title: "after knowledge acknowledgement" } },
					"mixed-principal",
				),
			).resolves.toMatchObject({ title: "after knowledge acknowledgement" });
		} finally {
			release();
			await holding?.catch(() => undefined);
			await Promise.all(
				[knowledgeSql, knowledgeRead, workSql, workRead].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 15_000);
});
