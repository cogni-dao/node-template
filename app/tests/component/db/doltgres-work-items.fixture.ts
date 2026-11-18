// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO


/**
 * Shared fixture for the doltgres-work-items-*.int.test.ts acceptance files: one migrated
 * Doltgres 0.57.3 container per file, plus the summary-database seed helpers (task.0138).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATE_SCRIPT = path.resolve(
	REPO_ROOT,
	"scripts/db/migrate-doltgres.mjs",
);
const MIGRATIONS_DIR = path.resolve(
	REPO_ROOT,
	"app/src/adapters/server/db/doltgres-migrations",
);
export const DOLTGRES_IMAGE = "dolthub/doltgresql:0.57.3";
export const DB_NAME = "knowledge_node_template_work_items";
const PASSWORD = "doltgres";

export const stageLogger = {
	info: (fields: unknown, message?: string) =>
		console.info(message, JSON.stringify(fields)),
	warn: (fields: unknown, message?: string) =>
		console.warn(message, JSON.stringify(fields)),
	error: (fields: unknown, message?: string) =>
		console.error(message, JSON.stringify(fields)),
};

/** Start a Doltgres container with the work-items schema migrated into `DB_NAME`. */
export async function startWorkItemsDoltgres(): Promise<{
	container: StartedTestContainer;
	sql: Sql;
	dbUrl: string;
}> {
	const container = await new GenericContainer(DOLTGRES_IMAGE)
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
	const dbUrl = `postgresql://postgres:${PASSWORD}@${host}:${port}/${DB_NAME}`;
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
	return {
		container,
		sql: postgres(dbUrl, { max: 1, fetch_types: false }),
		dbUrl,
	};
}

// A seed/protocol failure must never touch the legacy writer, namespace or
// allocator floor. Each fixture gets its own migrated database in the same container.
export async function summaryDatabase(
	dbUrl: string,
	suffix: "precision" | "growth" | "board",
) {
	const slug = `node-template-work-items-summary-${suffix}`;
	const name = `knowledge_${slug.replaceAll("-", "_")}`;
	const bootstrap = postgres(dbUrl, { max: 1, fetch_types: false });
	try {
		await bootstrap.unsafe(`CREATE DATABASE ${name}`);
	} finally {
		await bootstrap.end({ timeout: 5 });
	}
	const url = new URL(dbUrl);
	url.pathname = `/${name}`;
	execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
		env: { ...process.env, DATABASE_URL: url.href, NODE_NAME: slug },
		encoding: "utf8",
		stdio: "pipe",
	});
	return url.href;
}

export const literal = (value: string) =>
	`'${value.replace(/\0/g, "").replace(/'/g, "''")}'`;

export async function commitSummarySeed(writer: Sql) {
	expect(
		(await writer.unsafe("SELECT active_branch() AS branch"))[0]?.branch,
	).toBe("main");
	await writer.unsafe("SELECT dolt_add('work_items')");
	const rows = await writer.unsafe(
		"SELECT dolt_commit('-m', 'native summary fixture')",
	);
	const hash = rows[0]?.dolt_commit;
	expect(typeof hash).toBe("string");
	expect(hash).toBeTruthy();
	return hash;
}

export async function verifySummarySeed(
	reader: Sql,
	expected: number,
	hash: unknown,
) {
	// This independent session is opened only AFTER the writer commits main.
	expect(
		(await reader.unsafe("SELECT active_branch() AS branch"))[0]?.branch,
	).toBe("main");
	expect(
		(await reader.unsafe("SELECT dolt_hashof('HEAD') AS hash"))[0]?.hash,
	).toBe(hash);
	const rows = await reader.unsafe("SELECT COUNT(*) AS count FROM work_items");
	expect(Number(rows[0]?.count)).toBe(expected);
	console.info(
		"work_summary_native_seed",
		JSON.stringify({
			expected,
			readerCount: Number(rows[0]?.count),
			branch: "main",
			hash,
		}),
	);
}
