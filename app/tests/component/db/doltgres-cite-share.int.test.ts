// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Real Doltgres 0.57.3 proof for `work.cite-share@1` (story.0032).
 *
 * The unit tests run the two source statements on a fake client. This test runs
 * them on the engine that serves production: commits written by the real
 * work-items adapter (reason and cites in the message), read back through
 * `dolt_log`, with a fixture item left out.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCiteShare } from "@cogni-dao/metrics/sources";
import { toWorkItemId } from "@cogni/work-items";
import { DoltgresWorkItemAdapter } from "@cogni/work-items/adapters/doltgres";
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
const PASSWORD = "doltgres";
const DB_NAME = "knowledge_node_template_cite_share";
const COMMIT = "a".repeat(32);

const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
	source(new AbortController().signal);

describe("work.cite-share@1 source reads (real Doltgres)", () => {
	let container: StartedTestContainer;
	let writer: Sql;
	let reader: Sql;
	const window = {
		start: new Date(Date.now() - 3_600_000).toISOString(),
		end: new Date(Date.now() + 3_600_000).toISOString(),
	};

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
		const host = container.getHost();
		const port = container.getMappedPort(5432);
		const base = `postgresql://postgres:${PASSWORD}@${host}:${port}`;
		const bootstrap = postgres(`${base}/postgres`, {
			max: 1,
			fetch_types: false,
		});
		try {
			await bootstrap.unsafe(`CREATE DATABASE ${DB_NAME}`);
		} finally {
			await bootstrap.end({ timeout: 5 });
		}
		const dbUrl = `${base}/${DB_NAME}`;
		execFileSync(process.execPath, [MIGRATE_SCRIPT, MIGRATIONS_DIR], {
			env: {
				...process.env,
				DATABASE_URL: dbUrl,
				NODE_NAME: "node-template-cite-share",
			},
			encoding: "utf8",
			stdio: "pipe",
		});
		writer = postgres(dbUrl, { max: 1, fetch_types: false });
		reader = postgres(dbUrl, { max: 1, fetch_types: false });
	}, 180_000);

	afterAll(async () => {
		await Promise.all([writer?.end({ timeout: 5 }), reader?.end({ timeout: 5 })]);
		if (container) await container.stop();
	});

	it("scores patches from dolt_log, leaves a fixture item out and counts no creation", async () => {
		const adapter = new DoltgresWorkItemAdapter(writer, {
			readClient: reader,
			lockWaitMs: 250,
			lockRetryMs: 25,
			queryTimeoutMs: 5_000,
			// The resolver pins every cite to one commit; the hub is not under test.
			entryResolver: {
				resolve: async (refs) =>
					refs.map((ref) => ({
						id: ref.id,
						commit: COMMIT,
						plane: "main" as const,
					})),
			},
		});
		const principal = "cite-share-agent";
		const real = toWorkItemId("task.9801");
		const fixture = toWorkItemId("task.9802");
		await adapter.create({ id: real, type: "task", title: "Real work" }, principal);
		await adapter.create(
			{ id: fixture, type: "task", title: "Fixture", labels: ["test-fixture"] },
			principal,
		);
		for (let i = 0; i < 6; i++)
			await adapter.patch(
				{
					id: real,
					reason: `Cited change ${i}.`,
					cites: [{ id: "metrics-expert" }],
					set: { title: `Real work ${i}` },
				},
				principal,
			);
		for (let i = 0; i < 4; i++)
			await adapter.patch(
				{ id: real, reason: `Plain change ${i}.`, set: { summary: `Summary ${i}` } },
				principal,
			);
		for (let i = 0; i < 2; i++)
			await adapter.patch(
				{
					id: fixture,
					reason: `Fixture change ${i}.`,
					cites: [{ id: "metrics-expert" }],
					set: { title: `Fixture ${i}` },
				},
				principal,
			);

		const count = await readCiteShare(reader, "count", window, read);
		expect(count).toMatchObject({ value: 10, unit: "patches", complete: true });
		expect(count.evidenceRefs).toContain(
			"counts:patches=10;cited=6;withReason=10;fixtures_excluded=2;malformed=0;cites_unparsed=0",
		);
		expect(count.evidenceRefs).toContain("counts:cited_atoms=1");
		expect(count.evidenceRefs).toContain("top_atom:metrics-expert=6");
		expect(count.sourceWatermarks.map((w) => w.source)).toEqual([
			"node.dolt_log",
			"node.work_items",
		]);
		for (const mark of count.sourceWatermarks)
			expect(Number.isFinite(Date.parse(mark.asOf ?? ""))).toBe(true);

		const share = await readCiteShare(reader, "share", window, read);
		expect(share).toMatchObject({ value: 60, unit: "%", complete: true });

		// A window that ends before the commits holds no patch.
		const before = await readCiteShare(
			reader,
			"count",
			{
				start: new Date(Date.now() - 7_200_000).toISOString(),
				end: new Date(Date.now() - 3_600_000 - 1000).toISOString(),
			},
			read,
		);
		expect(before).toMatchObject({ value: 0, unit: "patches", complete: true });
	}, 180_000);
});
