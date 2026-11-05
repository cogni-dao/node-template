// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native browse keysets and projection against the migrated, isolated Doltgres schema. */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildDoltgresClient,
	DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const database = "knowledge_browse_proof";
const id = (n: number) => `row-${String(n).padStart(4, "0")}`;

describe("native Doltgres knowledge browsing", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let store: DoltgresKnowledgeStoreAdapter;
	const statements: string[] = [];

	beforeAll(async () => {
		container = await new GenericContainer("dolthub/doltgresql:0.57.3")
			.withEnvironment({ DOLTGRES_PASSWORD: "doltgres" })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();
		const base = `postgresql://postgres:doltgres@${container.getHost()}:${container.getMappedPort(5432)}`;
		const admin = postgres(`${base}/postgres`, { max: 1, fetch_types: false });
		try {
			await admin.unsafe(`CREATE DATABASE ${database}`);
		} finally {
			await admin.end({ timeout: 5 });
		}
		const url = `${base}/${database}`;
		execSync(
			`node ${path.join(root, "scripts/db/migrate-doltgres.mjs")} ${path.join(root, "app/src/adapters/server/db/doltgres-migrations")}`,
			{
				env: { ...process.env, DATABASE_URL: url, NODE_NAME: "browse-proof" },
				stdio: "pipe",
			},
		);
		sql = buildDoltgresClient({ connectionString: url, max: 1 });
		// Only observe transport calls: every query still executes on the real engine.
		const observed = new Proxy(sql, {
			get(target, key) {
				if (key !== "unsafe") return Reflect.get(target, key, target);
				return (...args: Parameters<typeof sql.unsafe>) => {
					statements.push(args[0]);
					return Reflect.apply(target.unsafe, target, args);
				};
			},
		});
		store = new DoltgresKnowledgeStoreAdapter({ sql: observed });
		await sql.unsafe(
			"INSERT INTO domains (id,name) VALUES ('a','A'),('z-domainneedle','Z')",
		);
		// Parameterized batch fixtures: no schema modifications or live data.
		for (let start = 0; start < 550; start += 50) {
			const params: (string | number)[] = [];
			const tuples = Array.from({ length: 50 }, (_, offset) => {
				const n = start + offset;
				const values = [
					n === 1 ? "idneedle-0001" : id(n),
					n === 2 ? "z-domainneedle" : "a",
					n === 3 ? "titleNeedle" : "Ordinary",
					n === 549
						? `Body-only %_literal ${"large body ".repeat(3000)}`
						: "plain",
					n === 4 ? "typeneedle" : n % 2 ? "guide" : "finding",
					n % 3 ? "human" : "agent",
					n === 5 ? "entityneedle" : "",
					n === 6 ? "legacyTrigger" : "ordinary trigger",
					(n % 3) * 30,
					`2026-01-01 00:00:00.${["123455", "123456", "123457"][Math.floor(n / 25) % 3]}+00`,
				];
				params.push(...values);
				return `(${values.map((_, i) => `$${offset * values.length + i + 1}`).join(",")})`;
			});
			await sql.unsafe(
				`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type,entity_id,use_when,confidence_pct,created_at) VALUES ${tuples.join(",")}`,
				params,
			);
		}
	}, 240_000);

	afterAll(async () => {
		await sql?.end({ timeout: 5 }).catch(() => undefined);
		if (container) await container.stop();
	});

	it("projects 20 body-free browse and overview summaries using metadata-only native queries", async () => {
		statements.length = 0;
		for (const result of [
			await store.browseKnowledge({ sort: "id", direction: "asc" }),
			await store.overviewKnowledge({ sort: "id", direction: "asc" }),
		]) {
			expect(result.items).toHaveLength(20);
			expect(result.nextCursor).toBeTruthy();
			expect(result.items.every((row) => !("content" in row))).toBe(true);
		}
		expect(statements).toHaveLength(2);
		for (const query of statements) {
			expect(query).toMatch(/^SELECT id, domain,/);
			expect(query).not.toMatch(/\bcontent\b|SELECT \*/i);
			expect(query).toMatch(/LIMIT 21$/);
		}
	});

	it("observes bounded projected first windows as the native corpus grows", async () => {
		const domain = "growth-proof";
		await sql.unsafe("INSERT INTO domains (id,name) VALUES ($1,$2)", [
			domain,
			"Growth proof",
		]);
		let seeded = 0;
		let seedElapsedMs = 0;
		try {
			for (const count of [500, 5_000, 50_000]) {
				const seedStart = performance.now();
				for (let start = seeded; start < count; start += 100) {
					const size = Math.min(100, count - start);
					const params: string[] = [];
					const tuples = Array.from({ length: size }, (_, offset) => {
						const values = [
							`growth-${String(start + offset).padStart(6, "0")}`,
							domain,
							"Growth",
							"small body",
							"guide",
							"agent",
						];
						params.push(...values);
						return `(${values.map((_, i) => `$${offset * values.length + i + 1}`).join(",")})`;
					});
					await sql.unsafe(
						`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type) VALUES ${tuples.join(",")}`,
						params,
					);
				}
				seedElapsedMs += performance.now() - seedStart;
				seeded = count;
				const actual = await sql.unsafe(
					"SELECT COUNT(*) AS count FROM knowledge WHERE domain = $1",
					[domain],
				);
				expect(Number(actual[0]?.count)).toBe(count);
				for (const mode of ["browse", "overview"] as const) {
					statements.length = 0;
					const start = performance.now();
					const input = {
						domains: [domain],
						sort: "id" as const,
						direction: "asc" as const,
					};
					const page =
						mode === "browse"
							? await store.browseKnowledge(input)
							: await store.overviewKnowledge(input);
					const queryElapsedMs = performance.now() - start;
					expect(statements).toHaveLength(1);
					const query = statements[0];
					if (!query) throw new Error("projected query missing");
					expect(query).toMatch(/^SELECT id, domain,/);
					expect(query).not.toMatch(/\bcontent\b|SELECT \*/i);
					expect(query).toMatch(/LIMIT 21$/);
					expect(page.items).toHaveLength(20);
					expect(page.scannedRows).toBe(20);
					expect(page.nextCursor).toBeTruthy();
					for (const row of page.items) {
						expect(row).not.toHaveProperty("content");
						expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(2048);
					}
					const resultJSONbytes = Buffer.byteLength(JSON.stringify(page));
					expect(resultJSONbytes).toBeLessThan(32_768);
					let explain: unknown;
					try {
						const plan = await sql.unsafe(`EXPLAIN ${query}`);
						explain = plan.length
							? { status: "available", plan: Array.from(plan) }
							: { status: "unknown", reason: "empty EXPLAIN result" };
					} catch (error) {
						explain = { status: "unknown", reason: String(error) };
					}
					console.info(
						"knowledge_native_growth",
						JSON.stringify({
							count,
							mode,
							seedElapsedMs,
							queryElapsedMs,
							queryCount: 1,
							outputCount: page.items.length,
							scannedRows: page.scannedRows,
							resultJSONbytes,
							explain,
						}),
					);
				}
			}
		} finally {
			await sql.unsafe("DELETE FROM knowledge WHERE domain = $1", [domain]);
			await sql.unsafe("DELETE FROM domains WHERE id = $1", [domain]);
		}
	}, 600_000);

	it("traverses all IDs for each global sort and direction, including microsecond ties", async () => {
		const rows = await sql.unsafe(
			"SELECT id,domain,entry_type,source_type,confidence_pct,CAST(created_at AS TEXT) AS ts FROM knowledge",
		);
		for (const fraction of ["123455", "123456", "123457"]) {
			expect(
				rows.filter((row) => String(row.ts).includes(`.${fraction}`)).length,
			).toBeGreaterThan(20);
		}
		statements.length = 0;
		const fields = {
			id: "id",
			domain: "domain",
			entryType: "entry_type",
			sourceType: "source_type",
			confidencePct: "confidence_pct",
			createdAt: "ts",
		} as const;
		for (const sort of Object.keys(fields) as (keyof typeof fields)[]) {
			for (const direction of ["asc", "desc"] as const) {
				const expected = [...rows]
					.sort((a, b) => {
						const x = a[fields[sort]];
						const y = b[fields[sort]];
						return (
							(x < y ? -1 : x > y ? 1 : 0) * (direction === "asc" ? 1 : -1) ||
							(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
						);
					})
					.map((row) => row.id);
				const found: string[] = [];
				let cursor: string | undefined;
				let exhausted = false;
				for (let page = 0; page < 35; page++) {
					const result = await store.browseKnowledge({
						sort,
						direction,
						...(cursor ? { cursor } : {}),
					});
					found.push(...result.items.map((row) => row.id));
					if (!result.nextCursor) {
						exhausted = true;
						break;
					}
					cursor = result.nextCursor;
				}
				expect(exhausted, `${sort} ${direction}`).toBe(true);
				expect(found, `${sort} ${direction}`).toEqual(expected);
				expect(new Set(found).size).toBe(550);
			}
		}
		expect(
			statements.some((query) => query.includes("created_at ASC NULLS FIRST")),
		).toBe(true);
		expect(
			statements.some((query) => query.includes("created_at DESC NULLS LAST")),
		).toBe(true);
	}, 120_000);

	it("applies global any-of filters and searches all six literal fields through empty windows", async () => {
		const filtered = await store.browseKnowledge({
			domains: ["z-domainneedle"],
			entryTypes: ["finding"],
			sourceTypes: ["human"],
			sort: "id",
			direction: "asc",
		});
		expect(filtered.items.map((row) => row.id)).toEqual([id(2)]);
		for (const [needle, expected] of [
			["idneedle", "idneedle-0001"],
			["domainneedle", id(2)],
			["titleneedle", id(3)],
			["typeneedle", id(4)],
			["entityneedle", id(5)],
			["%_LITERAL", id(549)],
		]) {
			let cursor: string | undefined;
			const found: string[] = [];
			let empty = 0;
			let exhausted = false;
			for (let page = 0; page < 30; page++) {
				const result = await store.browseKnowledge({
					sort: "id",
					direction: "asc",
					search: needle,
					...(cursor ? { cursor } : {}),
				});
				if (!result.items.length && result.nextCursor) empty++;
				expect(result.scannedRows).toBeLessThanOrEqual(20);
				expect(result.items.every((row) => !("content" in row))).toBe(true);
				found.push(...result.items.map((row) => row.id));
				if (!result.nextCursor) {
					exhausted = true;
					break;
				}
				cursor = result.nextCursor;
			}
			expect(exhausted).toBe(true);
			expect(found).toEqual([expected]);
			if (needle === "%_LITERAL") expect(empty).toBeGreaterThanOrEqual(25);
		}
		expect(
			(await store.listKnowledge("a", { q: "legacytrigger" })).map(
				(row) => row.id,
			),
		).toEqual([id(6)]);
		expect(await store.listKnowledge("a", { q: "%_literal" })).toEqual([]);
		expect(await store.listKnowledge("a", { q: "titleneedle" })).toEqual([]);
	}, 120_000);
});
