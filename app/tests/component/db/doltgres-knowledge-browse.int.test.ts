// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Native browse keysets, exact totals, projection and the whole-corpus graph payload against the migrated, isolated Doltgres schema. */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readKnowledgeGraph } from "@cogni/knowledge-store";
import {
	buildDoltgresClient,
	DoltgresKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/doltgres";
import {
	KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
	KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET,
	KnowledgeGraphResponseSchema,
} from "@cogni/knowledge-store/contracts";
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
// Doltgres uses the simple protocol: encode fixture values as SQL literals.
const literal = (value: string | number) => {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Invalid fixture number");
		return String(value);
	}
	if (value.includes("\0")) throw new Error("NUL in fixture value");
	return `'${value.replace(/'/g, "''")}'`;
};

describe("native Doltgres knowledge browsing", () => {
	let container: StartedTestContainer;
	let sql: Sql;
	let store: DoltgresKnowledgeStoreAdapter;
	const statements: string[] = [];

	beforeAll(async () => {
		let stage = "container";
		try {
			container = await new GenericContainer("dolthub/doltgresql:0.57.3")
				.withEnvironment({ DOLTGRES_PASSWORD: "doltgres" })
				.withExposedPorts(5432)
				.withWaitStrategy(
					Wait.forLogMessage(
						/server (started|listening)/i,
						1,
					).withStartupTimeout(60_000),
				)
				.start();
			const base = `postgresql://postgres:doltgres@${container.getHost()}:${container.getMappedPort(5432)}`;
			stage = "create database";
			const admin = postgres(`${base}/postgres`, {
				max: 1,
				fetch_types: false,
			});
			try {
				await admin.unsafe(`CREATE DATABASE ${database}`);
			} finally {
				await admin.end({ timeout: 5 });
			}
			const url = `${base}/${database}`;
			stage = "migrate";
			execSync(
				`node ${path.join(root, "scripts/db/migrate-doltgres.mjs")} ${path.join(root, "app/src/adapters/server/db/doltgres-migrations")}`,
				{
					env: { ...process.env, DATABASE_URL: url, NODE_NAME: "browse-proof" },
					stdio: "pipe",
				},
			);
			stage = "connect adapter";
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
			stage = "seed domains";
			await sql.unsafe(
				"INSERT INTO domains (id,name) VALUES ('a','A'),('z-domainneedle','Z')",
			);
			// Simple-protocol batches against the isolated fixture database.
			for (let start = 0; start < 550; start += 50) {
				stage = `seed corpus rows ${start + 1}-${start + 50}`;
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
					return `(${values.map(literal).join(",")})`;
				});
				await sql.unsafe(
					`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type,entity_id,use_when,confidence_pct,created_at) VALUES ${tuples.join(",")}`,
				);
			}
			stage = "verify corpus count";
			const rows = await sql.unsafe("SELECT COUNT(*) AS count FROM knowledge");
			expect(Number(rows[0]?.count)).toBe(550);
			console.info(
				"knowledge_native_setup",
				JSON.stringify({ stage, count: 550 }),
			);
		} catch (error) {
			console.error("knowledge_native_setup_failed", JSON.stringify({ stage }));
			throw error;
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
			expect(result.total).toBe(550);
			expect(result.nextCursor).toBeTruthy();
			expect(result.items.every((row) => !("content" in row))).toBe(true);
		}
		// HEAD + one projected window per read; the exact COUNT(*) runs once per
		// (revision, filters) and the second read reuses it.
		expect(statements).toHaveLength(5);
		expect(
			statements.filter((q) => q === "SELECT COUNT(*) AS total FROM knowledge"),
		).toHaveLength(1);
		for (const query of statements.filter(
			(q) => !q.includes("dolt_hashof") && !q.startsWith("SELECT COUNT(*)"),
		)) {
			expect(query).toMatch(/^SELECT id, domain,/);
			expect(query).not.toMatch(/\bcontent\b|SELECT \*/i);
			expect(query).toMatch(/LIMIT 21$/);
		}
	});

	it("observes bounded projected first windows as the native corpus grows", async () => {
		const domain = "growth-proof";
		await sql.unsafe(
			`INSERT INTO domains (id,name) VALUES (${literal(domain)},${literal("Growth proof")})`,
		);
		let stage = "growth seed";
		let seeded = 0;
		let seedElapsedMs = 0;
		try {
			for (const count of [500, 5_000, 50_000]) {
				const seedStart = performance.now();
				for (let start = seeded; start < count; start += 100) {
					stage = `growth seed ${start + 1}-${Math.min(start + 100, count)}`;
					const size = Math.min(100, count - start);
					const tuples = Array.from({ length: size }, (_, offset) => {
						const values = [
							`growth-${String(start + offset).padStart(6, "0")}`,
							domain,
							"Growth",
							"small body",
							"guide",
							"agent",
						];
						return `(${values.map(literal).join(",")})`;
					});
					await sql.unsafe(
						`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type) VALUES ${tuples.join(",")}`,
					);
				}
				// Production writes always commit (withWrite); totals key on HEAD.
				await sql.unsafe(
					`SELECT dolt_commit('-Am', ${literal(`growth fixture ${count}`)})`,
				);
				seedElapsedMs += performance.now() - seedStart;
				seeded = count;
				stage = `growth count ${count}`;
				const actual = await sql.unsafe(
					`SELECT COUNT(*) AS count FROM knowledge WHERE domain = ${literal(domain)}`,
				);
				expect(Number(actual[0]?.count)).toBe(count);
				console.info("knowledge_native_seed", JSON.stringify({ count }));
				for (const mode of ["browse", "overview"] as const) {
					stage = `growth ${mode} ${count}`;
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
					// Browse counts once at this revision; overview reuses the total.
					expect(statements).toHaveLength(mode === "browse" ? 3 : 2);
					expect(page.revision).toBeTruthy();
					expect(page.total).toBe(count);
					const query = statements.find(
						(q) => !q.includes("dolt_hashof") && !q.startsWith("SELECT COUNT(*)"),
					);
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
							queryCount: statements.length,
							outputCount: page.items.length,
							scannedRows: page.scannedRows,
							resultJSONbytes,
							explain,
						}),
					);
				}
			}
		} catch (error) {
			console.error(
				"knowledge_native_growth_failed",
				JSON.stringify({ stage }),
			);
			throw error;
		} finally {
			await sql.unsafe(
				`DELETE FROM knowledge WHERE domain = ${literal(domain)}`,
			);
			await sql.unsafe(`DELETE FROM domains WHERE id = ${literal(domain)}`);
		}
	}, 600_000);

	it("serves the whole graph through readKnowledgeGraph at 5k/10k and 50k/100k with pinned, projected, budgeted reads", async () => {
		// Budget (task.0059): ≤ KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET per node and
		// ≤ KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET per edge, capped by the whole-response
		// budget; gzip ≤ 25% of raw. Never truncated: past the whole-response
		// budget the handler logs budgetExceeded (the LOD follow-up's trigger).
		const domain = "graph-proof";
		const nodeId = (n: number) => `graph-${String(n).padStart(6, "0")}`;
		await sql.unsafe(
			`INSERT INTO domains (id,name) VALUES (${literal(domain)},'Graph proof')`,
		);
		let stage = "graph seed";
		let seededNodes = 0;
		let seededEdges = 0;
		try {
			for (const [nodes, edges] of [
				[5_000, 10_000],
				[50_000, 100_000],
			] as const) {
				const seedStart = performance.now();
				for (let start = seededNodes; start < nodes; start += 1000) {
					stage = `graph seed nodes ${start + 1}`;
					const tuples = Array.from(
						{ length: Math.min(1000, nodes - start) },
						(_, offset) => {
							const n = start + offset;
							const values = [
								nodeId(n),
								domain,
								`Graph proof entry ${n}`,
								"small body",
								n % 2 ? "guide" : "finding",
								"agent",
							];
							return `(${values.map(literal).join(",")})`;
						},
					);
					await sql.unsafe(
						`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type) VALUES ${tuples.join(",")}`,
					);
				}
				for (let start = seededEdges; start < edges; start += 1000) {
					stage = `graph seed citations ${start + 1}`;
					const tuples = Array.from(
						{ length: Math.min(1000, edges - start) },
						(_, offset) => {
							const e = start + offset;
							// Edge e is a pure function of e (stable across stages): entry
							// ⌊e/2⌋ cites the next entry and the seventh, so (citing, cited)
							// is unique and later stages never repeat an earlier pair.
							const from = Math.floor(e / 2);
							const to = (from + (e % 2 ? 7 : 1)) % nodes;
							const values = [
								`graph-cite-${String(e).padStart(6, "0")}`,
								nodeId(from),
								nodeId(to),
								e % 3 ? "supports" : "extends",
							];
							return `(${values.map(literal).join(",")})`;
						},
					);
					await sql.unsafe(
						`INSERT INTO citations (id,citing_id,cited_id,citation_type) VALUES ${tuples.join(",")}`,
					);
				}
				// Production writes always commit (withWrite); the graph keys on HEAD.
				await sql.unsafe(
					`SELECT dolt_commit('-Am', ${literal(`graph fixture ${nodes}`)})`,
				);
				const seedMs = performance.now() - seedStart;
				seededNodes = nodes;
				seededEdges = edges;
				stage = `graph read ${nodes}`;
				statements.length = 0;
				const start = performance.now();
				const result = await readKnowledgeGraph(store);
				const readMs = performance.now() - start;
				expect(result.status).toBe(200);
				const body = result.body ?? "";
				const response = KnowledgeGraphResponseSchema.parse(JSON.parse(body));
				expect(result.headers.ETag).toBe(`"${response.revision}"`);
				expect(
					response.nodes.filter((n) => n.domain === domain),
				).toHaveLength(nodes);
				expect(
					response.edges.filter((e) => e.id.startsWith("graph-cite-")),
				).toHaveLength(edges);
				// Pinned (HEAD before and after), projected, never bodies.
				expect(statements).toContain(
					"SELECT id, domain, title, entry_type, confidence_pct, source_type FROM knowledge",
				);
				expect(statements).toContain(
					"SELECT id, citing_id, cited_id, citation_type FROM citations",
				);
				expect(
					statements.filter((q) => q.includes("dolt_hashof")).length,
				).toBeGreaterThanOrEqual(2);
				expect(
					statements.some((q) => /\bcontent\b|SELECT \*/i.test(q)),
				).toBe(false);
				const raw = Buffer.byteLength(body);
				const gzip = gzipSync(body).byteLength;
				const nodeBytes = Buffer.byteLength(JSON.stringify(response.nodes));
				const edgeBytes = Buffer.byteLength(JSON.stringify(response.edges));
				expect(nodeBytes / response.nodes.length).toBeLessThanOrEqual(
					KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET,
				);
				expect(edgeBytes / response.edges.length).toBeLessThanOrEqual(
					KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET,
				);
				expect(gzip).toBeLessThanOrEqual(raw / 4);
				expect(result.log.bytes).toBe(raw);
				expect(result.log.budgetExceeded).toBe(
					raw > (result.log.budgetBytes ?? 0),
				);
				// A revalidation of the same revision is a 304 with no store read.
				statements.length = 0;
				const unchanged = await readKnowledgeGraph(store, {
					ifNoneMatch: result.headers.ETag ?? null,
				});
				expect(unchanged.status).toBe(304);
				expect(
					statements.filter((q) => !q.includes("dolt_hashof")),
				).toHaveLength(0);
				console.info(
					"knowledge_native_graph_payload",
					JSON.stringify({
						seededNodes: nodes,
						seededEdges: edges,
						nodes: response.nodes.length,
						edges: response.edges.length,
						rawBytes: raw,
						gzipBytes: gzip,
						rawBytesPerNode: Math.round(nodeBytes / response.nodes.length),
						rawBytesPerEdge: Math.round(edgeBytes / response.edges.length),
						budgetBytes: result.log.budgetBytes,
						budgetExceeded: result.log.budgetExceeded,
						readMs: Math.round(readMs),
						seedMs: Math.round(seedMs),
					}),
				);
			}
		} catch (error) {
			console.error("knowledge_native_graph_failed", JSON.stringify({ stage }));
			throw error;
		} finally {
			await sql.unsafe("DELETE FROM citations WHERE id LIKE 'graph-cite-%'");
			await sql.unsafe(
				`DELETE FROM knowledge WHERE domain = ${literal(domain)}`,
			);
			await sql.unsafe(`DELETE FROM domains WHERE id = ${literal(domain)}`);
		}
	}, 900_000);

	it("keys cognition on knowledge, domains and citations table hashes: a work-item write leaves the key, a knowledge write moves it (bug.0018)", async () => {
		// Record which native spellings resolve, so an engine change is diagnosable from CI.
		const forms: Record<string, string> = {};
		for (const form of [
			"dolt_hashof_table('knowledge')",
			"dolt_hashof_table('public.knowledge')",
			"dolt_hashof_table('public', 'knowledge')",
		]) {
			forms[form] = await sql
				.unsafe(`SELECT ${form} AS h`)
				.then((r) => `ok ${String(r[0]?.h)}`)
				.catch((e: Error) => `error ${e.message}`);
		}
		console.info("cognition_revision_forms", JSON.stringify(forms));
		const before = await store.knowledgeRevision();
		expect(before).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
		await sql.unsafe(
			"INSERT INTO work_items (id,type,title,status) VALUES ('task.9999','task','Revision probe','needs_triage')",
		);
		expect(await store.knowledgeRevision()).toBe(before);
		await sql.unsafe(
			"INSERT INTO knowledge (id,domain,title,content,source_type) VALUES ('revision-probe','a','Probe','body','agent')",
		);
		const after = await store.knowledgeRevision();
		expect(after).not.toBe(before);
		await sql.unsafe("DELETE FROM knowledge WHERE id = 'revision-probe'");
		await sql.unsafe("DELETE FROM work_items WHERE id = 'task.9999'");
	});

	it("walks NOW-backed timestamp pages once in both directions", async () => {
		// Fixed logical corpus revision, not snapshot isolation. No mutations occur
		// between the completed seed/readback and the four traversals.
		const revision = "knowledge-now-microseconds-v1";
		const domain = "now-precision-proof";
		const groups = [2, 1, 0].map((group) =>
			Array.from(
				{ length: 25 },
				(_, n) => `now-${group}-${String(n).padStart(2, "0")}`,
			),
		);
		await sql.unsafe(
			`INSERT INTO domains (id,name) VALUES (${literal(domain)},'NOW precision')`,
		);
		try {
			for (const ids of groups) {
				// One statement gives 25 tied NOW values, crossing the page boundary.
				// IDs oppose insertion time; both directions must retain id ASC ties.
				await sql.unsafe(
					`INSERT INTO knowledge (id,domain,title,content,entry_type,source_type,created_at) VALUES ${ids.map((id) => `(${literal(id)},${literal(domain)},'NOW fixture','body','guide','agent',NOW())`).join(",")}`,
				);
			}
			const precision = await sql.unsafe(
				`SELECT id, CAST(created_at AS TEXT) AS ts, created_at > CAST(CAST(created_at AS TEXT) AS TIMESTAMP WITH TIME ZONE) AS hidden_nanoseconds FROM knowledge WHERE domain = ${literal(domain)} ORDER BY created_at ASC, id ASC`,
			);
			expect(precision).toHaveLength(75);
			expect(precision.some((row) => row.hidden_nanoseconds === true)).toBe(
				true,
			);
			expect(new Set(precision.map((row) => String(row.ts))).size).toBe(3);
			expect(precision.map((row) => row.id)).toEqual(groups.flat());
			console.info(
				"knowledge_native_now_revision",
				JSON.stringify({
					revision,
					count: 75,
					groups: 3,
					rows: Array.from(precision),
					snapshotIsolation: false,
				}),
			);
			for (const mode of ["browse", "overview"] as const) {
				for (const direction of ["asc", "desc"] as const) {
					const expected = (
						direction === "asc" ? groups : [...groups].reverse()
					).flat();
					const found: string[] = [];
					let cursor: string | undefined;
					let exhausted = false;
					for (let page = 0; page < 6; page++) {
						const input = {
							domains: [domain],
							sort: "createdAt" as const,
							direction,
							...(cursor ? { cursor } : {}),
						};
						const result =
							mode === "browse"
								? await store.browseKnowledge(input)
								: await store.overviewKnowledge(input);
						expect(result.items.length).toBeLessThanOrEqual(20);
						for (const row of result.items) {
							expect(
								found,
								`${mode} ${direction}: repeated boundary`,
							).not.toContain(row.id);
							found.push(row.id);
						}
						if (!result.nextCursor) {
							exhausted = true;
							break;
						}
						cursor = result.nextCursor;
					}
					expect(exhausted, `${mode} ${direction}`).toBe(true);
					expect(found, `${mode} ${direction}`).toEqual(expected);
					expect(new Set(found).size).toBe(75);
					console.info(
						"knowledge_native_now_walk",
						JSON.stringify({
							revision,
							mode,
							direction,
							count: found.length,
							exhausted,
						}),
					);
				}
			}
		} finally {
			await sql.unsafe(
				`DELETE FROM knowledge WHERE domain = ${literal(domain)}`,
			);
			await sql.unsafe(`DELETE FROM domains WHERE id = ${literal(domain)}`);
		}
	}, 120_000);

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
			statements.some((query) =>
				query.includes(
					"date_trunc('microseconds', created_at) ASC NULLS FIRST",
				),
			),
		).toBe(true);
		expect(
			statements.some((query) =>
				query.includes(
					"date_trunc('microseconds', created_at) DESC NULLS LAST",
				),
			),
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
