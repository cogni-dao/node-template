// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 acceptance for the `no-inline-history@1` edits read (bug.0030).
 *
 * Dolt pushes a `to_commit` filter on `dolt_diff_<table>` down to an index
 * lookup but never a commit-date filter, so the edits read takes the window's
 * commit hashes from `dolt_log` and then filters the diff tables with
 * a chain of `to_commit = '<hash>'` tests (Doltgres 0.57.3 cannot plan an `IN`
 * list there). A fake `Sql` cannot see either engine behavior: this runs the
 * shipped statements against a real history with commits before, inside and
 * after the window and checks the edits equal what the date filter selected.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	NO_INLINE_HISTORY_MAX_BYTES,
	noInlineHistoryEditsSql,
	noInlineHistoryWindowCommitsSql,
	readNoInlineHistoryEdits,
} from "@cogni-dao/metrics/sources";
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const DB_NAME = "knowledge_node_template_metrics_edits";
const PASSWORD = "doltgres";

const window = {
	start: "2026-11-02T00:00:00.000Z",
	end: "2026-11-09T00:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
	source(new AbortController().signal);

describe("Doltgres 0.57.3 no-inline-history edits read", () => {
	let container: StartedTestContainer;
	let sql: Sql;

	const commit = async (message: string, date: string) => {
		const rows = await sql.unsafe(
			`SELECT dolt_commit('-Am', '${message.replace(/'/g, "''")}', '--date', '${date}')`,
		);
		return String(rows[0]?.dolt_commit);
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
		const bootstrap = postgres(
			`postgresql://postgres:${PASSWORD}@${host}:${port}/postgres`,
			{ max: 1, fetch_types: false },
		);
		try {
			await bootstrap.unsafe(`CREATE DATABASE ${DB_NAME}`);
		} finally {
			await bootstrap.end({ timeout: 5 });
		}
		const dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
		execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				NODE_NAME: "node-template-metrics-edits",
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

	it("reads the same edits the commit-date filter selected, from the window's commits only", async () => {
		// Creation, then ten edits long before the window.
		await sql.unsafe(
			`INSERT INTO work_items (id,type,title,status,node,summary,outcome,labels) VALUES
			 ('task.1','task','one','needs_implement','shared','S1','O1','[]'::jsonb),
			 ('task.2','task','two','needs_implement','shared','S2','O2','[]'::jsonb),
			 ('task.3','task','fixture','needs_implement','shared','S3','O3','["test-fixture"]'::jsonb)`,
		);
		await sql.unsafe(
			`INSERT INTO knowledge (id,domain,title,content,source_type) VALUES ('k1','meta','atom one','B1','agent')`,
		);
		await commit("create", "2026-09-01T10:00:00");
		for (let i = 1; i <= 10; i++) {
			await sql.unsafe(
				`UPDATE work_items SET summary = 'old ${i}' WHERE id = 'task.1'`,
			);
			await commit(`old edit ${i}`, `2026-10-${String(i).padStart(2, "0")}T10:00:00`);
		}
		// Inside the window: a clean edit with a reason, an appending edit, a
		// fixture edit (not counted), a clean atom edit and an appending atom edit.
		await sql.unsafe(`UPDATE work_items SET summary = 'new one' WHERE id = 'task.1'`);
		await commit("tighten\nReason: clearer", "2026-11-03T10:00:00");
		await sql.unsafe(
			`UPDATE work_items SET outcome = 'O2\nUpdate: shipped' WHERE id = 'task.2'`,
		);
		await commit("append", "2026-11-04T10:00:00");
		await sql.unsafe(`UPDATE work_items SET summary = 'fixture edit' WHERE id = 'task.3'`);
		await commit("fixture", "2026-11-05T10:00:00");
		await sql.unsafe(`UPDATE knowledge SET content = 'B1 changed' WHERE id = 'k1'`);
		await commit("atom clean", "2026-11-06T10:00:00");
		await sql.unsafe(
			`UPDATE knowledge SET content = 'B1 changed\nUpdate: more' WHERE id = 'k1'`,
		);
		await commit("atom append", "2026-11-07T10:00:00");
		// After the window.
		await sql.unsafe(`UPDATE work_items SET summary = 'later' WHERE id = 'task.1'`);
		await commit("later", "2026-12-31T10:00:00");

		// What the date filter selected: the commits of the diff rows dated in the window.
		const dated = async (table: string) =>
			(
				await sql.unsafe(
					`SELECT DISTINCT to_commit FROM ${table} WHERE to_commit <> 'WORKING' AND diff_type = 'modified' AND to_commit_date >= '2026-11-02 00:00:00.000' AND to_commit_date < '2026-11-09 00:00:00.000'`,
				)
			).map((r) => String(r.to_commit));
		const legacy = [
			...(await dated("dolt_diff_work_items")),
			...(await dated("dolt_diff_knowledge")),
		].sort();
		expect(legacy).toHaveLength(5);

		// The window statement returns those commits (the log holds no other in the window).
		const found = await sql.unsafe(noInlineHistoryWindowCommitsSql(window));
		expect(Number(found[0]?.n)).toBe(5);
		expect(found.map((r) => String(r.commit_hash)).sort()).toEqual(legacy);

		// Run each diff statement bare first so an engine error shows its message.
		const hashes = found.map((r) => String(r.commit_hash));
		for (const table of ["work-items", "atoms"] as const)
			await sql.unsafe(noInlineHistoryEditsSql(table, hashes));

		const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
		expect(sample, JSON.stringify(sample)).toMatchObject({
			complete: true,
			value: 4,
			unit: "edits",
		});
		expect(sample.evidenceRefs).toContain(
			"counts:edits=4;appending=2;withReason=1",
		);
		expect(sample.evidenceRefs).toContain("counts:merge_repeats=0");
		expect(sample.sourceWatermarks.map((w) => w.source)).toEqual([
			"node.work_items",
			"node.knowledge",
		]);
	});

	it("reads no edit, and no diff, for a window with no commit", async () => {
		const empty = {
			start: "2025-01-01T00:00:00.000Z",
			end: "2025-01-08T00:00:00.000Z",
		};
		const found = await sql.unsafe(noInlineHistoryWindowCommitsSql(empty));
		expect(Number(found[0]?.n)).toBe(0);
		expect(await readNoInlineHistoryEdits(sql, "count", empty, read)).toMatchObject(
			{ complete: true, value: 0 },
		);
	});
	it("keeps merge commits in the window: a contribution's edit can have its diff row at the merge commit only (bug.0030)", async () => {
		const HOUR = 3_600_000;
		const DAY = 24 * HOUR;
		const now = Date.now();
		const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
		await sql.unsafe(
			`INSERT INTO work_items (id,type,title,status,node,summary,outcome,labels) VALUES ('task.m1','task','merge one','needs_implement','shared','M1','O1','[]'::jsonb)`,
		);
		await sql.unsafe(
			`INSERT INTO knowledge (id,domain,title,content,source_type) VALUES ('km1','meta','merge atom one','K1','agent'), ('km2','meta','merge atom two','K2','agent')`,
		);
		await commit("merge fixtures", iso(now - 30 * DAY));
		await sql.unsafe(`SELECT dolt_branch('b_in')`);
		await sql.unsafe(`SELECT dolt_branch('b_old')`);
		// A contribution branch whose commit is authored inside the window.
		await sql.unsafe(`SELECT dolt_checkout('b_in')`);
		await sql.unsafe(`UPDATE knowledge SET content = 'K1 changed' WHERE id = 'km1'`);
		await commit("branch edit in window", iso(now - HOUR));
		// A contribution branch whose commit is authored long before the window.
		await sql.unsafe(`SELECT dolt_checkout('b_old')`);
		await sql.unsafe(`UPDATE knowledge SET content = 'K2 changed' WHERE id = 'km2'`);
		await commit("branch edit before window", iso(now - 10 * DAY));
		// Main moves on, so both merges are real merge commits dated now.
		await sql.unsafe(`SELECT dolt_checkout('main')`);
		await sql.unsafe(`UPDATE work_items SET summary = 'M1 changed' WHERE id = 'task.m1'`);
		await commit("main edit in window", iso(now - 2 * HOUR));
		await sql.unsafe(`SELECT * FROM dolt_merge('b_in')`);
		await sql.unsafe(`SELECT * FROM dolt_merge('b_old')`);

		const mergeWindow = {
			start: new Date(now - 12 * HOUR).toISOString(),
			end: new Date(now + 12 * HOUR).toISOString(),
		};
		const inWindow = (value: string) => value.replace("T", " ").replace("Z", "");
		const merges = await sql.unsafe(
			`SELECT commit_hash FROM dolt_log WHERE message LIKE 'Merge branch%' AND date >= '${inWindow(mergeWindow.start)}' AND date < '${inWindow(mergeWindow.end)}'`,
		);
		expect(merges).toHaveLength(2);
		// The window statement lists the merge commits with every other commit dated inside it.
		const found = await sql.unsafe(noInlineHistoryWindowCommitsSql(mergeWindow));
		const listed = found.map((r) => String(r.commit_hash));
		for (const m of merges) expect(listed).toContain(String(m.commit_hash));

		// Three edits, each once: the atom authored in the window, the atom authored before it and merged inside it (counted at the merge date), and the work item. Leaving the merge commits out of the list loses edits.
		const sample = await readNoInlineHistoryEdits(sql, "count", mergeWindow, read);
		expect(sample, JSON.stringify(sample)).toMatchObject({ complete: true, value: 3, unit: "edits" });
		expect(sample.evidenceRefs).toContain("counts:edits=3;appending=0;withReason=0");
	});

	it("reads a window commit that touches neither edit table as no edit, from a statement that sends no row", async () => {
		await sql.unsafe(`INSERT INTO domains (id,name) VALUES ('merge-probe','Merge probe')`);
		await commit("touches no edit table", "2027-03-10T10:00:00");
		const quiet = {
			start: "2027-03-09T00:00:00.000Z",
			end: "2027-03-16T00:00:00.000Z",
		};
		const found = await sql.unsafe(noInlineHistoryWindowCommitsSql(quiet));
		expect(Number(found[0]?.n)).toBe(1);
		const hashes = found.map((r) => String(r.commit_hash));
		for (const table of ["work-items", "atoms"] as const)
			expect(await sql.unsafe(noInlineHistoryEditsSql(table, hashes))).toHaveLength(0);
		const sample = await readNoInlineHistoryEdits(sql, "count", quiet, read);
		expect(sample, JSON.stringify(sample)).toMatchObject({ complete: true, value: 0, unit: "edits" });
		expect(sample.sourceWatermarks.map((w) => w.asOf)).not.toContain(null);
	});

	it("sends the first row alone, carrying the totals, when the edits are over the byte cap", async () => {
		const ROWS = 45; // 45 rows x 4 fields x 100,000 chars is over the 16 MiB cap.
		const field = (c: string) => c.repeat(100_000);
		for (let i = 0; i < ROWS; i++)
			await sql.unsafe(
				`INSERT INTO work_items (id,type,title,status,node,summary,outcome,labels) VALUES ('task.big${i}','task','big ${i}','needs_implement','shared','${field("a")}','${field("a")}','[]'::jsonb)`,
			);
		await commit("big fixtures", "2027-03-31T10:00:00");
		for (let i = 0; i < ROWS; i++) {
			await sql.unsafe(
				`UPDATE work_items SET summary = '${field("b")}', outcome = '${field("b")}' WHERE id = 'task.big${i}'`,
			);
			await commit(`big edit ${i}`, `2027-04-02T10:${String(i).padStart(2, "0")}:00`);
		}
		const big = {
			start: "2027-04-01T00:00:00.000Z",
			end: "2027-04-08T00:00:00.000Z",
		};
		const found = await sql.unsafe(noInlineHistoryWindowCommitsSql(big));
		expect(Number(found[0]?.n)).toBe(ROWS);
		const hashes = found.map((r) => String(r.commit_hash));
		const rows = await sql.unsafe(noInlineHistoryEditsSql("work-items", hashes));
		// One row, not the 45: the totals ride on the first row and no text over the cap is sent.
		expect(rows).toHaveLength(1);
		expect(Number(rows[0]?.n)).toBe(ROWS);
		expect(Number(rows[0]?.bytes)).toBeGreaterThan(NO_INLINE_HISTORY_MAX_BYTES);
		const sample = await readNoInlineHistoryEdits(sql, "count", big, read);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs.join()).toContain("cap_hit");
	}, 120_000);
});
