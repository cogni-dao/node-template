// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** Published goal-metric composition and Dolt-history source readers, without a node app. */
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresMetricObservations } from "../src/adapters/postgres.js";
import {
	createGoalMetrics,
	createGoalSource,
	type GoalKnowledgeReader,
} from "../src/knowledge.js";
import {
	doltInstant,
	FIRST_PARENT_WALK_CAP,
	RECORDED_HEAD_MAX_GAP_SECONDS,
	type RecordedMainHeads,
	readWorkConvergence,
} from "../src/sources.js";

type Row = Record<string, unknown>;
function fakeSql(answer: (text: string) => Row[]) {
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
const window = {
	start: "2026-10-26T00:00:00.000Z",
	end: "2026-11-02T00:00:00.000Z",
};
const read = <T>(source: (signal: AbortSignal) => Promise<T>) =>
	source(new AbortController().signal);
const B = "b".repeat(32);
const C = "c".repeat(32);

describe("@cogni-dao/metrics/sources", () => {
	it("reads Dolt commit dates in every UTC text form", () => {
		const want = "2026-11-04T21:44:01.123Z";
		for (const raw of [
			"2026-11-04 21:44:01.123",
			"2026-11-04 21:44:01.123+00",
			"2026-11-04 21:44:01.123 +0000",
			"2026-11-04 21:44:01.123 UTC",
			new Date(want),
		])
			expect(doltInstant(raw), String(raw)).toBe(want);
		expect(doltInstant("not a date")).toBeNull();
	});
	it("takes window edges from main's reflog and publishes the walk cap", async () => {
		const { sql, queries } = fakeSql((text) => {
			if (text.includes("dolt_reflog('main')"))
				return text.includes("2026-10-26 00:00:00.000")
					? [{ commit_hash: C, at: "2026-10-25 23:59:00" }]
					: [{ commit_hash: B, at: "2026-11-01 20:16:32.828" }];
			if (text.includes("dolt_diff(")) return [{ validated: "3" }];
			return [
				{
					as_of: "2026-11-02T00:00:01.000Z",
					created_work: "4",
					created_contributions: "2",
					merged_contributions: "1",
				},
			];
		});
		const sample = await readWorkConvergence(sql, "ratio", window, read);
		expect(sample).toMatchObject({ value: 4 / 6, complete: true });
		expect(FIRST_PARENT_WALK_CAP).toBe(5000);
		expect(sample.evidenceRefs).toContain("dolt:edge:reflog;walk-cap=5000");
		expect(queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(false);
	});
	it("reports a failed history step as unknown, never zero", async () => {
		const { sql } = fakeSql((text) => {
			if (text.includes("dolt_reflog") || text.includes("WITH RECURSIVE"))
				return [];
			return [
				{
					as_of: "2026-11-02T00:00:01.000Z",
					created_work: "1",
					created_contributions: "0",
					merged_contributions: "0",
				},
			];
		});
		const sample = await readWorkConvergence(sql, "ratio", window, read);
		expect(sample).toMatchObject({
			complete: false,
			reason: "history_unavailable",
		});
		expect(sample.evidenceRefs).toContain("dolt:history:walk_empty");
	});
});

const H = "d".repeat(32);
const counts = {
	as_of: "2026-11-02T00:00:01.000Z",
	created_work: "4",
	created_contributions: "2",
	merged_contributions: "1",
};
/** Reflog empty (fresh server); walk capped; main head H; diff 3. */
function freshServer(over: { reflogEnd?: string; walk?: Row[] } = {}) {
	return fakeSql((text) => {
		if (text.includes("dolt_reflog('main')"))
			return over.reflogEnd && !text.includes("2026-10-26 00:00:00.000")
				? [{ commit_hash: over.reflogEnd, at: "2026-11-01 23:59:00" }]
				: [];
		if (text.includes("WITH RECURSIVE"))
			return (
				over.walk ??
				Array.from({ length: FIRST_PARENT_WALK_CAP + 1 }, (_, depth) => ({
					commit_hash: B,
					depth,
					date: "2026-11-01 20:16:32.828",
				}))
			);
		if (text.includes("dolt_diff(")) return [{ validated: "3" }];
		if (text.includes("dolt_hashof('main') AS head"))
			return [{ head: H, head_at: "2026-11-02T00:00:01.000Z" }];
		return [counts];
	});
}
/** Recorded heads by time; returns what the injected store would. */
function recordedHeads(byAt: Record<string, { hash: string; at: string }>) {
	const asked: string[] = [];
	const heads: RecordedMainHeads = async (at, maxGapSeconds) => {
		asked.push(at);
		expect(maxGapSeconds).toBe(RECORDED_HEAD_MAX_GAP_SECONDS);
		return byAt[at] ?? null;
	};
	return { heads, asked };
}

describe("convergence edges from recorded main heads (task.0036)", () => {
	it("records main's head on every output, created included, without touching history", async () => {
		const { sql, queries } = freshServer();
		const sample = await readWorkConvergence(sql, "created", window, read);
		expect(sample).toMatchObject({ value: 6, complete: true });
		expect(sample.evidenceRefs).toContain(
			`dolt:head:${H}@2026-11-02T00:00:01.000Z`,
		);
		expect(queries.some((q) => q.includes("dolt_reflog"))).toBe(false);
		expect(queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(false);
		// An unreadable head drops only its evidence, never the reading.
		const broken = fakeSql((text) => {
			if (text.includes("dolt_hashof('main') AS head"))
				throw new Error("no such function");
			return [counts];
		});
		const kept = await readWorkConvergence(broken.sql, "created", window, read);
		expect(kept).toMatchObject({ value: 6, complete: true });
		expect(kept.evidenceRefs.some((r) => r.startsWith("dolt:head:"))).toBe(
			false,
		);
	});
	it("takes both edges from recorded heads when the reflog does not reach back, and skips the capped walk", async () => {
		const { sql, queries } = freshServer();
		const { heads } = recordedHeads({
			[window.start]: { hash: C, at: "2026-10-25T23:00:00.000Z" },
			[window.end]: { hash: B, at: "2026-11-01T23:30:00.000Z" },
		});
		const sample = await readWorkConvergence(
			sql,
			"validated",
			window,
			read,
			heads,
		);
		expect(sample).toMatchObject({ value: 4, complete: true });
		expect(sample.evidenceRefs).toContain(
			"dolt:edge:recorded-head;walk-cap=5000",
		);
		expect(sample.evidenceRefs).toContain(
			`dolt:main:${C}..${B}@2026-11-01T23:30:00.000Z`,
		);
		expect(sample.evidenceRefs).toContain(
			`dolt:head:${H}@2026-11-02T00:00:01.000Z`,
		);
		expect(queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(false);
		expect(queries.find((q) => q.includes("dolt_diff("))).toContain(
			`dolt_diff('${C}', '${B}', 'work_items')`,
		);
	});
	it("ignores a recorded head older than the max gap and keeps today's walk_cap result", async () => {
		const { sql, queries } = freshServer();
		const tooOld = new Date(
			Date.parse(window.start) - RECORDED_HEAD_MAX_GAP_SECONDS * 1000 - 1,
		).toISOString();
		const afterStart = "2026-10-26T00:00:00.001Z";
		for (const at of [tooOld, afterStart]) {
			const { heads } = recordedHeads({ [window.start]: { hash: C, at } });
			const sample = await readWorkConvergence(
				sql,
				"ratio",
				window,
				read,
				heads,
			);
			expect(sample).toMatchObject({
				complete: false,
				reason: "history_unavailable",
			});
			expect(sample.evidenceRefs).toContain("dolt:history:walk_cap");
		}
		expect(queries.some((q) => q.includes("dolt_diff("))).toBe(false);
	});
	it("orders edge sources reflog, then recorded heads, then the first-parent walk", async () => {
		// Reflog covers the end only: start from a recorded head, end from the reflog.
		const mixed = freshServer({ reflogEnd: B });
		const one = recordedHeads({
			[window.start]: { hash: C, at: "2026-10-25T23:00:00.000Z" },
		});
		const sample = await readWorkConvergence(
			mixed.sql,
			"validated",
			window,
			read,
			one.heads,
		);
		expect(sample.evidenceRefs).toContain(
			"dolt:edge:recorded-head+reflog;walk-cap=5000",
		);
		// The end was in the reflog, so its recorded head was never asked for.
		expect(one.asked).toEqual([window.start]);
		const reflogStarts = mixed.queries.findIndex(
			(q) => q.includes("dolt_reflog") && q.includes("2026-10-26 00:00:00.000"),
		);
		const reflogEnds = mixed.queries.findIndex(
			(q) => q.includes("dolt_reflog") && q.includes("2026-11-02 00:00:00.000"),
		);
		expect(reflogStarts).toBeGreaterThan(-1);
		expect(reflogEnds).toBeGreaterThan(reflogStarts);
		// No reflog and no recorded head: the walk decides, and a young chain is building.
		const young = freshServer({
			walk: [{ commit_hash: B, depth: 0, date: "2026-11-01 20:16:32.828" }],
		});
		const none = recordedHeads({});
		const building = await readWorkConvergence(
			young.sql,
			"ratio",
			window,
			read,
			none.heads,
		);
		expect(building).toMatchObject({
			complete: false,
			reason: "insufficient_history",
		});
		expect(none.asked).toEqual([window.start]);
		expect(young.queries.some((q) => q.includes("WITH RECURSIVE"))).toBe(true);
		// Start from a recorded head, end only from the walk, which stops at the end.
		const tail = freshServer({
			walk: [
				{ commit_hash: H, depth: 0, date: "2026-11-02 00:00:00.500" },
				{ commit_hash: B, depth: 1, date: "2026-11-01 20:16:32.828" },
			],
		});
		const start = recordedHeads({
			[window.start]: { hash: C, at: "2026-10-25T23:00:00.000Z" },
		});
		const walked = await readWorkConvergence(
			tail.sql,
			"validated",
			window,
			read,
			start.heads,
		);
		expect(walked.evidenceRefs).toContain(
			"dolt:edge:recorded-head+first-parent:1;walk-cap=5000",
		);
		expect(start.asked).toEqual([window.start, window.end]);
		expect(tail.queries.find((q) => q.includes("WITH RECURSIVE"))).toContain(
			"chain.date > '2026-11-02 00:00:00.000'",
		);
	});
});

describe("PostgresMetricObservations.recordedMainHead", () => {
	it("issues one bounded, scoped lookup over ok readings and returns the newest head", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			calls.push({ text: strings.join("$"), values });
			const p = Promise.resolve([
				{ hash: C, at: "2026-10-25T23:00:00.000Z" },
			]);
			return Object.assign(p, { cancel: () => undefined });
		}) as unknown as Sql;
		const store = new PostgresMetricObservations(sql, {
			node: "n",
			environment: "candidate-a",
			dataScope: "node-members",
		});
		expect(
			await store.recordedMainHead(
				"work.convergence@1",
				window.start,
				RECORDED_HEAD_MAX_GAP_SECONDS,
			),
		).toEqual({ hash: C, at: "2026-10-25T23:00:00.000Z" });
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.text).toContain("o.status='ok'");
		expect(call?.text).toContain("o.observation->>'calculatorVersion'=");
		expect(call?.text).toContain("ORDER BY h.at DESC LIMIT 1");
		expect(call?.values).toContain("n/candidate-a/node-members");
		expect(call?.values).toContain("work.convergence@1");
		expect(call?.values).toContain(RECORDED_HEAD_MAX_GAP_SECONDS);
	});
});

describe("@cogni-dao/metrics/knowledge", () => {
	it("scopes the service to the injected node and keeps the convergence budget", () => {
		const service = createGoalMetrics({
			knowledgeSql: fakeSql(() => []).sql,
			observationsSql: fakeSql(() => []).sql,
			node: "test-node",
			environment: "test",
			log: () => undefined,
		});
		const convergence = service.registry.get("work.convergence@1");
		// Counts + head + 2 edges x (reflog, recorded head) + walk + diff.
		expect(convergence.budget.maxSourceCalls).toBe(8);
		expect(convergence.budget.maxRows).toBe(FIRST_PARENT_WALK_CAP + 5);
		expect(service.registry.describe().map((c) => c.id)).toEqual([
			"work.count@1",
			"work.convergence@1",
			"github.stars@1",
		]);
	});
	it("projects goals and their newest hypothesis outcome from a structural knowledge reader", async () => {
		const at = (iso: string) => new Date(iso);
		type Entry = Awaited<ReturnType<GoalKnowledgeReader["getKnowledge"]>>;
		const rows: Record<string, Entry> = {
			"goal-a": { id: "goal-a", title: "Goal", kpiBindings: [{ x: 1 }] },
			"bet-1": {
				id: "bet-1",
				title: "Bet",
				entryType: "hypothesis",
				evaluateAt: at("2026-12-01T00:00:00Z"),
			},
			"note-1": { id: "note-1", title: "Note", entryType: "guide" },
			"out-old": { id: "out-old", title: "Old" },
			"out-new": { id: "out-new", title: "New" },
		};
		const edges: Record<
			string,
			Array<{ citingId: string; citationType: string; createdAt?: Date }>
		> = {
			"goal-a": [
				{ citingId: "note-1", citationType: "extends" },
				{ citingId: "bet-1", citationType: "extends" },
				{ citingId: "bet-1", citationType: "supports" },
			],
			"bet-1": [
				{
					citingId: "out-old",
					citationType: "validates",
					createdAt: at("2026-10-01T00:00:00Z"),
				},
				{
					citingId: "out-new",
					citationType: "invalidates",
					createdAt: at("2026-11-01T00:00:00Z"),
				},
			],
		};
		const source = createGoalSource({
			listActiveGoals: async () => [
				{ id: "goal-a", title: "Goal", evaluateAt: null },
			],
			getKnowledge: async (id) => rows[id] ?? null,
			listCitationsByCitedId: async (id) => edges[id] ?? [],
		});
		expect(await source.listGoals()).toEqual([
			{
				id: "goal-a",
				title: "Goal",
				evaluateAt: null,
				kpiBindings: [{ x: 1 }],
			},
		]);
		expect(await source.hypotheses("goal-a")).toEqual({
			items: [
				{
					id: "bet-1",
					title: "Bet",
					evaluateAt: "2026-12-01T00:00:00.000Z",
					kpiBindings: [],
					outcome: { id: "out-new", title: "New", supports: false },
				},
			],
			more: false,
		});
	});
});
