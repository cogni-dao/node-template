// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native engine regression: advisory names are process-wide; writer scopes are not. */
import {
	runDoltBranchMutation,
	acquireDoltWriterLocks,
	doltWriterLockKey,
	type DoltWriterLock,
} from "@cogni-dao/doltgres-admission";
import postgres, { type ReservedSql, type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
});
