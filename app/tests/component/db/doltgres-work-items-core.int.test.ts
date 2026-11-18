// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO


/**
 * Real Doltgres 0.57.3 acceptance for the work-item read paths and the core mutation flow:
 * summary projection, keyset paging, branch-versioned create/patch, metric rule resolution.
 *
 * node-template owns `@cogni/work-items`' Doltgres adapter, so the real-engine proof belongs here
 * rather than only in a fork (task.5199). Fake-SQL unit tests cannot see Dolt branch semantics;
 * bug.5358 shipped green against them.
 *
 * The acceptance suite is split across doltgres-work-items-*.int.test.ts files so the lane runs them
 * in parallel, one container each (task.0138). Each file is independent of every other.
 */

import {
	toWorkItemId,
	normalizeWorkItemOrder,
	WORK_ITEM_SORT_DIRECTIONS,
	WORK_TEXT_SCAN_MAX_ROWS,
} from "@cogni/work-items";
import { acquireDoltWriterLocks } from "@cogni-dao/doltgres-admission";
import postgres, { type Sql } from "postgres";
import { createDoltgresEntryResolver } from "@cogni/knowledge-store/adapters/doltgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DoltgresWorkItemAdapter,
	WorkItemRevisionConflictError,
	WorkItemsBusyError,
} from "@cogni/work-items/adapters/doltgres";
import {
	DOLTGRES_IMAGE,
	commitSummarySeed,
	literal,
	startWorkItemsDoltgres,
	stageLogger,
	summaryDatabase as summaryDatabaseFor,
	verifySummarySeed,
} from "./doltgres-work-items.fixture";

describe("Doltgres 0.57.3 work-item acceptance: summaries, paging and adapter core", () => {
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

	const summaryDatabase = (suffix: "precision" | "growth" | "board") =>
		summaryDatabaseFor(dbUrl, suffix);

	it("proves summary projection and native keyset traversal", async () => {
		const url = await summaryDatabase("precision");
		const writer = postgres(url, { max: 1, fetch_types: false });
		const reader = postgres(url, { max: 1, fetch_types: false });
		const observations: { query: string; bytes: number; elapsedMs: number; keys: string[] }[] = [];
		const originalUnsafe = reader.unsafe.bind(reader);
		reader.unsafe = ((query: string) => {
			const start = performance.now();
			return originalUnsafe(query).then((rows) => {
				observations.push({ query, bytes: Buffer.byteLength(JSON.stringify(rows)), elapsedMs: performance.now() - start, keys: Object.keys(rows[0] ?? {}) });
				return rows;
			});
		}) as typeof reader.unsafe;
		const adapter = new DoltgresWorkItemAdapter(writer, { readClient: reader, readConnectionBudget: 2, queryTimeoutMs: 5000, logger: stageLogger });
		const large = "x".repeat(32000);
		try {
			// IDs oppose timestamp order, with ties and adjacent microseconds.
			const fixtures = [
				["task.910005", "123456", "needle"], ["task.910006", "123456", "needle"],
				["task.910003", "123457", "needle"], ["task.910004", "123457", "needle"],
				["task.910001", "123458", "needle"], ["task.910002", "123458", "needle"],
			] as const;
			for (const [id, micros, summary] of fixtures) {
				const stamp = literal(`2026-10-26 00:00:00.${micros}+00`);
				await writer.unsafe(`INSERT INTO work_items (id,type,title,status,node,project_id,summary,outcome,external_refs,spec_refs,labels,created_at,updated_at)
				VALUES (${literal(id)},'task','summary fixture','needs_design','summary-native','proj.native',${literal(summary)},${literal(large)},${literal(JSON.stringify([{ url: `https://example.org/${large}` }]))}::jsonb,${literal(JSON.stringify([large]))}::jsonb,'["native-label"]'::jsonb,${stamp}::timestamptz,${stamp}::timestamptz)`);
			}
			await writer.unsafe("INSERT INTO work_items (id,type,title,status,node,project_id,summary) VALUES ('task.910007','task','decoy','needs_implement','summary-native','proj.other','needle')");
			const hash = await commitSummarySeed(writer);
			await verifySummarySeed(reader, fixtures.length + 1, hash);
			for (const sortBy of ["createdAt", "updatedAt"] as const) {
				for (const sortDirection of ["asc", "desc"] as const) {
					const expected = sortDirection === "asc" ? fixtures : [...fixtures.slice(4), ...fixtures.slice(2, 4), ...fixtures.slice(0, 2)];
					const seen: string[] = [];
					let cursor: string | undefined;
					do {
						const page = await adapter.listSummaries({ node: "summary-native", projectId: toWorkItemId("proj.native"), statuses: ["needs_design"], labels: ["native-label"], text: "needle", sortBy, sortDirection, limit: 1, ...(cursor ? { cursor } : {}) });
						seen.push(...page.items.map((item) => item.id));
						expect(seen.length).toBeLessThanOrEqual(fixtures.length);
						cursor = page.nextCursor;
					} while (cursor);
					expect(seen).toEqual(expected.map(([id]) => id));
				}
			}
			const start = observations.length;
			const page = await adapter.listSummaries({ node: "summary-native", sortBy: "projectId", limit: 1 });
			expect(page.nextCursor).toBeTruthy();
			await adapter.listSummaries({ node: "summary-native", sortBy: "projectId", limit: 1, cursor: page.nextCursor });
			const summaryQueries = observations.slice(start);
			expect(summaryQueries.some((o) => /^SELECT project_id FROM work_items/.test(o.query))).toBe(true);
			for (const o of summaryQueries) {
				expect(o.keys).not.toContain("outcome");
				expect(o.keys).not.toContain("external_refs");
				expect(o.keys).not.toContain("spec_refs");
			}
			expect(page.items[0]).not.toHaveProperty("outcome");
			expect(page.items[0]).not.toHaveProperty("externalRefs");
			const full = await adapter.list({ node: "summary-native", projectId: toWorkItemId("proj.native"), limit: 1 });
			expect(full.items[0]?.outcome).toBe(large);
			expect(full.items[0]?.specRefs).toEqual([large]);
			const query = summaryQueries.find((o) => o.query.includes("FROM (SELECT"))?.query;
			if (!query) throw new Error("summary query missing");
			const plan = await reader.unsafe(`EXPLAIN ${query}`);
			console.info("work_summary_native_plan", JSON.stringify({ image: DOLTGRES_IMAGE, plan }));
		} finally {
			await Promise.all([reader.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
		}
	});

	it("composes every board column in ONE native read with per-column cursor continuity", async () => {
		const url = await summaryDatabase("board");
		const writer = postgres(url, { max: 1, fetch_types: false });
		const reader = postgres(url, { max: 1, fetch_types: false });
		const issued: string[] = [];
		const originalUnsafe = reader.unsafe.bind(reader);
		reader.unsafe = ((query: string) => {
			issued.push(query);
			return originalUnsafe(query);
		}) as typeof reader.unsafe;
		const adapter = new DoltgresWorkItemAdapter(writer, { readClient: reader, readConnectionBudget: 2, queryTimeoutMs: 5000, logger: stageLogger });
		const statuses = ["needs_design", "needs_implement", "needs_merge", "done"] as const;
		const perStatus = { needs_design: 47, needs_implement: 23, needs_merge: 3, done: 0 } as const;
		try {
			const rows: string[] = [];
			for (const status of statuses) {
				for (let i = 0; i < perStatus[status]; i++) {
					// Ties, unscored (NULL rank) rows and long project ids exercise the
					// NULL-last order, id tie-break and the keyRef cursor path.
					const scored = i % 5 !== 0;
					const scores = scored
						? `'${JSON.stringify(Object.fromEntries(["goal", "time", "unblocks", "ease", "confidence", "agent"].map((axis) => [axis, { v: axis === "goal" ? 1 + (i % 5) : 3 }])))}'::JSONB`
						: "NULL";
					rows.push(`('task.${status.length}${String(i).padStart(4, "0")}${statuses.indexOf(status)}','task','board ${status} ${i}','${status}','board-native','proj.${String(i % 3).repeat(600)}',${scores})`);
				}
			}
			await writer.unsafe(`INSERT INTO work_items (id,type,title,status,node,project_id,scores) VALUES ${rows.join(",")}`);
			await writer.unsafe("INSERT INTO work_items (id,type,title,status,node) VALUES ('task.990001','task','decoy','needs_design','board-other')");
			const hash = await commitSummarySeed(writer);
			await verifySummarySeed(reader, rows.length + 1, hash);
			for (const order of [{}, { sortBy: "projectId" as const, sortDirection: "asc" as const }, { sortBy: "createdAt" as const, sortDirection: "desc" as const }]) {
				const filters = { node: "board-native", ...order };
				const before = issued.length;
				const startedAt = performance.now();
				const board = await adapter.listBoardColumns(filters, statuses, 20);
				const elapsedMs = performance.now() - startedAt;
				const boardQueries = issued.slice(before);
				expect(boardQueries).toHaveLength(1);
				expect(boardQueries[0]).toMatch(/^WITH board AS/);
				expect(board.queryCount).toBe(1);
				console.info("work_board_composed_native", JSON.stringify({ image: DOLTGRES_IMAGE, order: normalizeWorkItemOrder(filters), columns: statuses.length, rows: rows.length, elapsedMs, queries: boardQueries.length }));
				for (const [index, status] of statuses.entries()) {
					const column = board.columns[index];
					expect(column?.status).toBe(status);
					// Identical to the per-column read: items and cursor.
					const single = await adapter.listSummaries({ ...filters, statuses: [status], limit: 20 });
					expect(column?.items.map((item) => item.id), `${status} ${JSON.stringify(order)}`).toEqual(single.items.map((item) => item.id));
					expect(column?.pageInfo.hasMore).toBe(perStatus[status] > 20);
					expect(column?.pageInfo.endCursor ?? null).toBe(single.pageInfo.endCursor);
					// Load more through /summaries continues the column exactly once per row.
					const seen = [...(column?.items.map((item) => item.id) ?? [])];
					let cursor = column?.pageInfo.endCursor ?? undefined;
					for (let page = 0; cursor && page < 5; page++) {
						const next = await adapter.listSummaries({ ...filters, statuses: [status], limit: 20, cursor });
						seen.push(...next.items.map((item) => item.id));
						cursor = next.nextCursor;
					}
					expect(cursor).toBeUndefined();
					expect(new Set(seen).size).toBe(seen.length);
					expect(seen).toHaveLength(perStatus[status]);
					const full = await adapter.listSummaries({ ...filters, statuses: [status], limit: 100 });
					expect(seen).toEqual(full.items.map((item) => item.id));
				}
			}
			// Rank filters compose too (outer predicate on the derived key).
			const ranked = await adapter.listBoardColumns({ node: "board-native", rankMin: 2 }, statuses, 20);
			for (const [index, status] of statuses.entries()) {
				const single = await adapter.listSummaries({ node: "board-native", rankMin: 2, statuses: [status], limit: 20 });
				expect(ranked.columns[index]?.items.map((item) => item.id)).toEqual(single.items.map((item) => item.id));
				expect(ranked.columns[index]?.pageInfo.endCursor ?? null).toBe(single.pageInfo.endCursor);
			}
			// Plan capture is evidence only; an engine without EXPLAIN for CTEs must not fail the proof.
			const plan = await originalUnsafe(`EXPLAIN ${issued.find((query) => query.startsWith("WITH board AS"))}`).catch((error: unknown) => ({ explainError: String(error) }));
			console.info("work_board_composed_plan", JSON.stringify({ image: DOLTGRES_IMAGE, plan }));
		} finally {
			await Promise.all([reader.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
		}
	});

	it("observes summary growth on an isolated bounded-body backlog", async () => {
		const url = await summaryDatabase("growth");
		const writer = postgres(url, { max: 1, fetch_types: false });
		let seeded = 0;
		try {
			for (const size of [500, 5000, 50000]) {
				const seedStart = performance.now();
				while (seeded < size) {
					const count = Math.min(500, size - seeded);
					const values = Array.from({ length: count }, (_, i) => `('task.${1000000 + seeded + i}','task','growth fixture','needs_design','summary-growth','small bounded outcome','2026-10-26 00:00:00.123456+00','2026-10-26 00:00:00.123456+00')`).join(",");
					await writer.unsafe(`INSERT INTO work_items (id,type,title,status,node,outcome,created_at,updated_at) VALUES ${values}`);
					seeded += count;
				}
				const hash = await commitSummarySeed(writer);
				const seedElapsedMs = performance.now() - seedStart;
				// Fresh session per tier prevents retaining a pre-seed snapshot.
				const reader = postgres(url, { max: 1, fetch_types: false });
				try {
					await verifySummarySeed(reader, size, hash);
					const observations: { query: string; bytes: number; elapsedMs: number }[] = [];
					const originalUnsafe = reader.unsafe.bind(reader);
					reader.unsafe = ((query: string) => {
						const start = performance.now();
						return originalUnsafe(query).then((rows) => {
							observations.push({ query, bytes: Buffer.byteLength(JSON.stringify(rows)), elapsedMs: performance.now() - start });
							return rows;
						});
					}) as typeof reader.unsafe;
					const adapter = new DoltgresWorkItemAdapter(writer, { readClient: reader, readConnectionBudget: 2, queryTimeoutMs: 5000, logger: stageLogger });
					const start = performance.now();
					const page = await adapter.listSummaries({ node: "summary-growth", sortBy: "createdAt", limit: 10 });
					const elapsedMs = performance.now() - start;
					expect(page.items).toHaveLength(10);
					expect(page.pageInfo.hasMore).toBe(true);
					expect(observations).toHaveLength(1);
					expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
					const query = observations[0]?.query;
					if (!query) throw new Error("summary growth query missing");
					const plan = await originalUnsafe(`EXPLAIN ${query}`);
					console.info("work_summary_native_growth", JSON.stringify({ image: DOLTGRES_IMAGE, datasetN: size, seedElapsedMs, elapsedMs, queryCount: observations.length, nativeResultJsonBytes: observations.reduce((sum, read) => sum + read.bytes, 0), nativeQueries: observations, pageJsonBytes: Buffer.byteLength(JSON.stringify(page)), plan }));
				} finally {
					await reader.end({ timeout: 5 });
				}
			}
		} finally {
			await writer.end({ timeout: 5 });
		}
	}, 180_000);

	it("walks NOW-backed timestamp pages once in both directions", async () => {
		// NOW() stores nanoseconds on this engine, while its text I/O exposes
		// microseconds. Literal six-digit fixtures cannot catch that mismatch.
		const expected = [
			"task.290005",
			"task.290006",
			"task.290003",
			"task.290004",
			"task.290001",
			"task.290002",
		];
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const adapter = new DoltgresWorkItemAdapter(sql, {
			readClient: reader,
			readConnectionBudget: 2,
			queryTimeoutMs: 5000,
			logger: stageLogger,
		});
		try {
			for (let i = 0; i < expected.length; i += 2) {
				// Each statement has one NOW value. IDs deliberately oppose time;
				// each timestamp tie must still use id ASC in either direction.
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,created_at,updated_at) VALUES ('${expected[i]}','task','${i === 4 ? "needle" : "absent"}','needs_design','timestamp-native',NOW(),NOW()),('${expected[i + 1]}','task','${i === 4 ? "needle" : "absent"}','needs_design','timestamp-native',NOW(),NOW())`
				);
			}
			const precision = await sql.unsafe(
				"SELECT id, created_at > CAST(CAST(created_at AS TEXT) AS TIMESTAMP WITH TIME ZONE) AS hidden_created_nanoseconds, updated_at > CAST(CAST(updated_at AS TEXT) AS TIMESTAMP WITH TIME ZONE) AS hidden_updated_nanoseconds FROM work_items WHERE node='timestamp-native'"
			);
			expect(
				precision.some((row) => row.hidden_created_nanoseconds === true)
			).toBe(true);
			expect(
				precision.some((row) => row.hidden_updated_nanoseconds === true)
			).toBe(true);
			for (const sortBy of ["createdAt", "updatedAt"] as const) {
				for (const sortDirection of WORK_ITEM_SORT_DIRECTIONS) {
					const ordered =
						sortDirection === "asc"
							? expected
							: [
									...expected.slice(4, 6),
									...expected.slice(2, 4),
									...expected.slice(0, 2),
								];
					const seen: string[] = [];
					let cursor: string | undefined;
					do {
						const page = await adapter.list({
							node: "timestamp-native",
							sortBy,
							sortDirection,
							limit: 1,
							...(cursor ? { cursor } : {}),
						});
						for (const item of page.items) {
							expect(
								seen,
								`${sortBy} ${sortDirection}: repeated boundary`
							).not.toContain(item.id);
							seen.push(item.id);
						}
						expect(seen.length).toBeLessThanOrEqual(expected.length);
						cursor = page.nextCursor;
					} while (cursor);
					expect(seen, `${sortBy} ${sortDirection}`).toEqual(ordered);
					const textFirst = await adapter.list({
						node: "timestamp-native",
						sortBy,
						sortDirection,
						text: "needle",
						limit: 1,
					});
					expect(textFirst.items.map((item) => item.id)).toEqual([
						"task.290001",
					]);
					expect(textFirst.pageInfo.hasMore).toBe(true);
					if (!textFirst.nextCursor) throw new Error("missing text cursor");
					const textLast = await adapter.list({
						node: "timestamp-native",
						sortBy,
						sortDirection,
						text: "needle",
						limit: 1,
						cursor: textFirst.nextCursor,
					});
					expect(textLast.items.map((item) => item.id)).toEqual([
						"task.290002",
					]);
					expect(textLast.pageInfo.hasMore).toBe(false);
				}
			}
		} finally {
			await reader.end({ timeout: 5 });
			await sql.unsafe("DELETE FROM work_items WHERE node='timestamp-native'");
		}
	});

	it("filters bounded native pages against a 5000-row backlog", async () => {
		const readSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const issued: string[] = [];
		let lateStart: number | undefined;
		const unsafe = readSql.unsafe.bind(readSql);
		readSql.unsafe = ((query: string) => {
			issued.push(query);
			if (lateStart !== undefined)
				console.info("rank_query_late_text_batch", JSON.stringify({ batch: issued.length, elapsedMs: performance.now() - lateStart }));
			return unsafe(query);
		}) as typeof readSql.unsafe;
		try {
			// Add a known filtered shelf to the 5,000-row native backlog. Rank 15
			// and rank 10 sit exactly on the two bounds; decoys isolate each filter.
			const scoresFor = (time: number, unblocks: number) =>
				JSON.stringify(
					Object.fromEntries(
						Object.entries({
							goal: 5,
							time,
							unblocks,
							ease: 5,
							confidence: 5,
							agent: 5,
						}).map(([axis, v]) => [axis, { v }]),
					),
				);
			const high = scoresFor(5, 5); // 15
			const low = scoresFor(4, 1); // 10
			const below = scoresFor(3, 1); // 9
			const matchingIds = Array.from(
				{ length: 21 },
				(_, i) => `task.${300000 + i}`,
			);
			const rows = matchingIds.map(
				(id, i) =>
					`('${id}','task','scale needle','needs_implement','scale-native','proj.${i % 2 ? "beta" : "alpha"}','${i < 10 ? high : low}'::JSONB)`,
			);
			rows.push(
				`('task.300021','task','scale needle','needs_implement','scale-native','proj.alpha','${below}'::JSONB)`,
				`('task.300022','task','scale needle','needs_implement','scale-native','proj.alpha',NULL)`,
				`('task.300023','task','scale needle','needs_implement','scale-native','proj.other','${high}'::JSONB)`,
				`('task.300024','bug','scale needle','needs_implement','scale-native','proj.alpha','${high}'::JSONB)`,
				`('task.300025','task','scale needle','needs_design','scale-native','proj.alpha','${high}'::JSONB)`,
				`('task.300026','task','scale absent','needs_implement','scale-native','proj.alpha','${high}'::JSONB)`,
			);
			for (let i = 27; i < 5000; i++)
				rows.push(
					`('task.${300000 + i}','task','${i === 4999 ? "last-only-needle" : "filler"}','needs_implement','scale-native','proj.other','${high}'::JSONB)`,
				);
			for (let offset = 0; offset < rows.length; offset += 250)
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,project_id,scores) VALUES ${rows.slice(offset, offset + 250).join(",")}`,
				);
			const filteredAdapter = new DoltgresWorkItemAdapter(sql, {
				readClient: readSql,
				readConnectionBudget: 2,
				queryTimeoutMs: 5000,
				logger: stageLogger,
			});
			const broad = { node: "scale-native", statuses: ["needs_implement"] as const, rankMin: 4, limit: 10 };
			// TEXT_SCAN_BOUNDED (task.0055): one request scans at most
			// WORK_TEXT_SCAN_MAX_ROWS rows; sparse matches arrive through
			// continuation pages (an empty page with a cursor is progress).
			const pages: Awaited<ReturnType<typeof filteredAdapter.list>>[] = [];
			let cursor: string | undefined;
			let lateElapsed = 0;
			for (let request = 0; request < 6; request++) {
				const callStart = issued.length;
				lateStart = performance.now();
				let page: Awaited<ReturnType<typeof filteredAdapter.list>>;
				try {
					page = await filteredAdapter.list({ ...broad, text: "LAST-ONLY-NEEDLE", ...(cursor && { cursor }) });
				} finally {
					const elapsed = performance.now() - lateStart;
					lateElapsed = Math.max(lateElapsed, elapsed);
					console.info("rank_query_late_text_phase", JSON.stringify({ request, elapsedMs: elapsed, datasetN: 5000, queriesStarted: issued.length - callStart, order: normalizeWorkItemOrder(broad) }));
					lateStart = undefined;
				}
				pages.push(page);
				const limits = issued.slice(callStart).map((query) => Number(query.match(/ LIMIT (\d+)$/)?.[1]));
				for (const nativeLimit of limits) {
					expect(nativeLimit).toBeGreaterThan(0);
					expect(nativeLimit).toBeLessThanOrEqual(501);
				}
				expect(page.pageInfo.rowsScanned).toBeLessThanOrEqual(WORK_TEXT_SCAN_MAX_ROWS);
				if (!page.pageInfo.hasMore) break;
				expect(page.pageInfo.endCursor).toEqual(expect.any(String));
				cursor = page.pageInfo.endCursor ?? undefined;
			}
			expect(pages[0]?.items).toEqual([]);
			expect(pages[0]?.pageInfo).toMatchObject({ hasMore: true, rowsScanned: WORK_TEXT_SCAN_MAX_ROWS });
			const late = pages.at(-1) as (typeof pages)[number];
			expect(pages.flatMap((page) => page.items.map((item) => item.id))).toEqual(["task.304999"]);
			expect(late.pageInfo.hasMore).toBe(false);
			expect(late.nextCursor).toBeUndefined();
			expect(lateElapsed).toBeLessThan(5000);
			expect(issued.length).toBeGreaterThan(1);
			console.info("rank_query_late_text", JSON.stringify({ maxRequestMs: lateElapsed, datasetN: 5000, queries: issued.length, requests: pages.length, resultCount: 1 }));
			const broadFirst = await filteredAdapter.list(broad);
			expect(broadFirst.items.map((item) => item.id)).toEqual(matchingIds.slice(0, 10));
			if (!broadFirst.nextCursor) throw new Error("missing broad cursor");
			const broadNext = await filteredAdapter.list({ ...broad, cursor: broadFirst.nextCursor });
			expect(broadNext.items).toHaveLength(10);
			expect(broadNext.items.every((item) => !broadFirst.items.some((first) => first.id === item.id))).toBe(true);
			await sql.unsafe(`UPDATE work_items SET labels='["area:web", "goal:work", "part,one"]'::JSONB WHERE id='task.300000'`);
			const labelFilter = { node: "scale-native", projectIds: [toWorkItemId("proj.alpha")], limit: 10 };
			expect((await filteredAdapter.list({ ...labelFilter, text: "part,one" })).items.map((item) => item.id)).toEqual(["task.300000"]);
			expect((await filteredAdapter.list({ ...labelFilter, text: "web,goal" })).items).toHaveLength(0);
			expect((await filteredAdapter.list({ ...labelFilter, text: "task.300000" })).items.map((item) => item.id)).toEqual(["task.300000"]);
			const filter = {
				node: "scale-native",
				types: ["task"] as const,
				statuses: ["needs_implement"] as const,
				projectIds: [toWorkItemId("proj.alpha"), toWorkItemId("proj.beta")],
				text: "scale needle",
				rankMin: 10,
				rankMax: 15,
				limit: 10,
			};
			const page1 = await filteredAdapter.list(filter);
			if (!page1.nextCursor) throw new Error("missing first scale cursor");
			const page2 = await filteredAdapter.list({
				...filter,
				cursor: page1.nextCursor,
			});
			if (!page2.nextCursor) throw new Error("missing second scale cursor");
			const page3 = await filteredAdapter.list({
				...filter,
				cursor: page2.nextCursor,
			});
			expect(page1.items.map((item) => item.id)).toEqual(
				matchingIds.slice(0, 10),
			);
			expect(page2.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10, 20),
			);
			expect(page3.items.map((item) => item.id)).toEqual(matchingIds.slice(20));
			expect([
				page1.pageInfo.hasMore,
				page2.pageInfo.hasMore,
				page3.pageInfo.hasMore,
			]).toEqual([true, true, false]);
			const back = await filteredAdapter.list({
				...filter,
				cursor: page1.nextCursor,
			});
			expect(back.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10, 20),
			);
			const exactHigh = await filteredAdapter.list({
				...filter,
				rankMin: 15,
				rankMax: 15,
				limit: 50,
			});
			const exactLow = await filteredAdapter.list({
				...filter,
				rankMin: 10,
				rankMax: 10,
				limit: 50,
			});
			expect(exactHigh.items.map((item) => item.id)).toEqual(
				matchingIds.slice(0, 10),
			);
			expect(exactLow.items.map((item) => item.id)).toEqual(
				matchingIds.slice(10),
			);
			const unbounded = await filteredAdapter.list({
				...filter,
				rankMin: undefined,
				rankMax: undefined,
				limit: 50,
			});
			expect(unbounded.items.map((item) => item.id)).toEqual([
				...matchingIds,
				"task.300021",
				"task.300022",
			]);
			for (const changed of [
				{ rankMin: 11 },
				{ rankMax: 14 },
				{ projectIds: [toWorkItemId("proj.alpha")] },
				{ statuses: ["needs_design"] as const },
				{ text: "scale absent" },
			])
				await expect(
					filteredAdapter.list({
						...filter,
						...changed,
						cursor: page1.nextCursor,
					}),
				).rejects.toMatchObject({ name: "InvalidCursorError" });
		} finally {
			try {
				await readSql.end({ timeout: 5 });
			} finally {
				await sql.unsafe("DELETE FROM work_items WHERE node='scale-native'");
			}
		}
	});

	it.each([
		"native",
		"admission",
	] as const)("expires a sparse text list across batches including %s waiting without partial success", async (mode) => {
		const writer = postgres(dbUrl, { max: 1, fetch_types: false });
		const reader = postgres(dbUrl, { max: 1, fetch_types: false });
		const unsafe = reader.unsafe.bind(reader);
		const end = reader.end.bind(reader);
		const native: Promise<unknown>[] = [];
		let batches = 0,
			ended = 0,
			settled = 0;
		let signalFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			signalFirst = resolve;
		});
		reader.unsafe = ((query: string) => {
			const isList = query.includes("node IN ('deadline-native')");
			if (isList) {
				batches++;
				signalFirst();
			}
			const delay = isList ? (batches === 1 ? 0.15 : 0.7) : 0.7;
			// Execute the actual adapter query; real native pg_sleep delays its settlement.
			// The result includes a match on batch 1, so a timeout must discard it.
			const pending = (async () => {
				const rows = await unsafe(query);
				await unsafe(`SELECT pg_sleep(${delay}) /* rank_text_deadline_probe */`);
				return rows;
			})().finally(() => {
				settled++;
			});
			native.push(pending);
			return pending;
		}) as typeof reader.unsafe;
		reader.end = (async (options) => {
			ended++;
			await end(options);
		}) as typeof reader.end;
		try {
			await sql.unsafe(
				`INSERT INTO work_items (id,type,title,status,node) VALUES ${Array.from({ length: 503 }, (_, i) => `('task.${300000 + i}','task','${i === 0 || i === 502 ? "needle" : "absent"}','needs_design','deadline-native')`).join(",")}`,
			);
			const adapter = new DoltgresWorkItemAdapter(writer, {
				readClient: reader,
				readConnectionBudget: 2,
				queryTimeoutMs: 500,
			});
			const list = adapter.list({
				node: "deadline-native",
				text: "needle",
				limit: 1,
			});
			const rejected = expect(list).rejects.toBeInstanceOf(WorkItemsBusyError);
			await firstStarted;
			const queued =
				mode === "admission"
					? adapter.get(toWorkItemId("task.300000")).catch((error) => error)
					: undefined;
			await rejected;
			expect(batches).toBe(mode === "native" ? 2 : 1);
			expect(ended).toBe(0); // A pending native operation retains its generation.
			const captured = batches;
			await Promise.allSettled(native);
			await queued;
			expect(settled).toBe(native.length);
			expect(batches).toBe(captured); // No later text batch dispatch after expiry.
			await expect.poll(() => ended).toBe(1);
			console.info(
				"rank_query_text_deadline",
				JSON.stringify({
					image: DOLTGRES_IMAGE,
					mode,
					batches,
					settled,
					ended,
					queryTimeoutMs: 500,
				}),
			);
		} finally {
			await Promise.allSettled(native);
			await Promise.allSettled([writer.end({ timeout: 5 }), end({ timeout: 5 })]);
			await sql.unsafe("DELETE FROM work_items WHERE node='deadline-native'");
		}
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
		const createAdapter = () =>
			new DoltgresWorkItemAdapter(sql, {
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
		let adapter = createAdapter();
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
			{ reason: "test change", id, set: { title: "Doltgres accepted" } },
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
				adapter.patch({ reason: "test change", id, set: { title: "blocked" } }, principalId),
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
				adapter.patch({ reason: "test change", id, set: { title: "scoped blocked" } }, principalId),
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
		const oldPid = Number(
			(await oldPool.unsafe("SELECT pg_backend_pid() AS pid"))[0]?.pid,
		);
		const lockHolder = createWorkItemClient();
		try {
			await lockHolder.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedQuery = oldPool.unsafe("SELECT pg_advisory_lock(9501002)");
			const blockedResult = blockedQuery.then(
				() => undefined,
				(error) => error,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			// Only a write can observe this write-pool transport loss. It must
			// quarantine its native capacity while the independent reader serves.
			const recoveryAttempt = adapter.patch(
				{ reason: "test change", id, set: { title: "pool death" } },
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
		// bug.0042: the adapter's own probe never reached the server — it queued
		// behind a foreign statement when the pool died — so it owns no native
		// state. The failure stays retryable and nothing is held; the adapter
		// replaced its writer pool, so the very next write is admitted.
		expect(adapter.writerHealth()).toEqual({ state: "available" });
		await expect(
			adapter.patch({ reason: "test change", id, set: { title: "fresh writer" } }, principalId),
		).resolves.toMatchObject({ id, title: "fresh writer" });
		// The test still waits for the old native session to depart before it
		// rebuilds the adapter for the remaining scenarios.
		await expect
			.poll(
				async () =>
					(
						await readSql.unsafe(
							`SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid = ${oldPid}`,
						)
					).length,
				{ timeout: 3_000 },
			)
			.toBe(0);
		sql = createWorkItemClient();
		adapter = createAdapter();

		// Reads kept serving throughout — including while the write pool was
		// dead, which is the bug.5358 guarantee.
		await expect(adapter.get(id)).resolves.toMatchObject({ id });
		// ...and an explicit replacement after native absence sweeps the
		// orphan branch. Sweeping is a branch mutation, so it belongs to the
		// write plane (COMMAND_QUERY_SEPARATION); a read used to do it here only
		// because a read used to take the write lock.
		await expect(
			adapter.patch({ reason: "test change", id, set: { title: "Doltgres accepted" } }, principalId),
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
		await adapter.patch({ reason: "test change", id, set: { status: "cancelled" } }, principalId);
		await adapter.patch(
			{ reason: "test change", id: searchId, set: { status: "cancelled" } },
			principalId,
		);
		await expect(adapter.get(id)).resolves.toMatchObject({
			id,
			status: "cancelled",
		});
		await readSql.end({ timeout: 0 });
	}, 60_000);

	// task.5284 (story.5096): `patch` honors `expectedRevision` as a real
	// compare-and-set. Since bug.0019 the adapter does not gate on creator
	// equality: any principal the door admitted may patch any field, and the
	// creator column stays unchanged. Refusals leave `main` untouched.
	it("compare-and-sets patch on expectedRevision and admits a non-creator principal on any field", async () => {
		const casSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const casReadSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const adapter = new DoltgresWorkItemAdapter(casSql, {
			readClient: casReadSql,
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
		});
		const id = toWorkItemId("task.9503");
		const creator = "doltgres-cas-creator";
		const collaborator = "doltgres-cas-collaborator";
		const mainHash = async () =>
			String(
				(await casSql.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash ?? "",
			);
		try {
			const created = await adapter.create(
				{ id, type: "task", title: "CAS me", priority: 3, rank: 9 },
				creator,
			);
			// Matching expectedRevision lands and bumps the revision by one.
			const casPatched = await adapter.patch(
				{ reason: "test change", id, expectedRevision: created.revision, set: { title: "CAS landed" } },
				creator,
			);
			expect(casPatched).toMatchObject({
				id,
				title: "CAS landed",
				revision: created.revision + 1,
			});

			// Stale expectedRevision: conflict, nothing written.
			const beforeStale = await mainHash();
			await expect(
				adapter.patch(
					{ reason: "test change", id, expectedRevision: created.revision, set: { title: "stale" } },
					creator,
				),
			).rejects.toBeInstanceOf(WorkItemRevisionConflictError);
			expect(await mainHash()).toBe(beforeStale);
			await expect(adapter.get(id)).resolves.toMatchObject({
				title: "CAS landed",
				revision: casPatched.revision,
			});

			// A non-creator may set the triage fields, attributed to itself.
			const triaged = await adapter.patch(
				{
					reason: "test change",
					id,
					expectedRevision: casPatched.revision,
					set: { priority: 0, rank: 1, labels: ["triaged"] },
				},
				collaborator,
			);
			expect(triaged).toMatchObject({
				priority: 0,
				rank: 1,
				labels: ["triaged"],
				revision: casPatched.revision + 1,
			});
			await expect(
				casSql.unsafe(
					`SELECT commit_hash FROM dolt.commits WHERE message = 'work-items: patch ${id} by actor:${collaborator}\nReason: test change'`,
				),
			).resolves.toHaveLength(1);

			// ...and so may a non-creator naming any other field (bug.0019): the
			// door's authorize() decided; the creator stays attribution.
			await expect(
				adapter.patch(
					{ reason: "test change", id, set: { priority: 5, title: "renamed by collaborator" } },
					collaborator,
				),
			).resolves.toMatchObject({
				priority: 5,
				title: "renamed by collaborator",
				revision: triaged.revision + 1,
			});

			// The creator's unconditioned patch is unchanged.
			await expect(
				adapter.patch({ reason: "test change", id, set: { title: "creator unconditioned" } }, creator),
			).resolves.toMatchObject({
				title: "creator unconditioned",
				revision: triaged.revision + 2,
			});
			await expect(
				casSql.unsafe(
					"SELECT name FROM dolt.branches WHERE name LIKE 'work-item-op/%'",
				),
			).resolves.toHaveLength(0);
		} finally {
			await casReadSql.end({ timeout: 0 });
			await casSql.end({ timeout: 0 });
		}
	}, 60_000);

	it("stores moves with a baseline pinned once, through the real work_items column (story.0033)", async () => {
		const movesSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const movesReadSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const OBS_1 = "11111111-1111-4111-8111-111111111111";
		const OBS_2 = "22222222-2222-4222-8222-222222222222";
		const observations = [OBS_1, OBS_2];
		const baselineCalls: string[] = [];
		const adapter = new DoltgresWorkItemAdapter(movesSql, {
			readClient: movesReadSql,
			logger: stageLogger,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
			entryResolver: {
				resolve: async (refs, rule) => {
					expect(rule).toBe("metric");
					return refs.map((ref) => ({
						id: ref.id,
						commit: "a".repeat(32),
						plane: "main" as const,
					}));
				},
			},
			metricBaseline: {
				latestObservationId: async (metricId) => {
					baselineCalls.push(metricId);
					return observations.shift() ?? null;
				},
			},
		});
		const id = toWorkItemId("task.9507");
		const principal = "doltgres-moves-writer";
		try {
			await adapter.create({ id, type: "task", title: "Move a metric" }, principal);
			await expect(adapter.get(id)).resolves.not.toHaveProperty("moves");

			const first = await adapter.patch(
				{
					id,
					reason: "this change should raise the ratio",
					set: { moves: [{ metricId: "convergence-ratio", direction: "up" }] },
				},
				principal,
			);
			expect(first.moves).toEqual([
				{ metricId: "convergence-ratio", direction: "up", baselineObservationId: OBS_1 },
			]);
			await expect(adapter.get(id)).resolves.toMatchObject({ moves: first.moves });

			// A direction change keeps the pinned baseline; no new baseline read.
			const second = await adapter.patch(
				{
					id,
					reason: "direction corrected",
					set: { moves: [{ metricId: "convergence-ratio", direction: "down" }] },
				},
				principal,
			);
			expect(second.moves).toEqual([
				{ metricId: "convergence-ratio", direction: "down", baselineObservationId: OBS_1 },
			]);
			expect(baselineCalls).toEqual(["convergence-ratio"]);

			// [] clears it; adding the metric back pins a new baseline.
			await expect(
				adapter.patch({ id, reason: "moves nothing after all", set: { moves: [] } }, principal),
			).resolves.toMatchObject({ moves: [] });
			const third = await adapter.patch(
				{
					id,
					reason: "moves it again",
					set: { moves: [{ metricId: "convergence-ratio", direction: "up" }] },
				},
				principal,
			);
			expect(third.moves).toEqual([
				{ metricId: "convergence-ratio", direction: "up", baselineObservationId: OBS_2 },
			]);
			// A create names its metric when it is filed: validated, baselined once (none left: null), stored.
			const filedId = toWorkItemId("task.9508");
			const filed = await adapter.create(
				{
					id: filedId,
					type: "task",
					title: "Filed with a metric",
					moves: [{ metricId: "deploy-first-try-7d", direction: "up" }],
				},
				principal,
			);
			expect(filed.moves).toEqual([
				{ metricId: "deploy-first-try-7d", direction: "up", baselineObservationId: null },
			]);
			await expect(adapter.get(filedId)).resolves.toMatchObject({ moves: filed.moves });
			await expect(
				movesSql.unsafe("SELECT name FROM dolt.branches WHERE name LIKE 'work-item-op/%'"),
			).resolves.toHaveLength(0);
		} finally {
			await movesReadSql.end({ timeout: 0 });
			await movesSql.end({ timeout: 0 });
		}
	}, 60_000);

	it("resolves the metric rule on real Doltgres: main only, AS OF a pinned hash, spec present and not deprecated (story.0033)", async () => {
		const ksSql = postgres(dbUrl, { max: 1, fetch_types: false });
		try {
			const row = (id: string, status: string, spec: string | null) =>
				`(${literal(id)}, 'strategy', ${literal(id)}, 'body', 'guide', 'agent', ${literal(status)}, ${
					spec === null ? "NULL" : `${literal(spec)}::jsonb`
				})`;
			await ksSql.unsafe(
				`INSERT INTO knowledge (id, domain, title, content, entry_type, source_type, status, metric_spec) VALUES ${[
					row("moves-live-metric", "established", '{"calculatorId":"work.count@1"}'),
					row("moves-draft-metric", "draft", '{"calculatorId":"work.count@1"}'),
					row("moves-old-metric", "deprecated", '{"calculatorId":"work.count@1"}'),
					row("moves-plain-atom", "established", null),
				].join(", ")}`,
			);
			await ksSql.unsafe("SELECT dolt_add('knowledge')");
			await ksSql.unsafe("SELECT dolt_commit('-m', 'metric rule fixtures')");
			const mainHash = String(
				(await ksSql.unsafe("SELECT dolt_hashof('main') AS hash"))[0]?.hash ?? "",
			);
			const resolver = createDoltgresEntryResolver(ksSql);
			const signal = new AbortController().signal;

			await expect(
				resolver.resolve(
					[{ id: "moves-live-metric" }, { id: "moves-draft-metric" }],
					"metric",
					signal,
				),
			).resolves.toEqual([
				{ id: "moves-live-metric", commit: mainHash, plane: "main" },
				{ id: "moves-draft-metric", commit: mainHash, plane: "main" },
			]);
			// No spec, deprecated and absent all read as unresolved, by id.
			const refused = resolver.resolve(
				[
					{ id: "moves-live-metric" },
					{ id: "moves-plain-atom" },
					{ id: "moves-old-metric" },
					{ id: "moves-ghost" },
				],
				"metric",
				signal,
			);
			await expect(refused).rejects.toMatchObject({
				name: "EntryUnresolvedError",
				ids: ["moves-plain-atom", "moves-old-metric", "moves-ghost"],
			});
			// The same atom still resolves under the cite rule: only the metric rule needs a spec.
			await expect(
				resolver.resolve([{ id: "moves-plain-atom" }], "cite", signal),
			).resolves.toHaveLength(1);
		} finally {
			await ksSql.end({ timeout: 0 });
		}
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
						reason: "test change",
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
					.patch({ reason: "test change", id, set: { status: "cancelled" } }, principalId)
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
});
