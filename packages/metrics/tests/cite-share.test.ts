// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * work.cite-share@1: the work-items-trailer@1 reader, the dolt_log source read with
 * its window, cap and failure map, fixture exclusion, and the calculator in the
 * goal-metric service.
 */
import { describe, expect, it } from "vitest";
import { parseCitePins, parsePatchCommit } from "../src/cite-share.js";
import {
	calculatorFamily,
	createGoalMetrics,
	PACKAGE_CALCULATOR_IDS,
	RESERVED_CALCULATOR_FAMILIES,
} from "../src/knowledge.js";
import {
	CITE_SHARE_MAX_BYTES,
	CITE_SHARE_MAX_ROWS,
	CITE_SHARE_MESSAGE_CHARS,
	CITE_SHARE_MIN_PATCHES,
	citeShareFixturesSql,
	citeShareLogSql,
	readCiteShare,
} from "../src/sources.js";
import { fakeSql, hub, metricRow, noObservations, type Row } from "./fakes.js";

const window = {
	start: "2026-11-10T12:00:00.000Z",
	end: "2026-11-11T12:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
	source(new AbortController().signal);
const ASOF = "2026-11-11T12:00:01.000Z";
const IN = "2026-11-11 06:00:00.000";
const H1 = "a".repeat(32);
const H2 = "0123456789abcdefghijklmnopqrstuv";
const ACTOR = "52d379aa-e925-4da9-8e6b-2fd62e8a10d0";

/** The message `@cogni-dao/work-items` writes for a patch. */
const message = (id: string, extra: string[] = []) =>
	[`work-items: patch ${id} by actor:${ACTOR}`, ...extra].join("\n");
let seq = 0;
const commit = (id: string, extra: string[] = [], over: Row = {}): Row => ({
	commit_hash: `c${String(++seq).padStart(31, "0")}`,
	at: IN,
	message: message(id, extra),
	...over,
});
const cited = (id: string, atom = "metrics-expert") =>
	commit(id, ["Reason: Scope follows the design.", `Cites: ${atom}@${H1}`]);
const plain = (id: string) => commit(id, ["Reason: Fix a typo."]);

/** A fake hub: the dolt_log statement answers from `log`; the work_items statement from `fixtures`. */
function logOf(log: Row[], fixtures: string[] = []) {
	return fakeSql((text) =>
		text.includes("FROM dolt_log")
			? log
			: fixtures.length > 0
				? fixtures.map((id) => ({ as_of: ASOF, id }))
				: [{ as_of: ASOF, id: null }],
	);
}
const run = async (
	log: Row[],
	output: "share" | "count" = "share",
	fixtures: string[] = [],
) => {
	const { sql, queries } = logOf(log, fixtures);
	return { sample: await readCiteShare(sql, output, window, read), queries };
};
const many = (c: number, p: number) => [
	...Array.from({ length: c }, (_, i) => cited(`task.${i}`)),
	...Array.from({ length: p }, (_, i) => plain(`task.${100 + i}`)),
];

describe("work-items-trailer@1", () => {
	it("reads a main pin, an inbox pin and the reason", () => {
		const parsed = parsePatchCommit(
			message("task.0086", [
				"Reason: Why.",
				`Cites: change-history-design@${H1}, metrics-expert@contrib-derek-x-1:${H2}`,
			]),
		);
		expect(parsed).toEqual({
			itemId: "task.0086",
			hasReason: true,
			hasCitesLine: true,
			cites: [
				{ id: "change-history-design", commit: H1 },
				{ id: "metrics-expert", commit: H2, contribution: "contrib-derek-x-1" },
			],
		});
	});

	it("counts no cite without a valid pin", () => {
		const bad = [
			`Cites: Upper-Case@${H1}`, // id pattern is lower case
			`Cites: atom@${"a".repeat(31)}`, // 31 hex characters
			`Cites: atom@${"w".repeat(32)}`, // w is not base32 (0-9, a-v)
			"Cites: atom",
			"Cites: ",
			`Cites: atom@contrib-:${H1}`, // empty inbox name
			`Cites: atom@other-x:${H1}`, // not a contrib- inbox
		];
		for (const line of bad)
			expect(
				parsePatchCommit(message("task.1", ["Reason: r.", line]))?.cites,
				line,
			).toEqual([]);
	});

	it("drops a bad entry and keeps a good one in the same line", () => {
		const parsed = parsePatchCommit(
			message("task.1", [`Cites: nope, good-atom@${H1}, also bad@x`]),
		);
		expect(parsed?.cites).toEqual([{ id: "good-atom", commit: H1 }]);
		expect(parseCitePins("")).toEqual([]);
	});

	it("matches each line only from its start", () => {
		// A reason cannot hold a line break, so trailer text inside it, an indented
		// line and a trailer on line 1 are not a Cites line.
		const text = `atom@${H1}`;
		for (const lines of [
			[`Reason: see Cites: ${text}`],
			[`Reason: r.`, ` Cites: ${text}`],
			[`Reason: r.`, `- Cites: ${text}`],
			[`Reason: r.`, `cites: ${text}`],
		])
			expect(parsePatchCommit(message("task.1", lines))?.cites, lines.join("|")).toEqual([]);
		expect(parsePatchCommit(`work-items: patch task.1 by actor:${ACTOR} Cites: ${text}`)).toBeNull();
		expect(parsePatchCommit(`Cites: ${text}\n${message("task.1")}`)).toBeNull();
	});

	it("takes the first Cites line, as the work-items history does", () => {
		const parsed = parsePatchCommit(
			message("task.1", [`Cites: a@${H1}`, `Cites: b@${H2}`]),
		);
		expect(parsed?.cites).toEqual([{ id: "a", commit: H1 }]);
	});

	it("reads a reason only when it has text", () => {
		expect(parsePatchCommit(message("task.1"))?.hasReason).toBe(false);
		expect(parsePatchCommit(message("task.1", ["Reason: "]))?.hasReason).toBe(false);
		expect(parsePatchCommit(message("task.1", ["Reason: x"]))?.hasReason).toBe(true);
	});

	it("is not a patch unless line 1 says so and the id is safe to quote", () => {
		for (const text of [
			null,
			undefined,
			"",
			"Merge branch 'contrib/x'",
			`work-items: claim task.1 by actor:${ACTOR}`,
			`work-items: create work item by actor:${ACTOR}`,
			"work-items: patch task.1 by actor:",
			`work-items: patch task.1 by actor:${ACTOR} extra`,
			`work-items: patch a'b by actor:${ACTOR}`,
			`work-items: patch ${"x".repeat(129)} by actor:${ACTOR}`,
		])
			expect(parsePatchCommit(text), String(text)).toBeNull();
	});
});

describe("work.cite-share@1 statements", () => {
	it("is one read-only dolt_log statement with UTC window bounds and the cap pushed down", () => {
		const text = citeShareLogSql(window);
		expect(text).toContain("FROM dolt_log l");
		expect(text).toContain("l.message LIKE 'work-items: patch %'");
		expect(text).toContain("l.date >= '2026-11-10 12:00:00.000'");
		expect(text).toContain("l.date < '2026-11-11 12:00:00.000'");
		expect(text).toContain(`substr(l.message, 1, ${CITE_SHARE_MESSAGE_CHARS + 1})`);
		expect(text).toContain(`LIMIT ${CITE_SHARE_MAX_ROWS + 1}`);
		// Doltgres 0.57.3: no dolt_diff table, no dolt_diff() function, no subquery.
		expect(text).not.toMatch(/dolt_diff/);
		expect(text).not.toMatch(/\(\s*SELECT/i);
		expect(text).not.toContain(";");
		expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
	});

	it("asks the work_items table only about the patched ids and the three fixture labels", () => {
		const text = citeShareFixturesSql(["task.1", "story.2"]);
		expect(text).toContain("LEFT JOIN work_items f ON f.id IN ('task.1', 'story.2')");
		expect(text).toContain("SELECT NOW() AS as_of");
		expect(citeShareFixturesSql([])).toContain("f.id IN ('')");
		// Any caller: an id that could hold a quote never reaches the statement.
		expect(() => citeShareFixturesSql(["task.1'; DROP TABLE work_items; --"])).toThrow(RangeError);
		for (const label of ['"test-fixture"', '"synthetic"', '"synthetic-fixture"'])
			expect(text).toContain(label);
		expect(text).not.toContain(";");
		expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
	});
});

describe("work.cite-share@1 read", () => {
	it("scores the share of patches that cite, in two statements", async () => {
		const { sample, queries } = await run(many(3, 9));
		expect(sample).toMatchObject({ value: 25, unit: "%", complete: true });
		expect(queries).toHaveLength(2);
		expect(queries[0]).toContain("FROM dolt_log l");
		expect(queries[1]).toContain("LEFT JOIN work_items f");
		expect(sample.sourceWatermarks).toEqual([
			{ source: "node.dolt_log", asOf: ASOF },
			{ source: "node.work_items", asOf: ASOF },
		]);
		expect(sample.evidenceRefs).toEqual([
			"rules:work-items-trailer@1",
			"window:[2026-11-10T12:00:00.000Z,2026-11-11T12:00:00.000Z)",
			"counts:patches=12;cited=3;withReason=12;fixtures_excluded=0;malformed=0;cites_unparsed=0",
			"counts:cited_atoms=1",
			"top_atom:metrics-expert=3",
		]);
	});

	it("counts a commit with a Cites line of no valid pin as not cited", async () => {
		const junk = commit("task.9", ["Reason: r.", "Cites: not-a-pin"]);
		const { sample } = await run([...many(2, 8), junk]);
		expect(sample).toMatchObject({ value: (100 * 2) / 11, complete: true });
	});

	it("counts a Cites line without a valid pin in evidence, so a format change shows", async () => {
		const junk = commit("task.9", ["Reason: r.", "Cites: not-a-pin"]);
		const { sample } = await run([...many(2, 7), junk]);
		expect(sample.evidenceRefs).toContain(
			"counts:patches=10;cited=2;withReason=10;fixtures_excluded=0;malformed=0;cites_unparsed=1",
		);
	});

	it("counts a cite only from a line start", async () => {
		const inReason = commit("task.9", [`Reason: Cites: a@${H1}`]);
		const { sample } = await run([...many(0, 9), inReason]);
		expect(sample).toMatchObject({ value: 0, complete: true });
	});

	it("keeps a real 100 and a real 0", async () => {
		expect((await run(many(10, 0))).sample).toMatchObject({ value: 100, complete: true });
		expect((await run(many(0, 10))).sample).toMatchObject({ value: 0, complete: true });
	});

	it("is insufficient_history under the minimum and zero_denominator with no patch", async () => {
		expect(CITE_SHARE_MIN_PATCHES).toBe(10);
		expect((await run(many(9, 0))).sample).toMatchObject({
			complete: false,
			reason: "insufficient_history",
		});
		const none = await run([]);
		expect(none.sample).toMatchObject({ complete: false, reason: "zero_denominator" });
		// The second statement still runs: it carries the server clock.
		expect(none.queries).toHaveLength(2);
	});

	it("serves the raw patch count for the guardrail, with no minimum", async () => {
		expect((await run(many(1, 1), "count")).sample).toMatchObject({
			value: 2,
			unit: "patches",
			complete: true,
		});
		expect((await run([], "count")).sample).toMatchObject({
			value: 0,
			unit: "patches",
			complete: true,
		});
	});

	it("leaves a fixture item's patches out of both counts", async () => {
		const log = [...many(5, 5), cited("task.fx"), plain("task.fx"), plain("task.fx")];
		const { sample } = await run(log, "share", ["task.fx"]);
		expect(sample).toMatchObject({ value: 50, complete: true });
		expect(sample.evidenceRefs).toContain(
			"counts:patches=10;cited=5;withReason=10;fixtures_excluded=3;malformed=0;cites_unparsed=0",
		);
		expect((await run(log, "count", ["task.fx"])).sample.value).toBe(10);
	});

	it("counts the same inbox or main cite of one atom once per patch and names the top atoms", async () => {
		const both = commit("task.1", [
			"Reason: r.",
			`Cites: a@${H1}, a@contrib-x-1:${H2}, b@${H1}`,
		]);
		const log = [both, cited("task.2", "a"), ...many(0, 8)];
		const { sample } = await run(log, "count");
		expect(sample.evidenceRefs).toContain("counts:cited_atoms=2");
		expect(sample.evidenceRefs).toContain("top_atom:a=2");
		expect(sample.evidenceRefs).toContain("top_atom:b=1");
	});

	it("skips a repeated commit and a row outside the window, and reports a malformed message", async () => {
		const one = cited("task.1");
		const outside = cited("task.2", "metrics-expert");
		outside.at = "2026-11-12 00:00:00.000";
		const early = plain("task.3");
		early.at = "2026-11-10 11:59:59.999";
		const edge = plain("task.4");
		edge.at = "2026-11-10 12:00:00.000";
		const merge = commit("task.5", [], {
			message: "work-items: patch task.5 by actor:",
		});
		const { sample } = await run([one, one, outside, early, edge, merge], "count");
		// `one` once; `edge` is inside [start, end); `outside` is at end + 12h, `early` is 1 ms before start.
		expect(sample.value).toBe(2);
		expect(sample.evidenceRefs).toContain(
			"counts:patches=2;cited=1;withReason=2;fixtures_excluded=0;malformed=1;cites_unparsed=0",
		);
	});

	it("excludes the end instant of the window", async () => {
		const atEnd = plain("task.1");
		atEnd.at = "2026-11-11 12:00:00.000";
		expect((await run([atEnd], "count")).sample.value).toBe(0);
	});

	it("never puts a reason or message text in evidence", async () => {
		const secret = "SECRET-REASON-TEXT";
		const { sample } = await run(
			[commit("task.1", [`Reason: ${secret}`, `Cites: a@${H1}`]), ...many(0, 9)],
			"count",
		);
		expect(sample.evidenceRefs.join("\n")).not.toContain(secret);
	});

	it("reads the same frozen history as equal", async () => {
		const log = many(4, 8);
		expect((await run(log)).sample).toEqual((await run(log)).sample);
	});

	describe("fails closed", () => {
		it("above the row cap, for either output", async () => {
			const rows = Array.from({ length: CITE_SHARE_MAX_ROWS + 1 }, (_, i) => plain(`task.${i}`));
			for (const output of ["share", "count"] as const) {
				const { sample, queries } = await run(rows, output);
				expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
				expect(sample.evidenceRefs.join()).toContain("cap_hit");
				expect(queries).toHaveLength(1);
			}
			const exact = Array.from({ length: CITE_SHARE_MAX_ROWS }, (_, i) => plain(`task.${i}`));
			expect((await run(exact, "count")).sample).toMatchObject({
				complete: true,
				value: CITE_SHARE_MAX_ROWS,
			});
		});

		it("on a message over the character cap, a bad date or a missing message", async () => {
			const good = plain("task.1");
			for (const row of [
				{ ...good, message: `${message("task.1")}${"x".repeat(CITE_SHARE_MESSAGE_CHARS)}` },
				{ ...good, at: "not a date" },
				{ ...good, message: null },
			]) {
				const { sample } = await run([row], "count");
				expect(sample, JSON.stringify(row).slice(0, 80)).toMatchObject({
					complete: false,
					reason: "incomplete_or_invalid_source",
				});
			}
		});

		it("above the byte cap, with multi-byte messages inside the character cap", async () => {
			// 4800 UTF-16 units of 4 bytes per 2 units: about 9.6 KB a row, so 1800 rows pass 16 MiB.
			const wide = (i: number) =>
				commit(`task.${i}`, [`Reason: ${"\u{1F600}".repeat(2400)}`]);
			const rows = Array.from({ length: 1800 }, (_, i) => wide(i));
			const { sample, queries } = await run(rows, "count");
			expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
			expect(sample.evidenceRefs.join()).toContain("byte_cap_hit");
			expect(queries).toHaveLength(1);
			expect((await run(rows.slice(0, 1700), "count")).sample.complete).toBe(true);
		});

		it("when the fixture read has no server clock", async () => {
			const { sql } = fakeSql((text) => (text.includes("FROM dolt_log") ? many(3, 9) : []));
			expect(await readCiteShare(sql, "share", window, read)).toMatchObject({
				complete: false,
				reason: "incomplete_or_invalid_source",
			});
		});

		it("when the fixture read fails", async () => {
			const { sql } = fakeSql((text) => {
				if (text.includes("FROM dolt_log")) return many(3, 9);
				throw new TypeError("relation work_items SECRET-BODY-TEXT");
			});
			const sample = await readCiteShare(sql, "share", window, read);
			expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
			expect(sample.evidenceRefs).toContain("error:TypeError");
			expect(sample.evidenceRefs.join("\n")).not.toContain("SECRET");
		});
	});

	it("maps a failed log read to source_failed and keeps a timeout its own failure", async () => {
		const failing = fakeSql(() => {
			throw new RangeError("dolt_log panic SECRET-BODY-TEXT");
		});
		const sample = await readCiteShare(failing.sql, "share", window, read);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		expect(sample.evidenceRefs).toContain("error:RangeError");
		expect(sample.evidenceRefs.join("\n")).not.toContain("SECRET");
		expect(failing.queries).toHaveLength(1);
		const controller = new AbortController();
		const slow = fakeSql(async () => {
			controller.abort();
			throw new Error("canceled");
		});
		await expect(
			readCiteShare(slow.sql, "share", window, (source) => source(controller.signal)),
		).rejects.toThrow();
	});
});

describe("work.cite-share@1 in the goal-metric service", () => {
	const spec = {
		share: { output: "share", hours: 24 },
		count: { output: "count", hours: 24 },
	} as const;

	it("is a published calculator whose family no node calculator may take", () => {
		expect(PACKAGE_CALCULATOR_IDS).toContain("work.cite-share@1");
		expect(calculatorFamily("work.cite-share@1")).toBe("work.cite-share");
		expect(RESERVED_CALCULATOR_FAMILIES.has("work.cite-share")).toBe(true);
		const { reader } = hub([]);
		const node = {
			id: "work.cite-share@2",
			unit: "%",
			paramsSchema: reader.registry.get("work.cite-share@1").paramsSchema,
			budget: { timeoutMs: 1000, maxSourceCalls: 1, maxRows: 1, maxResponseBytes: 1024 },
			compute: async () => {
				throw new Error("unused");
			},
		};
		expect(() =>
			createGoalMetrics({
				knowledgeSql: fakeSql(() => []).sql,
				observationsSql: noObservations,
				node: "n",
				environment: "test",
				log: () => undefined,
				nodeCalculators: [node],
			}),
		).toThrow(expect.objectContaining({ code: "reserved_calculator_family", status: 422 }));
	});

	it("registers last among the package calculators with the designed budget and strict params", () => {
		const { reader } = hub([]);
		expect(reader.registry.describe().map((c) => c.id)).toEqual([...PACKAGE_CALCULATOR_IDS]);
		const calc = reader.registry.get("work.cite-share@1");
		expect(calc.budget).toEqual({
			timeoutMs: 15000,
			maxSourceCalls: 2,
			maxRows: CITE_SHARE_MAX_ROWS + 1,
			maxResponseBytes: CITE_SHARE_MAX_BYTES,
		});
		expect(calc.historicalWindows).toBe(true);
		expect(calc.windowSeconds?.(spec.share)).toBe(86400);
		expect(calc.unitFor?.(spec.share)).toBe("%");
		expect(calc.unitFor?.(spec.count)).toBe("patches");
		expect(calc.displayFor?.(spec.share)).toBe("progress");
		expect(calc.displayFor?.(spec.count)).toBe("volume");
		const ok = (params: unknown) => calc.paramsSchema.safeParse(params).success;
		expect(ok(spec.share)).toBe(true);
		expect(ok({ output: "share", hours: 1 })).toBe(true);
		expect(ok({ output: "share", hours: 72 })).toBe(true);
		for (const bad of [
			{ output: "share", hours: 0 },
			{ output: "share", hours: 73 },
			{ output: "share", hours: 1.5 },
			{ output: "ratio", hours: 24 },
			{ output: "share" },
			{ hours: 24 },
			{ output: "share", hours: 24, subject: "x" },
		])
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
	});

	it("computes the share and the guardrail from reviewed hub rows over the live clock", async () => {
		const stamp = (rows: Row[]): Row[] => {
			const at = new Date(Date.now() - 3_600_000).toISOString().replace("T", " ").replace("Z", "");
			return rows.map((r) => ({ ...r, at }));
		};
		const { service } = hub(
			[
				metricRow("decisions-cite-atoms-24h", "work.cite-share@1", spec.share),
				metricRow("work-item-patches-24h", "work.cite-share@1", spec.count),
			],
			(text) =>
				text.includes("FROM dolt_log")
					? stamp(many(3, 9))
					: [{ as_of: new Date(Date.now() - 60_000).toISOString(), id: null }],
		);
		const share = await service.compute("decisions-cite-atoms-24h", { requestKey: "k1" });
		expect(share, JSON.stringify(share)).toMatchObject({ status: "ok", value: 25, unit: "%" });
		const count = await service.compute("work-item-patches-24h", { requestKey: "k2" });
		expect(count).toMatchObject({ status: "ok", value: 12, unit: "patches" });
		const span = Date.parse(share.window.end) - Date.parse(share.window.start);
		expect(span).toBe(86_400_000);
	});
});
