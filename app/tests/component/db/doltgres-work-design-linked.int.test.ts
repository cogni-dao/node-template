// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Native regression (story.0069): the design-linked share's correlated EXISTS join to
 * `knowledge` runs on real Doltgres, counts only a typed link to a design atom on main,
 * and stays inside the work.count@1 budget at a production-size table. */
import postgres, { type Sql } from "postgres";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readWorkDesignLinked } from "../../../../packages/metrics/src/sources";

let container: StartedTestContainer;
let sql: Sql;
const signal = new AbortController().signal;
const refs = (...r: string[]) => JSON.stringify(r);

async function item(
	id: string,
	status: string,
	specRefs: string | null,
	labels = "[]",
) {
	await sql.unsafe(
		`INSERT INTO work_items VALUES ('${id}','${status}','${labels}'::jsonb,${specRefs === null ? "NULL" : `'${specRefs}'::jsonb`})`,
	);
}

beforeAll(async () => {
	container = await new GenericContainer("dolthub/doltgresql:0.57.3")
		.withEnvironment({ DOLTGRES_PASSWORD: "native-test" })
		.withExposedPorts(5432)
		.withWaitStrategy(Wait.forLogMessage(/server (started|listening)/i, 1))
		.start();
	sql = postgres(
		`postgresql://postgres:native-test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
		{ max: 1, fetch_types: false },
	);
	await sql.unsafe("CREATE TABLE knowledge (id text PRIMARY KEY, entry_type text)");
	await sql.unsafe(
		"CREATE TABLE work_items (id text PRIMARY KEY, status text, labels jsonb, spec_refs jsonb)",
	);
	await sql.unsafe(
		"INSERT INTO knowledge VALUES ('d1','design'),('d2','design'),('g1','guide')",
	);
	await item("task.1", "needs_implement", refs("knowledge:d1")); // linked
	await item("task.2", "needs_implement", refs("knowledge:g1")); // a guide, not a design
	await item("task.3", "needs_implement", refs("d1")); // untyped
	await item("task.4", "needs_implementation_review", refs()); // empty
	await item("task.5", "needs_closeout", null); // never set
	await item("task.6", "needs_validation", refs("knowledge:d1x")); // no such atom; d1 must not prefix-match
	await item("task.7", "needs_merge", refs("https://x.test/pr/1", "knowledge:d2")); // linked
	await item("task.8", "needs_design", refs("knowledge:d1")); // not past design
	await item("task.9", "done", refs("knowledge:d1")); // closed
	await item("task.10", "needs_implement", refs("knowledge:d1"), refs("synthetic")); // fixture
}, 180000);

afterAll(async () => {
	if (sql) await sql.end({ timeout: 3 });
	if (container) await container.stop();
});

it("counts only typed links to a design atom on main, over open items past design", async () => {
	const sample = await readWorkDesignLinked(sql, signal);
	expect(sample.evidenceRefs).toEqual([
		"node:work_items:count:design-linked:excludes-synthetic",
		"counts:evaluated=7;linked=2",
	]);
	expect(sample).toMatchObject({ complete: true, unit: "%" });
	expect(sample.value).toBeCloseTo(200 / 7, 10);
});

it("reads a production-size table well inside the 8 s budget", async () => {
	const values = (n: number, row: (i: number) => string) =>
		Array.from({ length: n }, (_, i) => row(i)).join(",");
	await sql.unsafe(
		`INSERT INTO knowledge VALUES ${values(700, (i) => `('atom-${i}','${i % 7 === 0 ? "design" : "guide"}')`)}`,
	);
	await sql.unsafe(
		`INSERT INTO work_items VALUES ${values(300, (i) => `('story.${1000 + i}','needs_implement','[]'::jsonb,'${refs(`knowledge:atom-${i}`, "https://x.test")}'::jsonb)`)}`,
	);
	const timings: number[] = [];
	for (let run = 0; run < 5; run++) {
		const start = performance.now();
		const sample = await readWorkDesignLinked(sql, signal);
		timings.push(performance.now() - start);
		expect(sample.complete).toBe(true);
	}
	// 300 items link atom-0..299; every seventh atom is a design: 43 of them, plus the two above.
	expect((await readWorkDesignLinked(sql, signal)).evidenceRefs[1]).toBe(
		"counts:evaluated=307;linked=45",
	);
	expect(Math.max(...timings)).toBeLessThan(4000);
});
