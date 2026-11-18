// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO


/**
 * Real Doltgres 0.57.3: reader generation slots, writer retention after caller deadlines, and
 * finite recovery of every contribution stage. Independent of the other work-item acceptance files
 * (task.0138).
 */

import { toWorkItemId } from "@cogni/work-items";
import { acquireDoltWriterLocks } from "@cogni-dao/doltgres-admission";
import postgres, { type Sql } from "postgres";
import {
	DoltBranchSessionRunner,
	DoltgresKnowledgeStoreAdapter,
	DoltgresKnowledgeContributionAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DoltgresWorkItemAdapter,
	WorkItemWriteOutcomeUnknownError,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";
import { startWorkItemsDoltgres } from "./doltgres-work-items.fixture";

describe("Doltgres 0.57.3 work-item acceptance: reader and writer settlement", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let dbUrl: string;

	beforeAll(async () => {
		({ container, sql, dbUrl } = await startWorkItemsDoltgres());
	}, 180_000);

	afterAll(async () => {
		if (sql) await sql.end({ timeout: 5 });
		if (container) await container.stop();
	});

	it("a timed-out GET preserves healthy old and new readers while draining its own generation", async () => {
		const clients: Sql[] = [];
		const nativeReads: PromiseLike<unknown>[] = [];
		const createReader = () => {
			const client = postgres(dbUrl, { max: 2, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			client.unsafe = ((query: string) => {
				const pending = query.includes("task.9001")
					? unsafe("SELECT pg_sleep(3)").then(() => [])
					: query.includes("task.9002")
						? unsafe("SELECT pg_sleep(0.5)").then(() => [])
						: unsafe(query);
				nativeReads.push(pending);
				return pending;
			}) as typeof client.unsafe;
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
			await Promise.allSettled(nativeReads);
			await Promise.all([
				writer.end({ timeout: 0 }),
				...clients.map((client) => client.end({ timeout: 0 })),
			]);
		}
	}, 5_000);
	it("keeps reader generation slots until native settlement and bounds repeated timeouts", async () => {
		const clients: Sql[] = [];
		const native: Promise<unknown>[] = [];
		let ended = 0;
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = () => {
			const client = postgres(dbUrl, { max: 1, fetch_types: false });
			const unsafe = client.unsafe.bind(client);
			const end = client.end.bind(client);
			client.unsafe = ((query: string) => {
				if (!query.includes("task.9613")) return unsafe(query);
				const pending = unsafe(
					"SELECT pg_sleep(3) /* reader_generation_probe */",
				).then(() => []);
				native.push(pending);
				return pending;
			}) as typeof client.unsafe;
			client.end = (async (options) => {
				await end(options);
				ended++;
			}) as typeof client.end;
			clients.push(client);
			return client;
		};
		try {
			const observerPid = Number(
				(await observer.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader(),
				recreateReadClient: reader,
				readConnectionBudget: 2,
				queryTimeoutMs: 500,
			});
			for (let attempt = 0; attempt < 2; attempt++)
				await expect(
					adapter.get(toWorkItemId("task.9613")),
				).rejects.toBeInstanceOf(WorkItemsBusyError);
			await expect(
				adapter.get(toWorkItemId("task.9613")),
			).rejects.toBeInstanceOf(WorkItemsBusyError);
			expect(clients).toHaveLength(2);
			expect(ended).toBe(0);
			const rows = await observer.unsafe(
				`SELECT DISTINCT pid FROM pg_catalog.pg_stat_activity WHERE pid <> ${observerPid} AND state = 'active' AND query LIKE '%reader_generation_probe%'`,
			);
			expect(rows).toHaveLength(2);
			await Promise.all(native);
			await expect.poll(() => ended).toBe(2);
			await expect(
				Promise.all(
					Array.from({ length: 8 }, () =>
						adapter.get(toWorkItemId("task.9614")),
					),
				),
			).resolves.toEqual(Array.from({ length: 8 }, () => null));
			expect(clients).toHaveLength(3);
		} finally {
			await Promise.allSettled(native);
			await Promise.allSettled(
				[...clients, writer, observer].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 6_000);
	it("the legacy end(0) strategy is a sensitive native orphan control", async () => {
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const clients: Sql[] = [];
		const pids: number[] = [];
		const started = Date.now();
		let lastConfirmedSleepAt = started;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const client = postgres(dbUrl, { max: 1, fetch_types: false });
				clients.push(client);
				const pid = Number(
					(await client.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
				);
				pids.push(pid);
				const pending = client
					.unsafe("SELECT pg_sleep(6)")
					.catch(() => undefined);
				await expect
					.poll(
						async () =>
							(
								await observer.unsafe(
									`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`,
								)
							).length,
						{ timeout: 1_000 },
					)
					.toBe(1);
				lastConfirmedSleepAt = Date.now();
				await client.end({ timeout: 0 });
				await pending;
			}
			const rows = await observer.unsafe(
				`SELECT DISTINCT pid FROM pg_catalog.pg_stat_activity WHERE pid IN (${pids.join(",")})`,
			);
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(rows).toHaveLength(2);
		} finally {
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.max(0, lastConfirmedSleepAt + 6_250 - Date.now()),
				),
			);
			await Promise.allSettled(
				[...clients, observer].map((client) => client.end({ timeout: 0 })),
			);
		}
	}, 12_000);
	it("retains one native writer through caller retries and recovers after actual settlement", async () => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const otherDb = postgres(dbUrl.replace(`/${DB_NAME}`, "/postgres"), {
			max: 1,
			fetch_types: false,
		});
		const unsafe = writer.unsafe.bind(writer);
		const reserve = writer.reserve.bind(writer);
		let native: Promise<unknown> | undefined;
		let primed = false;
		let reservations = 0;
		let replacements = 0;
		let mutations = 0;
		writer.unsafe = ((query: string) => {
			if (query === "SELECT 1 AS work_items_ready" && !primed) {
				primed = true;
				native = unsafe("SELECT pg_sleep(2)").then(() => []);
				return native;
			}
			if (/INSERT|UPDATE|DELETE/.test(query)) mutations++;
			return unsafe(query);
		}) as typeof writer.unsafe;
		writer.reserve = (() => {
			reservations++;
			return reserve();
		}) as typeof writer.reserve;
		const adapter = new DoltgresWorkItemAdapter(writer, {
			writerLockProtocol: "database",
			readClient: reader,
			queryTimeoutMs: 250,
			recreateClient: () => {
				replacements++;
				throw new Error("No replacement while native SQL is pending");
			},
		});
		try {
			const pid = Number(
				(await unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
			);
			const abandoned = adapter
				.create(
					{
						id: toWorkItemId("task.9612"),
						type: "task",
						title: "Never resume",
					},
					"native-capacity-probe",
				)
				.catch((error: unknown) => error);
			await expect
				.poll(
					async () =>
						(
							await observer.unsafe(
								`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND query LIKE '%pg_sleep%'`,
							)
						).length,
					{ timeout: 1_000 },
				)
				.toBe(1);
			expect(await abandoned).toMatchObject({
				code: "work_items_native_capacity_held",
			});
			for (let retry = 0; retry < 4; retry++)
				await expect(
					adapter.create(
						{ type: "task", title: "Retry cannot allocate" },
						"native-capacity-probe",
					),
				).rejects.toMatchObject({ code: "work_items_native_capacity_held" });
			expect(reservations).toBe(0);
			expect(replacements).toBe(0);
			expect(mutations).toBe(0);
			await expect(adapter.get(toWorkItemId("task.9612"))).resolves.toBeNull();
			await expect(
				otherDb.unsafe("SELECT 1 AS independent_database"),
			).resolves.toEqual([{ independent_database: 1 }]);
			await native;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(reservations).toBe(0);
			expect(mutations).toBe(0);
			await expect(
				adapter.patch(
					{ reason: "test change", id: toWorkItemId("task.9612"), set: { title: "Fresh request" } },
					"native-capacity-probe",
				),
			).rejects.toThrow(/not found/);
			expect(reservations).toBe(1);
			expect(replacements).toBe(0);
			await expect(
				observer.unsafe("SELECT id FROM work_items WHERE id = 'task.9612'"),
			).resolves.toHaveLength(0);
		} finally {
			await native?.catch(() => undefined);
			await Promise.allSettled(
				[writer, reader, observer, otherDb].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 6_000);
	it("reconciles finite post-DML abandonment before releasing its database guard", async () => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const observer = postgres(dbUrl, { max: 1, fetch_types: false });
		const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
		const reserve = writer.reserve.bind(writer);
		let stalled: Promise<unknown> | undefined;
		let inserts = 0;
		let commits = 0;
		let resets = 0;
		writer.reserve = (async () => {
			const session = await reserve();
			const unsafe = session.unsafe.bind(session);
			session.unsafe = ((query: string) => {
				if (query.startsWith("INSERT INTO work_items")) inserts++;
				if (query.startsWith("SELECT dolt_commit")) commits++;
				if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
				if (query === "SELECT dolt_add('work_items')" && !stalled) {
					stalled = unsafe("SELECT pg_sleep(2)").then(() => []);
					return stalled;
				}
				return unsafe(query);
			}) as typeof session.unsafe;
			return session;
		}) as typeof writer.reserve;
		const adapter = new DoltgresWorkItemAdapter(writer, {
			writerLockProtocol: "database",
			readClient: reader,
			queryTimeoutMs: 500,
		});
		let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
		try {
			const error = await adapter
				.create(
					{
						id: toWorkItemId("task.9615"),
						type: "task",
						title: "Must remain uncommitted",
					},
					"native-cleanup-probe",
				)
				.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(WorkItemWriteOutcomeUnknownError);
			if (!(error instanceof WorkItemWriteOutcomeUnknownError)) throw error;
			expect(inserts).toBe(1);
			expect(commits).toBe(0);
			expect(resets).toBe(0);
			await competitor.unsafe("SELECT 1");
			rival = await competitor.reserve();
			const rivalSession = rival;
			await expect
				.poll(
					async () => {
						try {
							const guard = await acquireDoltWriterLocks(rivalSession, {
								protocol: "database",
								lockWaitMs: 0,
							});
							await guard.release();
							return true;
						} catch {
							return false;
						}
					},
					{ timeout: 5_000 },
				)
				.toBe(true);
			expect(resets).toBe(1);
			expect(inserts).toBe(1);
			expect(commits).toBe(0);
			await expect(
				writer.unsafe("SELECT active_branch() AS branch_name"),
			).resolves.toEqual([{ branch_name: "main" }]);
			await expect(
				writer.unsafe("SELECT * FROM dolt.status"),
			).resolves.toHaveLength(0);
			await expect(
				observer.unsafe("SELECT id FROM work_items WHERE id = 'task.9615'"),
			).resolves.toHaveLength(0);
			await expect(
				observer.unsafe(
					`SELECT name FROM dolt.branches WHERE name = '${error.branch}'`,
				),
			).resolves.toHaveLength(1);
			expect(error).toMatchObject({
				retryable: false,
				branch: expect.stringMatching(/^work-item-op\//),
			});
		} finally {
			await stalled?.catch(() => undefined);
			rival?.release();
			await Promise.allSettled(
				[writer, reader, observer, competitor].map((client) =>
					client.end({ timeout: 0 }),
				),
			);
		}
	}, 10_000);
	it.each(["checkout", "edit"] as const)(
		"restores a persisted clean contribution after finite %s settles",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false });
			const reader = postgres(dbUrl, { max: 1, fetch_types: false });
			const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = {
				id: `native-persisted-clean-${stage}`,
				kind: "agent" as const,
			};
			const rowId = `native-persisted-clean-entry-${stage}`;
			const domainId = `persisted-clean-native-${stage}`;
			let contribution:
				| Awaited<ReturnType<typeof contributions.create>>
				| undefined;
			let pending: Promise<unknown> | undefined;
			let nativeSettled = false;
			let earlyAdmission = false;
			let armed = false;
			let edits = 0;
			let resets = 0;
			let commits = 0;
			const reserve = writer.reserve.bind(writer);
			const wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (armed && query.startsWith("SELECT dolt_commit")) commits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					if (
						armed &&
						stage === "checkout" &&
						query.startsWith("SELECT dolt_checkout('contrib/") &&
						!pending
					) {
						const rows = await unsafe(query);
						pending = unsafe("SELECT pg_sleep(2)").then(() => {
							nativeSettled = true;
							return rows;
						});
						return pending;
					}
					if (armed && query.startsWith("UPDATE knowledge SET")) {
						edits++;
						const rows = await unsafe(query);
						if (!pending) {
							pending = unsafe("SELECT pg_sleep(2)").then(() => {
								nativeSettled = true;
								return rows;
							});
							return pending;
						}
						return rows;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			try {
				await store.registerDomain({
					id: domainId,
					name: "Persisted clean native proof",
				});
				contribution = await contributions.create({
					principal,
					message: "Historical committed entry",
					edits: [
						{
							op: "insert",
							entry: {
								id: rowId,
								domain: domainId,
								title: "Keep history",
								content: "Historical content",
							},
						},
					],
				});
				const seedHead = contribution.headCommit;
				expect(seedHead).toMatch(/^[a-z0-9]{32}$/);
				armed = true;
				const error = await contributions
					.appendCommit({
						contributionId: contribution.contributionId,
						principal,
						message: "Finite abandoned edit",
						edits: [
							{
								op: "patch",
								targetRowId: rowId,
								entry: { useWhen: "must be rolled back" },
							},
						],
					})
					.catch((failure: unknown) => failure);
				expect(error).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
				});
				expect(edits).toBe(stage === "edit" ? 1 : 0);
				expect(resets).toBe(0);
				expect(nativeSettled).toBe(false);
				expect(commits).toBe(0);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const rivalSession = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(rivalSession, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5_000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(stage === "edit" ? 1 : 0);
				expect(edits).toBe(stage === "edit" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch_name"),
				).resolves.toEqual([{ branch_name: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await rival.unsafe(`SELECT dolt_checkout('${contribution.branch}')`);
				await expect(
					rival.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
				).resolves.toEqual([{ hash: seedHead }]);
				await expect(
					rival.unsafe(
						`SELECT title, content, use_when FROM knowledge WHERE id = '${rowId}'`,
					),
				).resolves.toEqual([
					{
						title: "Keep history",
						content: "Historical content",
						use_when: null,
					},
				]);
				await rival.unsafe("SELECT dolt_checkout('main')");
				rival.release();
				rival = undefined;
				const fresh = await contributions.appendCommit({
					contributionId: contribution.contributionId,
					principal,
					message: "Legitimate new intent",
					edits: [
						{
							op: "patch",
							targetRowId: rowId,
							entry: { useWhen: "new committed intent" },
						},
					],
				});
				expect(fresh.commitHash).not.toBe(seedHead);
				expect(edits).toBe(stage === "edit" ? 2 : 1);
				expect(resets).toBe(stage === "edit" ? 1 : 0);
				expect(commits).toBe(2);
				await expect(
					reader.unsafe(
						`SELECT commit_count FROM knowledge_contributions WHERE id = '${contribution.contributionId}'`,
					),
				).resolves.toEqual([{ commit_count: 2 }]);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				if (contribution)
					await contributions
						.close({
							contributionId: contribution.contributionId,
							principal,
							reason: "owned native proof complete",
						})
						.catch(() => undefined);
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15_000,
	);
	it.each(["checkout", "content"] as const)(
		"recovers finite initial contribution %s on its proven new branch",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false }),
				reader = postgres(dbUrl, { max: 1, fetch_types: false }),
				competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = { id: `native-fresh-${stage}`, kind: "agent" as const },
				domain = `fresh-native-${stage}`,
				rowId = `fresh-native-entry-${stage}`;
			let armed = false,
				nativeSettled = false,
				earlyAdmission = false,
				branch = "",
				edits = 0,
				resets = 0,
				commits = 0;
			let pending: Promise<unknown> | undefined;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			let fresh: Awaited<ReturnType<typeof contributions.create>> | undefined;
			const reserve = writer.reserve.bind(writer),
				wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (armed && query.startsWith("SELECT dolt_commit(")) commits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					const creating = query.startsWith(
						"SELECT dolt_checkout('-b', 'contrib/",
					);
					if (armed && creating) branch = query.split("'")[3]!;
					if (armed && query.startsWith("INSERT INTO knowledge ")) edits++;
					if (
						armed &&
						!pending &&
						(stage === "checkout"
							? creating
							: query.startsWith("INSERT INTO knowledge "))
					) {
						const rows = await unsafe(query);
						pending = unsafe("SELECT pg_sleep(2)").then(() => {
							nativeSettled = true;
							return rows;
						});
						return pending;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			try {
				await store.registerDomain({
					id: domain,
					name: "Native fresh branch proof",
				});
				const base = String(
					(await reader.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash,
				);
				const input = {
					principal,
					message: "One original contribution intent",
					edits: [
						{
							op: "insert" as const,
							entry: {
								id: rowId,
								domain,
								title: "Fresh intent",
								content: "No uncommitted residue",
							},
						},
					],
				};
				armed = true;
				const error = await contributions.create(input).catch((error) => error);
				expect(error).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
					receipt: { lookup: { branch: expect.stringMatching(/^contrib\//) } },
				});
				expect(branch).toMatch(/^contrib\//);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(resets).toBe(0);
				expect(commits).toBe(0);
				expect(nativeSettled).toBe(false);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const session = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(session, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(stage === "content" ? 1 : 0);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch"),
				).resolves.toEqual([{ branch: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await expect(
					reader.unsafe(
						`SELECT id FROM knowledge_contributions WHERE branch = '${branch}'`,
					),
				).resolves.toHaveLength(0);
				const guard = await acquireDoltWriterLocks(session, {
					protocol: "database",
					lockWaitMs: 0,
				});
				try {
					await session.unsafe(`SELECT dolt_checkout('${branch}')`);
					await expect(
						session.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
					).resolves.toEqual([{ hash: base }]);
					await expect(
						session.unsafe("SELECT * FROM dolt.status"),
					).resolves.toHaveLength(0);
					await expect(
						session.unsafe(`SELECT id FROM knowledge WHERE id = '${rowId}'`),
					).resolves.toHaveLength(0);
					await session.unsafe("SELECT dolt_checkout('main')");
				} finally {
					await guard.release();
				}
				rival.release();
				rival = undefined;
				armed = false;
				fresh = await contributions.create({
					...input,
					message: "New inspected request after settlement",
				});
				expect(fresh.commitCount).toBe(1);
				expect(fresh.branch).not.toBe(branch);
				expect(edits).toBe(stage === "content" ? 1 : 0);
				expect(commits).toBe(0);
				await expect(
					reader.unsafe(
						`SELECT commit_count FROM knowledge_contributions WHERE id = '${fresh.contributionId}'`,
					),
				).resolves.toEqual([{ commit_count: 1 }]);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				armed = false;
				if (fresh)
					await contributions
						.close({
							contributionId: fresh.contributionId,
							principal,
							reason: "Fresh proof cleanup",
						})
						.catch(() => undefined);
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15000,
	);
	it.each(["create", "append", "close"] as const)(
		"recovers finite %s metadata only on its owned operation branch",
		async (stage) => {
			const writer = postgres(dbUrl, { max: 1, fetch_types: false });
			const reader = postgres(dbUrl, { max: 1, fetch_types: false });
			const competitor = postgres(dbUrl, { max: 1, fetch_types: false });
			const runner = new DoltBranchSessionRunner(writer, {
				writerProtocol: "database",
				queryTimeoutMs: 500,
			});
			const contributions = new DoltgresKnowledgeContributionAdapter({
				sql: reader,
				writerSession: runner,
			});
			const store = new DoltgresKnowledgeStoreAdapter({
				sql: reader,
				writerSession: runner,
			});
			const principal = {
				id: `native-metadata-${stage}`,
				kind: "agent" as const,
			};
			const domain = `metadata-native-${stage}`,
				rowId = `metadata-native-entry-${stage}`;
			let armed = false,
				nativeSettled = false,
				earlyAdmission = false,
				metadataCalls = 0,
				edits = 0,
				resets = 0;
			let branch = "",
				metadataBranch = "",
				metadataBase = "";
			let pending: Promise<unknown> | undefined;
			let seed: Awaited<ReturnType<typeof contributions.create>> | undefined;
			let fresh: Awaited<ReturnType<typeof contributions.create>> | undefined;
			let rival: Awaited<ReturnType<Sql["reserve"]>> | undefined;
			const reserve = writer.reserve.bind(writer),
				wrapped = new WeakSet<object>();
			writer.reserve = (async () => {
				const session = await reserve();
				if (wrapped.has(session)) return session;
				wrapped.add(session);
				const unsafe = session.unsafe.bind(session);
				session.unsafe = (async (query: string) => {
					if (query.startsWith("SELECT dolt_checkout('-b', 'contrib/"))
						branch = query.split("'")[3]!;
					if (armed && query.startsWith("UPDATE knowledge SET")) edits++;
					if (query === "SELECT dolt_reset('--hard', 'HEAD')") resets++;
					const targeted =
						stage === "create"
							? query.startsWith("INSERT INTO knowledge_contributions ")
							: stage === "append"
								? query.startsWith(
										"UPDATE knowledge_contributions SET head_commit",
									)
								: query.startsWith(
										"UPDATE knowledge_contributions SET state = 'closed'",
									);
					if (armed && targeted) {
						metadataCalls++;
						metadataBranch = String(
							(await unsafe("SELECT active_branch() AS branch"))[0]?.branch,
						);
						metadataBase = String(
							(await unsafe("SELECT dolt_hashof('HEAD') AS hash"))[0]?.hash,
						);
						const rows = await unsafe(query);
						if (!pending) {
							pending = unsafe("SELECT pg_sleep(2)").then(() => {
								nativeSettled = true;
								return rows;
							});
							return pending;
						}
						return rows;
					}
					return unsafe(query);
				}) as typeof session.unsafe;
				return session;
			}) as typeof writer.reserve;
			const createInput = {
				principal,
				message: "Historical metadata intent",
				edits: [
					{
						op: "insert" as const,
						entry: {
							id: rowId,
							domain,
							title: "Historical entry",
							content: "Keep committed content",
						},
					},
				],
			};
			try {
				await store.registerDomain({
					id: domain,
					name: "Native metadata proof",
				});
				if (stage !== "create") seed = await contributions.create(createInput);
				armed = true;
				const outcome = await (
					stage === "create"
						? contributions.create(createInput)
						: stage === "close"
							? contributions.close({
									contributionId: seed!.contributionId,
									principal,
									reason: "Finite close metadata",
								})
							: contributions.appendCommit({
									contributionId: seed!.contributionId,
									principal,
									message: "Persisted append metadata",
									edits: [
										{
											op: "patch",
											targetRowId: rowId,
											entry: { useWhen: "historical committed append" },
										},
									],
								})
				).catch((error) => error);
				expect(outcome).toMatchObject({
					name: "KnowledgeWriteOutcomeUnknownError",
					retryable: false,
					receipt: { lookup: { branch: expect.stringMatching(/^dolt-op\//) } },
				});
				expect(metadataBranch).toMatch(/^dolt-op\//);
				expect(metadataCalls).toBe(1);
				expect(resets).toBe(0);
				expect(nativeSettled).toBe(false);
				await competitor.unsafe("SELECT 1");
				rival = await competitor.reserve();
				const session = rival;
				await expect
					.poll(
						async () => {
							try {
								const guard = await acquireDoltWriterLocks(session, {
									protocol: "database",
									lockWaitMs: 0,
								});
								earlyAdmission ||= !nativeSettled;
								await guard.release();
								return true;
							} catch {
								return false;
							}
						},
						{ timeout: 5000 },
					)
					.toBe(true);
				expect(earlyAdmission).toBe(false);
				expect(nativeSettled).toBe(true);
				expect(resets).toBe(1);
				expect(metadataCalls).toBe(1);
				await expect(
					writer.unsafe("SELECT active_branch() AS branch"),
				).resolves.toEqual([{ branch: "main" }]);
				await expect(
					writer.unsafe("SELECT * FROM dolt.status"),
				).resolves.toHaveLength(0);
				await expect(
					reader.unsafe(
						`SELECT state, head_commit, commit_count FROM knowledge_contributions WHERE branch = '${branch}'`,
					),
				).resolves.toEqual(
					stage === "create"
						? []
						: [
								{
									state: "open",
									head_commit: seed!.headCommit,
									commit_count: 1,
								},
							],
				);
				const guard = await acquireDoltWriterLocks(session, {
					protocol: "database",
					lockWaitMs: 0,
				});
				try {
					await session.unsafe(`SELECT dolt_checkout('${metadataBranch}')`);
					await expect(
						session.unsafe("SELECT dolt_hashof('HEAD') AS hash"),
					).resolves.toEqual([{ hash: metadataBase }]);
					await expect(
						session.unsafe("SELECT * FROM dolt.status"),
					).resolves.toHaveLength(0);
					await session.unsafe(`SELECT dolt_checkout('${branch}')`);
					const hash = String(
						(await session.unsafe("SELECT dolt_hashof('HEAD') AS hash"))[0]
							?.hash,
					);
					expect(hash).toMatch(/^[a-z0-9]{32}$/);
					if (stage === "append") expect(hash).not.toBe(seed!.headCommit);
					if (stage === "close") expect(hash).toBe(seed!.headCommit);
					await expect(
						session.unsafe(
							`SELECT content, use_when FROM knowledge WHERE id = '${rowId}'`,
						),
					).resolves.toEqual([
						{
							content: "Keep committed content",
							use_when:
								stage === "append" ? "historical committed append" : null,
						},
					]);
					await session.unsafe("SELECT dolt_checkout('main')");
				} finally {
					await guard.release();
				}
				rival.release();
				rival = undefined;
				if (stage === "append") {
					await expect(
						contributions.appendCommit({
							contributionId: seed!.contributionId,
							principal,
							message: "Inspect before replay",
							edits: [
								{
									op: "patch",
									targetRowId: rowId,
									entry: { useWhen: "must not replay" },
								},
							],
						}),
					).rejects.toMatchObject({ name: "ContributionConflictError" });
					expect(edits).toBe(1);
					expect(metadataCalls).toBe(1);
				}
				armed = false;
				fresh = await contributions.create({
					principal,
					message: "Distinct fresh intent after settlement",
				});
				expect(fresh.state).toBe("open");
				expect(metadataCalls).toBe(1);
			} finally {
				await pending?.catch(() => undefined);
				rival?.release();
				armed = false;
				for (const contribution of [seed, fresh])
					if (contribution)
						await contributions
							.close({
								contributionId: contribution.contributionId,
								principal,
								reason: "Native metadata proof cleanup",
							})
							.catch(() => undefined);
				// A create whose metadata never landed retains its historical branch as
				// an inspection receipt; no automatic reset/deletion of that evidence.
				await Promise.allSettled(
					[writer, reader, competitor].map((client) =>
						client.end({ timeout: 0 }),
					),
				);
			}
		},
		15000,
	);
});
