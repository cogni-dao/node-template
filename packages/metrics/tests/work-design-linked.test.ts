// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * work.count@1 mode `design-linked` (story.0069): the percent of open, non-synthetic
 * work items past design whose `specRefs` names a design atom on main. One source
 * call in the `kpi-linked` shape; the real join runs against Doltgres in
 * app/tests/component/db/doltgres-work-design-linked.int.test.ts.
 */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createGoalMetrics } from "../src/knowledge.js";
import {
	readWorkDesignLinked,
	WORK_DESIGN_LINKED_SQL,
} from "../src/sources.js";

type Row = Record<string, unknown>;
const signal = new AbortController().signal;
const ASOF = "2026-11-18T00:00:00.000Z";

function fakeSql(answer: () => Row[]) {
	const queries: string[] = [];
	const sql = {
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(answer);
			return Object.assign(p, { cancel: () => undefined });
		},
	} as unknown as Sql;
	return { sql, queries };
}
const counts = (total: unknown, linked: unknown): Row[] => [
	{ as_of: ASOF, total, linked },
];

describe("work.count@1 design-linked", () => {
	it("reads the linked share as a percent and names its own mode in the evidence", async () => {
		const { sql, queries } = fakeSql(() => counts(94, 16));
		const sample = await readWorkDesignLinked(sql, signal);
		expect(queries).toEqual([WORK_DESIGN_LINKED_SQL]);
		expect(sample).toMatchObject({ complete: true, unit: "%" });
		expect(sample.value).toBeCloseTo((100 * 16) / 94, 10);
		expect(sample.evidenceRefs).toEqual([
			"node:work_items:count:design-linked:excludes-synthetic",
			"counts:evaluated=94;linked=16",
		]);
	});

	it("keeps an empty scope unknown, never 0", async () => {
		const { sql } = fakeSql(() => counts(0, 0));
		expect(await readWorkDesignLinked(sql, signal)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
	});

	it("registers the mode as a percent with the one-call budget", () => {
		const count = createGoalMetrics({
			knowledgeSql: fakeSql(() => counts(10, 4)).sql,
			observationsSql: fakeSql(() => []).sql,
			node: "test-node",
			environment: "test",
			log: () => undefined,
		}).registry.get("work.count@1");
		expect(count.paramsSchema.safeParse({ mode: "design-linked" }).success).toBe(true);
		expect(count.unitFor?.({ mode: "design-linked" })).toBe("%");
		expect(count.displayFor?.({ mode: "design-linked" })).toBe("progress");
		expect(count.budget.maxSourceCalls).toBe(1);
	});
});
