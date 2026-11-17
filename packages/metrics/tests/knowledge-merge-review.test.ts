// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * knowledge.merge-review@1: merges in [T - days, T) and the share resolved by
 * someone other than the author. Counts, window edges, unknown states, and the
 * registered unit and params bounds per output.
 */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createGoalMetrics } from "../src/knowledge.js";
import { readKnowledgeMerges } from "../src/sources.js";

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
	const queries: string[] = [];
	const cancel = vi.fn();
	const sql = {
		unsafe(text: string) {
			queries.push(text);
			const p = Promise.resolve().then(() => answer(text));
			return Object.assign(p, { cancel });
		},
	} as unknown as Sql;
	return { sql, queries, cancel };
}

const window = {
	start: "2026-11-07T00:00:00.000Z",
	end: "2026-11-14T00:00:00.000Z",
};
const signal = () => new AbortController().signal;
const counted = {
	as_of: "2026-11-14T00:00:01.000Z",
	merged: 4,
	reviewed: 3,
	unresolved: 0,
};

describe("readKnowledgeMerges", () => {
	it("reads the half-open window edges as instants in one statement", async () => {
		const { sql, queries } = fakeSql(() => [counted]);
		await readKnowledgeMerges(
			sql,
			"share",
			{ start: "2026-11-07T00:00:00Z", end: "2026-11-14 00:00:00+00" },
			signal(),
		);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain(window.start);
		expect(queries[0]).toContain(window.end);
	});

	it("share is merges resolved by another principal over all merges", async () => {
		const { sql } = fakeSql(() => [counted]);
		const sample = await readKnowledgeMerges(sql, "share", window, signal());
		expect(sample.value).toBeCloseTo(3 / 4);
		expect(sample.unit).toBe("ratio");
		expect(sample.complete).toBe(true);
		expect(sample.sourceWatermarks[0]).toEqual({
			source: "node.doltgres.main",
			asOf: "2026-11-14T00:00:01.000Z",
		});
		expect(sample.evidenceRefs).toContain(
			"counts:merged=4;reviewed=3;unresolved=0",
		);
	});

	it("merged is the raw count, string counts included, and a genuine zero is complete", async () => {
		const { sql } = fakeSql(() => [
			{ ...counted, merged: "4", reviewed: "3", unresolved: "0" },
		]);
		const sample = await readKnowledgeMerges(sql, "merged", window, signal());
		expect(sample.value).toBe(4);
		expect(sample.unit).toBe("items");
		expect(sample.complete).toBe(true);
		const empty = fakeSql(() => [
			{ ...counted, merged: 0, reviewed: 0, unresolved: 0 },
		]);
		expect(
			await readKnowledgeMerges(empty.sql, "merged", window, signal()),
		).toMatchObject({ value: 0, complete: true });
	});

	it("no merges is a zero denominator, never a 0 share", async () => {
		const { sql } = fakeSql(() => [
			{ ...counted, merged: 0, reviewed: 0, unresolved: 0 },
		]);
		expect(
			await readKnowledgeMerges(sql, "share", window, signal()),
		).toMatchObject({ complete: false, reason: "zero_denominator" });
	});

	it("a merge with no resolver makes the share unknown but not the raw count", async () => {
		const { sql } = fakeSql(() => [{ ...counted, reviewed: 2, unresolved: 1 }]);
		expect(
			await readKnowledgeMerges(sql, "share", window, signal()),
		).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
		expect(
			await readKnowledgeMerges(sql, "merged", window, signal()),
		).toMatchObject({ value: 4, complete: true });
	});

	it("a missing row or inconsistent counts are incomplete, not zero", async () => {
		const missing = fakeSql(() => []);
		for (const output of ["share", "merged"] as const)
			expect(
				await readKnowledgeMerges(missing.sql, output, window, signal()),
			).toMatchObject({
				complete: false,
				reason: "incomplete_or_invalid_source",
			});
		const skewed = fakeSql(() => [{ ...counted, merged: 2, reviewed: 3 }]);
		expect(
			await readKnowledgeMerges(skewed.sql, "share", window, signal()),
		).toMatchObject({ complete: false });
	});

	it("an abort cancels the running query and rejects", async () => {
		const controller = new AbortController();
		const { sql, cancel } = fakeSql(() => {
			controller.abort();
			return [counted];
		});
		await expect(
			readKnowledgeMerges(sql, "share", window, controller.signal),
		).rejects.toThrow();
		expect(cancel).toHaveBeenCalled();
	});

	it("rejects a window edge that is not an instant, so nothing reaches the SQL text", async () => {
		const { sql, queries } = fakeSql(() => [counted]);
		await expect(
			readKnowledgeMerges(
				sql,
				"share",
				{ start: "x'; DROP TABLE t; --", end: window.end },
				signal(),
			),
		).rejects.toThrow("invalid_window");
		expect(queries).toHaveLength(0);
	});
});

describe("knowledge.merge-review@1 registration", () => {
	const service = createGoalMetrics({
		knowledgeSql: fakeSql(() => [counted]).sql,
		observationsSql: fakeSql(() => []).sql,
		node: "test-node",
		environment: "test",
		log: () => undefined,
	});
	const calculator = service.registry.get("knowledge.merge-review@1");

	it("reports ratio for share and items for merged, with matching display", () => {
		expect(calculator.unitFor?.({ output: "share", days: 7 })).toBe("ratio");
		expect(calculator.displayFor?.({ output: "share", days: 7 })).toBe(
			"progress",
		);
		expect(calculator.unitFor?.({ output: "merged", days: 7 })).toBe("items");
		expect(calculator.displayFor?.({ output: "merged", days: 7 })).toBe(
			"volume",
		);
		expect(calculator.windowSeconds?.({ output: "share", days: 7 })).toBe(
			7 * 86400,
		);
	});

	it("bounds params to a known output and 1..28 whole days", () => {
		const ok = (p: unknown) => calculator.paramsSchema.safeParse(p).success;
		expect(ok({ output: "share", days: 1 })).toBe(true);
		expect(ok({ output: "merged", days: 28 })).toBe(true);
		expect(ok({ output: "other", days: 7 })).toBe(false);
		expect(ok({ output: "share", days: 0 })).toBe(false);
		expect(ok({ output: "share", days: 29 })).toBe(false);
		expect(ok({ output: "share", days: 1.5 })).toBe(false);
		expect(ok({ output: "share", days: 7, extra: 1 })).toBe(false);
		expect(ok({ output: "share" })).toBe(false);
	});

	it("makes one bounded call", () => {
		expect(calculator.budget.maxSourceCalls).toBe(1);
		expect(calculator.budget.maxRows).toBe(1);
	});
});
