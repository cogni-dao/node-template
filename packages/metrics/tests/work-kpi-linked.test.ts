// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * work.count@1 mode `kpi-linked`: the percent of open, non-synthetic work items
 * that name a metric in `moves`. One source call; an empty scope and a
 * malformed result are unknown, never zero.
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createGoalMetrics } from "../src/knowledge.js";
import { readWorkKpiLinked, WORK_KPI_LINKED_SQL } from "../src/sources.js";

type Row = Record<string, unknown>;
const signal = new AbortController().signal;
const ASOF = "2026-11-12T00:00:00.000Z";

/** Fake Sql whose `unsafe` answers from a function and records every statement. */
function fakeSql(answer: (text: string) => Row[] | Promise<Row[]>) {
	const queries: string[] = [];
	const sql = {
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(() => answer(text));
			return Object.assign(p, { cancel: () => undefined });
		},
	} as unknown as Sql;
	return { sql, queries };
}
const counts = (total: unknown, linked: unknown): Row[] => [
	{ as_of: ASOF, total, linked },
];

describe("work.count@1 kpi-linked source read", () => {
	it("issues one statement and reports the linked share as a percent", async () => {
		const { sql, queries } = fakeSql(() => counts("111", "3"));
		const sample = await readWorkKpiLinked(sql, signal);
		expect(queries).toEqual([WORK_KPI_LINKED_SQL]);
		expect(sample.complete).toBe(true);
		expect(sample.unit).toBe("%");
		expect(sample.value).toBeCloseTo(100 / 37, 10);
		expect(sample.sourceWatermarks).toEqual([
			{ source: "node.work_items", asOf: ASOF },
		]);
		expect(sample.evidenceRefs).toEqual([
			"node:work_items:count:kpi-linked:excludes-synthetic",
			"counts:evaluated=111;linked=3",
		]);
	});

	it("reads zero linked as a real 0 and all linked as 100", async () => {
		const none = fakeSql(() => counts(40, 0));
		expect(await readWorkKpiLinked(none.sql, signal)).toMatchObject({
			value: 0,
			complete: true,
		});
		const all = fakeSql(() => counts(40, 40));
		expect(await readWorkKpiLinked(all.sql, signal)).toMatchObject({
			value: 100,
			complete: true,
		});
	});

	it("maps an empty scope to zero_denominator, never 0", async () => {
		const { sql } = fakeSql(() => counts(0, 0));
		expect(await readWorkKpiLinked(sql, signal)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
	});

	it.each([
		["no row", [] as Row[]],
		["two rows", [...counts(2, 1), ...counts(2, 1)]],
		["a non-numeric count", counts("n/a", 1)],
		["a missing count", [{ as_of: ASOF, total: 5 }]],
		["more linked than open", counts(2, 3)],
		["a fractional count", counts(2.5, 1)],
	])("maps %s to incomplete_or_invalid_source", async (_name, rows) => {
		const { sql } = fakeSql(() => rows);
		expect(await readWorkKpiLinked(sql, signal)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it("scopes both counts to open, non-synthetic items and counts only entries with a metricId", () => {
		const open = "status NOT IN ('done','cancelled')";
		expect(WORK_KPI_LINKED_SQL.split(open)).toHaveLength(3);
		for (const label of ["test-fixture", "synthetic", "synthetic-fixture"])
			expect(WORK_KPI_LINKED_SQL).toContain(`NOT LIKE '%"${label}"%'`);
		// NULL (never declared) and [] (cleared) hold no key, so neither counts.
		expect(WORK_KPI_LINKED_SQL).toContain(
			`moves IS NOT NULL AND CAST(moves AS TEXT) LIKE '%"metricId"%'`,
		);
		expect(WORK_KPI_LINKED_SQL).not.toMatch(/INSERT|UPDATE|DELETE|DROP/i);
	});

	it("propagates a failed read instead of reporting zero", async () => {
		const { sql } = fakeSql(() => {
			throw new Error("relation does not exist");
		});
		await expect(readWorkKpiLinked(sql, signal)).rejects.toThrow();
	});
});

describe("work.count@1 registration", () => {
	const service = createGoalMetrics({
		knowledgeSql: fakeSql(() => counts(10, 4)).sql,
		observationsSql: fakeSql(() => []).sql,
		node: "test-node",
		environment: "test",
		log: () => undefined,
	});
	const count = service.registry.get("work.count@1");

	it("accepts the new mode and keeps open and validated as item volumes", () => {
		expect(count.paramsSchema.safeParse({ mode: "kpi-linked" }).success).toBe(
			true,
		);
		expect(count.paramsSchema.safeParse({ mode: "other" }).success).toBe(false);
		expect(count.unitFor?.({ mode: "kpi-linked" })).toBe("%");
		expect(count.displayFor?.({ mode: "kpi-linked" })).toBe("progress");
		for (const mode of ["open", "validated"]) {
			expect(count.unitFor?.({ mode })).toBe("items");
			expect(count.displayFor?.({ mode })).toBe("volume");
		}
	});

	it("keeps the one-call budget and computes through the source", async () => {
		expect(count.budget.maxSourceCalls).toBe(1);
		const { sql, queries } = fakeSql(() => counts(10, 4));
		const sample = await readWorkKpiLinked(sql, signal);
		expect(sample.value).toBe(40);
		expect(queries).toHaveLength(1);
	});
});
