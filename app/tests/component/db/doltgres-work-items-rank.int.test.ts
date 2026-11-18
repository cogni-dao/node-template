// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO


/**
 * Real Doltgres 0.57.3: the rank policy SQL against every valid 5^6 score combination, global
 * ranking before the page limit, and a full 15625-row traversal. Its own file because it is the
 * one long seeded dataset in the work-item acceptance (task.0138).
 */

import {
	rankScore,
	compareWorkItems,
	normalizeWorkItemOrder,
	WORK_ITEM_SORT_FIELDS,
	WORK_ITEM_SORT_DIRECTIONS,
	type WorkItem,
} from "@cogni/work-items";
import { rankScoreSql } from "../../../../packages/work-items/src/rank-policy";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
import {
	DOLTGRES_IMAGE,
	startWorkItemsDoltgres,
	stageLogger,
} from "./doltgres-work-items.fixture";

describe("Doltgres 0.57.3 work-item acceptance: native rank at 15625 rows", () => {
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

	it("globally ranks native JSON before limiting, roundtrips every order, and measures plans at 15625 rows", async () => {
		const fixtures: {
			id: string;
			scores: Record<string, { v: number; ev?: string }> | null;
		}[] = [];
		for (let goal = 1; goal <= 5; goal++)
			for (let time = 1; time <= 5; time++)
				for (let unblocks = 1; unblocks <= 5; unblocks++)
					for (let ease = 1; ease <= 5; ease++)
						for (let confidence = 1; confidence <= 5; confidence++)
							for (let agent = 1; agent <= 5; agent++) {
								fixtures.push({
									id: `task.${100000 + fixtures.length}`,
									scores: Object.fromEntries(
										Object.entries({
											goal,
											time,
											unblocks,
											ease,
											confidence,
											agent,
										}).map(([axis, v]) => [
											axis,
											{ v, ev: "https://example.org/native-fixture" },
										]),
									),
								});
							}
		try {
		// Bounded seed batches, not 15625 version-control branch mutations.
		for (let offset = 0; offset < fixtures.length; offset += 250) {
			const batch = fixtures.slice(offset, offset + 250);
			await sql.unsafe(
				`INSERT INTO work_items (id,type,title,status,node,priority,rank,scores,created_at,updated_at) VALUES ${batch.map((f, i) => `('${f.id}','task','native rank ${f.id}','needs_implement','rank-native',${offset + i < 500 ? 0 : 4},${offset + i},'${JSON.stringify(f.scores)}'::JSONB,'2026-10-26 00:00:00.123456+00','2026-10-26 00:00:00.123456+00')`).join(",")}`,
			);
		}
		// Test the ACTUAL private policy emitter against native JSON, including every valid 5^6 combination.
		const values = await sql.unsafe(
			`SELECT id, ${rankScoreSql()} AS native_rank FROM work_items WHERE node='rank-native'`,
		);
		const expected = new Map(fixtures.map((f) => [f.id, rankScore(f.scores)]));
		for (const row of values)
			expect(Number(row.native_rank), String(row.id)).toBe(
				expected.get(String(row.id)),
			);
		expect(values).toHaveLength(15625);
		const invalids = [
			"null",
			"[]",
			"true",
			"{}",
			'{"goal":{"v":"5"}}',
			'{"goal":{"v":1e100},"agent":{"v":5}}',
		];
		const valid = fixtures[fixtures.length - 1]?.scores;
		if (!valid) throw new Error("valid fixture missing");
		for (const invalid of [0, 6, 1.5, "5", true, null, {}, []])
			invalids.push(JSON.stringify({ ...valid, goal: { v: invalid } }));
		for (const [i, json] of invalids.entries()) {
			const rows = await sql.unsafe(
				`SELECT ${rankScoreSql()} AS native_rank FROM (SELECT '${json}'::JSONB AS scores) AS historical`,
			);
			expect(rows[0]?.native_rank, `invalid fixture ${i}`).toBeNull();
		}
		// 1e1000 cannot exist in this engine's JSONB storage. Check that input
		// boundary separately rather than attributing its rejection to rank SQL.
		await expect(sql.unsafe(`SELECT '{"goal":{"v":1e1000},"agent":{"v":5}}'::JSONB`)).rejects.toThrow(/invalid input syntax for type json/);
		console.info("rank_query_native_parity", JSON.stringify({image:DOLTGRES_IMAGE,validCombinations:values.length,invalidFixtures:invalids.length,unrepresentableJsonRejected:true}));
		const queries: string[] = [];
		const readSql = postgres(dbUrl, { max: 1, fetch_types: false });
		const tracedRead = new Proxy(readSql, {
			get(target, key) {
				if (key === "unsafe")
					return (query: string) => {
						queries.push(query);
						return target.unsafe(query);
					};
				return Reflect.get(target, key);
			},
		});
		const adapter = new DoltgresWorkItemAdapter(sql, {
			readClient: tracedRead,
			readConnectionBudget: 2,
			queryTimeoutMs: 5000,
			logger: stageLogger,
		});
		try {
			const measured = async (mode: string, limit: number) => {
				const start = performance.now();
				const page = await adapter.list({ node: "rank-native", limit });
				const elapsedMs = performance.now() - start;
				console.info(
					"rank_query_native_measurement",
					JSON.stringify({
						image: DOLTGRES_IMAGE,
						datasetN: fixtures.length,
						mode,
						limit,
						elapsedMs,
						queryCount: queries.length,
					}),
				);
				expect(elapsedMs).toBeLessThan(5000);
				return page;
			};
			const firstAdapterRead = await measured("first-adapter-read-after-parity", 5);
			expect(firstAdapterRead.items.map((item) => rankScore(item.scores))).toEqual([
				15, 15, 15, 15, 15,
			]);
			const legacy = await sql.unsafe(
				"SELECT id FROM work_items WHERE node='rank-native' ORDER BY priority ASC,rank ASC LIMIT 500",
			);
			expect(legacy.map((row) => row.id)).not.toContain(firstAdapterRead.items[0]?.id);
			await measured("repeat-adapter-read", 5);
			const query = queries[0];
			if (!query) throw new Error("query missing");
			const plan = await sql.unsafe(`EXPLAIN ${query}`);
			console.info(
				"rank_query_native_explain",
				JSON.stringify({ image: DOLTGRES_IMAGE, rows: fixtures.length, plan }),
			);
			expect(plan.length).toBeGreaterThan(0);
			const all: WorkItem[] = [];
			let cursor: string | undefined;
			do {
				const page = await adapter.list({
					node: "rank-native",
					limit: 500,
					...(cursor ? { cursor } : {}),
				});
				all.push(...page.items);
				cursor = page.nextCursor;
			} while (cursor);
			expect(all).toHaveLength(15625);
			expect(new Set(all.map((item) => item.id)).size).toBe(15625);
			expect(all.map((item) => item.id)).toEqual(
				[...all]
					.sort((a, b) => compareWorkItems(a, b, normalizeWorkItemOrder()))
					.map((item) => item.id),
			);
			// Small tied/unknown shelf exercises every override and both directions without 10 full large scans.
			const ids = all
				.slice(0, 3)
				.concat(all.slice(-3))
				.map((item) => item.id);
			await sql.unsafe(
				`UPDATE work_items SET scores=NULL,priority=NULL,rank=NULL WHERE id='${ids[0]}'`,
			);
			const shelf = (await adapter.list({ ids, limit: 50 })).items;
			for (const sortBy of WORK_ITEM_SORT_FIELDS)
				for (const sortDirection of WORK_ITEM_SORT_DIRECTIONS) {
					const order = { sortBy, sortDirection };
					const seen: WorkItem[] = [];
					let next: string | undefined;
					do {
						const page = await adapter.list({
							ids,
							limit: 2,
							...order,
							...(next ? { cursor: next } : {}),
						});
						seen.push(...page.items);
						next = page.nextCursor;
					} while (next);
					expect(
						seen.map((item) => item.id),
						JSON.stringify(order),
					).toEqual(
						[...shelf]
							.sort((a, b) => compareWorkItems(a, b, order))
							.map((item) => item.id),
					);
				}
			const first = await adapter.list({ ids, limit: 1 });
			await expect(
				adapter.list({
					ids,
					limit: 1,
					sortBy: "priority",
					cursor: first.nextCursor,
				}),
			).rejects.toMatchObject({ name: "InvalidCursorError" });
			// Sparse text matches straddle multiple bounded batches, including out-of-line TEXT.
			// Seeded in batches of 50 rows (400KB per statement), not 503 round trips.
			for (let start = 0; start < 503; start += 50) {
				const rows: string[] = [];
				for (let i = start; i < Math.min(start + 50, 503); i++)
					rows.push(
						`('task.${200000 + i}','task','text ${i}','needs_design','text-native','${"x".repeat(8000)} ${i === 8 || i === 502 ? "needle" : "absent"}')`,
					);
				await sql.unsafe(
					`INSERT INTO work_items (id,type,title,status,node,summary) VALUES ${rows.join(",")}`,
				);
			}
			const textStart = performance.now();
			const before = queries.length;
			const textPage = await adapter.list({
				node: "text-native",
				text: "NEEDLE",
				limit: 1,
			});
			expect(textPage.items.map((item) => item.id)).toEqual(["task.200008"]);
			expect(textPage.pageInfo.hasMore).toBe(true);
			const textNext = await adapter.list({
				node: "text-native",
				text: "needle",
				limit: 1,
				cursor: textPage.nextCursor,
			});
			expect(textNext.items.map((item) => item.id)).toEqual(["task.200502"]);
			expect(textNext.pageInfo.hasMore).toBe(false);
			expect(queries.slice(before).length).toBeGreaterThanOrEqual(3);
			console.info(
				"rank_query_sparse_text",
				JSON.stringify({
					image: DOLTGRES_IMAGE,
					datasetN: 503,
					limit: 1,
					elapsedMs: performance.now() - textStart,
					batches: queries.length - before,
				}),
			);
			for (const issued of queries)
				// 499 = the second text batch cut short at the 1000-row scan cap (task.0055).
				expect(issued).toMatch(/ LIMIT (2|3|6|51|499|501)$/);
		} finally {
			await readSql.end({ timeout: 5 });
		}
		} finally {
			// Cleanup also runs when seed/JSON qualification fails before reader setup.
			await sql.unsafe("DELETE FROM work_items WHERE node IN ('rank-native','text-native')");
		}
	});

});
