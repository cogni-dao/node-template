// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native engine regression: advisory names are process-wide; writer scopes are not. */
import {
	runDoltBranchMutation,
	acquireDoltWriterLocks,
	doltWriterLockKey,
	DoltNativeSessionExecutor,
	type DoltWriterLock,
} from "@cogni-dao/doltgres-admission";
import postgres, { type ReservedSql, type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	assertCliKeepsGuardThroughLateDml,
	cliFixture,
} from "./doltgres-admission.fixture";

const PASSWORD = "admission-test";
const DATABASE_A = "admission_a";
const DATABASE_B = "admission_b";

describe("Doltgres 0.57.3 common per-database writer protocol", () => {
	let container: StartedTestContainer;
	let origin: string;
	let first: Sql;
	let peer: Sql;
	let second: Sql;
	let a: ReservedSql;
	let aPeer: ReservedSql;
	let b: ReservedSql;
	beforeAll(async () => {
		container = await new GenericContainer("dolthub/doltgresql:0.57.3")
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();
		origin = `postgresql://postgres:${PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}`;
		const admin = postgres(`${origin}/postgres`, {
			max: 1,
			fetch_types: false,
		});
		try {
			await admin.unsafe(`CREATE DATABASE ${DATABASE_A}`);
			await admin.unsafe(`CREATE DATABASE ${DATABASE_B}`);
		} finally {
			await admin.end({ timeout: 1 });
		}
		first = postgres(`${origin}/${DATABASE_A}`, { max: 1, fetch_types: false });
		peer = postgres(`${origin}/${DATABASE_A}`, { max: 1, fetch_types: false });
		second = postgres(`${origin}/${DATABASE_B}`, {
			max: 1,
			fetch_types: false,
		});
		// fetch_types=false cold reserve requires a completed priming query.
		for (const sql of [first, peer, second]) await sql.unsafe("SELECT 1");
		[a, aPeer, b] = await Promise.all([
			first.reserve(),
			peer.reserve(),
			second.reserve(),
		]);
	}, 90_000);
	afterAll(async () => {
		a?.release();
		aPeer?.release();
		b?.release();
		await Promise.all([
			first?.end({ timeout: 0 }),
			peer?.end({ timeout: 0 }),
			second?.end({ timeout: 0 }),
		]);
		await container?.stop();
	});

	it("native current_database revision identity maps checkout to the same physical root", async () => {
		const before = await a.unsafe("SELECT current_database() AS identity");
		expect(before[0]?.identity).toBe(DATABASE_A);
		await a.unsafe("SELECT dolt_checkout('-b', 'identity-proof', 'main')");
		try {
			const branch = await a.unsafe("SELECT current_database() AS identity");
			expect([DATABASE_A, `${DATABASE_A}/identity-proof`]).toContain(
				branch[0]?.identity,
			);
			expect(doltWriterLockKey(String(branch[0]?.identity))).toBe(
				doltWriterLockKey(DATABASE_A),
			);
		} finally {
			await a.unsafe("SELECT dolt_checkout('main')");
			await a.unsafe("SELECT dolt_branch('-D', 'identity-proof')");
		}
	});

	it("the unscoped legacy key blocks another database on the exact pinned engine", async () => {
		const held = await a.unsafe("SELECT pg_try_advisory_lock(5001001)");
		expect(held[0]?.pg_try_advisory_lock).toBe(true);
		try {
			const cross = await b.unsafe("SELECT pg_try_advisory_lock(5001001)");
			expect(cross[0]?.pg_try_advisory_lock).toBe(false);
			await expect(
				acquireDoltWriterLocks(b, { lockWaitMs: 20, lockRetryMs: 5 }),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
		} finally {
			await a.unsafe("SELECT pg_advisory_unlock(5001001)");
		}
	});

	it("scoped unrelated databases progress, same-database bridge/scoped contenders exclude, partial locks are released", async () => {
		let scopedA: DoltWriterLock | undefined;
		let scopedB: DoltWriterLock | undefined;
		let bridgeA: DoltWriterLock | undefined;
		try {
			scopedA = await acquireDoltWriterLocks(a, { protocol: "database" });
			scopedB = await acquireDoltWriterLocks(b, { protocol: "database" });
			expect(scopedA.baseDatabase).toBe(DATABASE_A);
			expect(scopedB.baseDatabase).toBe(DATABASE_B);
			expect(scopedA.keys).not.toEqual(scopedB.keys);
			// A bridge acquires both global domains before reaching the busy native scope.
			await expect(
				acquireDoltWriterLocks(aPeer, { lockWaitMs: 20, lockRetryMs: 5 }),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
			for (const key of [5001001, 5001002]) {
				expect(
					(await aPeer.unsafe(`SELECT pg_try_advisory_lock(${key})`))[0]
						?.pg_try_advisory_lock,
				).toBe(true);
				await aPeer.unsafe(`SELECT pg_advisory_unlock(${key})`);
			}
			await scopedA.release();
			scopedA = undefined;
			bridgeA = await acquireDoltWriterLocks(a);
			await expect(
				acquireDoltWriterLocks(aPeer, {
					protocol: "database",
					lockWaitMs: 20,
					lockRetryMs: 5,
				}),
			).rejects.toMatchObject({
				reason: "lock_contended",
				discardSession: false,
			});
			// B remains protected solely by its independent native key throughout A's bridge.
			expect(
				(await b.unsafe("SELECT current_database() AS identity"))[0]?.identity,
			).toBe(DATABASE_B);
		} finally {
			await bridgeA?.release();
			await scopedA?.release();
			await scopedB?.release();
		}
	});
	it("documents unsupported native CancelRequest while a sibling read progresses", async () => {
		const readers = postgres(`${origin}/${DATABASE_A}`, {
			max: 2,
			fetch_types: false,
		});
		try {
			await readers.unsafe("SELECT 1");
			const started = Date.now();
			const slow = readers.unsafe("SELECT pg_sleep(0.4)").execute();
			// Query execution begins before the protocol cancellation request is sent.
			await new Promise((resolve) => setTimeout(resolve, 100));
			slow.cancel();
			expect((await readers.unsafe("SELECT 7 AS neighbor"))[0]?.neighbor).toBe(
				7,
			);
			await slow;
			// v0.57.3 rejects CancelRequest at startup: finite work still completes.
			// This is a recorded engine limitation, NOT isolated timeout recovery proof.
			expect(Date.now() - started).toBeGreaterThanOrEqual(350);
		} finally {
			await readers.end({ timeout: 0 });
		}
	}, 5_000);

	it("commits a scoped logical write on an isolated branch and exposes exact main ancestry", async () => {
		const guard = await acquireDoltWriterLocks(a);
		try {
			await a.unsafe(
				"CREATE TABLE IF NOT EXISTS scope_probe (id text PRIMARY KEY, value text)",
			);
			await a.unsafe("SELECT dolt_commit('-Am', 'scope fixture')");
			const result = await runDoltBranchMutation(a, {
				guard,
				operationId: "native.scope.success",
				message: "native scoped row",
				onSessionUncertain: async (error) => {
					throw error;
				},
				run: async (scoped) => {
					await scoped.unsafe(
						"INSERT INTO scope_probe VALUES ('success','committed')",
					);
					return "success";
				},
			});
			expect(result.value).toBe("success");
			expect(result.commitHash).toMatch(/^[0-9a-v]{32}$/);
			expect(
				(
					await aPeer.unsafe("SELECT value FROM scope_probe WHERE id='success'")
				)[0]?.value,
			).toBe("committed");
			expect(await a.unsafe("SELECT * FROM dolt.status")).toHaveLength(0);
		} finally {
			await guard.release();
		}
	});

	it("bug.5544: an interrupted executor write frees the advisory lock and the next op serves (no wedge)", async () => {
		// Drive the REAL DoltNativeSessionExecutor against real Doltgres. An
		// interrupted write must evict + release the server-global advisory lock so
		// a PEER connection (standing in for the separate work-items writer) can
		// re-acquire the scoped key, and the SAME executor must admit the next op.
		// Old code quarantined the connection and held the lock until pod restart.
		const errors = {
			busy: (message: string) => new Error(message),
			outcomeUnknown: (operationId: string, branch: string, hash?: string) =>
				Object.assign(new Error(`outcome-unknown ${operationId}`), {
					name: "OutcomeUnknown",
					operationId,
					branch,
					hash,
				}),
			fault: (message: string) => new Error(message),
		};
		const writerPool = postgres(`${origin}/${DATABASE_A}`, {
			max: 1,
			fetch_types: false,
		});
		await writerPool.unsafe("SELECT 1");
		const executor = new DoltNativeSessionExecutor(writerPool, {
			errors,
			writerProtocol: "database",
			lockWaitMs: 2_000,
			lockRetryMs: 50,
		});
		const scopedKey = doltWriterLockKey(DATABASE_A);
		try {
			await a.unsafe(
				"CREATE TABLE IF NOT EXISTS wedge_probe (id text PRIMARY KEY)",
			);
			await a.unsafe("SELECT dolt_commit('-Am', 'wedge fixture')");

			// 1) Interrupted write: the callback throws AFTER a DML.
			await expect(
				executor.run(
					"wedge.interrupt",
					async (conn, guard, owner) =>
						runDoltBranchMutation(conn, {
							guard,
							operationId: "wedge.interrupt",
							message: "interrupted after DML",
							onSessionUncertain: (error) => executor.retire(conn, error),
							onReconcile: owner.registerReconciliation,
							onCommitted: owner.committed,
							run: async (scoped) => {
								await scoped.unsafe(
									"INSERT INTO wedge_probe VALUES ('interrupted')",
								);
								throw new Error("interrupted after DML");
							},
						}),
					{ operationId: "wedge.interrupt", awaitSettlement: true },
				),
			).rejects.toThrow();

			// 2) PROOF the lock is FREE: a peer connection acquires the scoped key.
			//    Old code held it here -> this would be false (wedge).
			const got = await aPeer.unsafe(
				`SELECT pg_try_advisory_lock(${scopedKey})`,
			);
			expect(got[0]?.pg_try_advisory_lock).toBe(true);
			await aPeer.unsafe(`SELECT pg_advisory_unlock(${scopedKey})`);

			// 3) PROOF no wedge: the SAME executor admits and completes the next op.
			const served = await executor.run(
				"wedge.after",
				async (conn, guard, owner) =>
					runDoltBranchMutation(conn, {
						guard,
						operationId: "wedge.after",
						message: "serves after interruption",
						onSessionUncertain: (error) => executor.retire(conn, error),
						onReconcile: owner.registerReconciliation,
						onCommitted: owner.committed,
						run: async (scoped) => {
							await scoped.unsafe(
								"INSERT INTO wedge_probe VALUES ('after') ON CONFLICT DO NOTHING",
							);
							return "served";
						},
					}),
				{ operationId: "wedge.after" },
			);
			expect(served).toBe("served");
		} finally {
			await writerPool.end({ timeout: 0 });
		}
	}, 30_000);

	it("callback failure after DML never carries dirty operation changes into main", async () => {
		const guard = await acquireDoltWriterLocks(a);
		const before = String(
			(await a.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash,
		);
		let poisoned = false;
		try {
			await expect(
				runDoltBranchMutation(a, {
					guard,
					operationId: "native.scope.callback-failure",
					message: "must not land",
					onSessionUncertain: async () => {
						poisoned = true;
					},
					run: async (scoped) => {
						await scoped.unsafe(
							"INSERT INTO scope_probe VALUES ('rejected','must remain absent')",
						);
						throw new Error("domain validation rejected citation");
					},
				}),
			).rejects.toThrow("domain validation rejected citation");
			expect(poisoned).toBe(false);
			expect(
				(await a.unsafe("SELECT active_branch() AS branch"))[0]?.branch,
			).toBe("main");
			expect(
				String((await a.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash),
			).toBe(before);
			expect(
				await aPeer.unsafe("SELECT * FROM scope_probe WHERE id='rejected'"),
			).toHaveLength(0);
			expect(await a.unsafe("SELECT * FROM dolt.status")).toHaveLength(0);
		} finally {
			await guard.release();
		}
	});

  it("suffixed lane startup then already-applied init is read-only beside a dirty live writer", async () => {
    const fixture = await cliFixture(origin, "knowledge_cli_noop_candidate_a", "cli-noop");
    const writer = postgres(fixture.url, { max: 1, fetch_types: false });
    try {
      await writer.unsafe("INSERT INTO migration_probe VALUES (42)");
      const before = await writer.unsafe("SELECT dolt_hashof('main') AS head");
      const dirty = await writer.unsafe("SELECT * FROM dolt.status");
      expect(dirty.length).toBeGreaterThan(0);
      const result = await fixture.migrate();
      expect(result).toMatchObject({ code: 0 });
      expect(result.output).toContain("read-only no-op; no journal DDL or commit");
      expect(await writer.unsafe("SELECT dolt_hashof('main') AS head")).toEqual(before);
      expect(await writer.unsafe("SELECT * FROM dolt.status")).toEqual(dirty);
      expect(await writer.unsafe("SELECT id FROM migration_probe")).toEqual([{ id: 42 }]);
      expect(await writer.unsafe("SELECT COUNT(*)::integer AS count FROM drizzle.__drizzle_migrations")).toEqual([{ count: 1 }]);
      for (const pathname of [
        "knowledge_foreign_candidate_a",
        "knowledge_cli_noop_candidate_z",
        "knowledge_cli_noop_candidate_a_preview",
        "knowledge_cli_noop_candidate_a/branch",
        "knowledge_cli_noop%2Fcandidate_a",
        "knowledge_cli_noop_candidаte_a", // Cyrillic a is not a canonical ASCII lane.
      ]) {
        const rejected = new URL(fixture.url);
        rejected.port = "1"; // A connection attempt cannot satisfy this control.
        rejected.pathname = `/${pathname}`;
        const negative = await fixture.migrate(5_000, rejected.toString());
        expect(negative.code).toBe(1);
        expect(negative.output).toContain('"code":"migration_database_identity_mismatch"');
      }
    } finally { await writer.end({ timeout: 1 }); await fixture.close(); }
  });

  it("actual CLI SIGKILL retains native guard through late DML; same batch never replays", async () => {
    await assertCliKeepsGuardThroughLateDml(origin, "SIGKILL");
  });
});
