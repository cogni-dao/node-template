// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 acceptance for the `no-inline-history@1` edits read (bug.0030).
 *
 * Dolt pushes a `to_commit` filter on `dolt_diff_<table>` down to an index
 * lookup but never a commit-date filter, so the edits read takes the window's
 * commit hashes from `dolt_log` and then filters the diff tables with
 * `to_commit IN (...)`. A fake `Sql` cannot see either engine behavior: this
 * runs the shipped statements against a real history with commits before,
 * inside and after the window and checks the edits equal what the date filter
 * selected.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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
		await commit("later", "2026-11-12T10:00:00");

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

		const sample = await readNoInlineHistoryEdits(sql, "count", window, read);
		expect(sample).toMatchObject({ complete: true, value: 4, unit: "edits" });
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
});
