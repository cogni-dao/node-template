// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Shared knowledge-usage measurement (story.0061). Each case names the defect it guards:
 * - writes must grow with distinct keys, never with read volume, even when a caller invents missing ids;
 * - a failing database must never reach the read or patch that was recorded;
 * - an empty day must read unknown, never a healthy 0% miss share, and sentinels are never ranked as fixable.
 */
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
	CitePairRecorder,
	INVALID_ATOM_KEY,
	KnowledgeReadCounter,
	MISSED_IDS_PER_PRINCIPAL_DAY,
	OVERFLOW_ATOM_KEY,
	readKnowledgeReads,
	type KnowledgeRead,
	type UsageLogEvent,
} from "../src/usage";

/** A postgres client whose transactions record each statement's params, optionally failing. */
function fakeSql(fail = false) {
	const statements: Array<{ text: string; params: unknown[] }> = [];
	const sql = {
		begin: async (fn: (tx: unknown) => Promise<void>) =>
			fn({
				unsafe: async (text: string, params: unknown[] = []) => {
					if (text.startsWith("SET LOCAL")) return [];
					statements.push({ text, params });
					if (fail) throw new Error("db down");
					return [];
				},
			}),
	} as unknown as Sql;
	return { sql, statements };
}

const read = (atomId: string, outcome: "ok" | "fail" = "ok"): KnowledgeRead => ({
	atomId,
	outcome,
	principalId: "agent-1",
	principalClass: "external_agent",
});
const fixedNow = () => new Date("2026-11-18T12:00:00Z");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("KnowledgeReadCounter", () => {
	it("folds any number of reads of one key into one row in one sorted upsert", async () => {
		const { sql, statements } = fakeSql();
		const events: UsageLogEvent[] = [];
		const counter = new KnowledgeReadCounter(sql, (e) => events.push(e), fixedNow);
		for (let i = 0; i < 1_000; i += 1) counter.count(read("b"));
		for (let i = 0; i < 10; i += 1) counter.count(read("a", "fail"));
		await counter.flush();

		expect(statements).toHaveLength(1);
		expect(statements[0]?.params).toEqual([
			"2026-11-18", "a", "agent-1", "external_agent", 0, 10,
			"2026-11-18", "b", "agent-1", "external_agent", 1_000, 0,
		]);
		expect(events).toEqual([
			expect.objectContaining({
				event: "knowledge.read_counts_flushed",
				keys: 2,
				reads: 1_010,
				byClass: { external_agent: { ok: 1_000, fail: 10 } },
			}),
		]);
	});

	it("bounds the keys a caller can create with invented missing ids", async () => {
		const { sql, statements } = fakeSql();
		const counter = new KnowledgeReadCounter(sql, () => undefined, fixedNow);
		for (let i = 0; i < 1_000; i += 1) counter.count(read(`made-up-${i}`, "fail"));
		counter.count(read("../../etc/passwd", "fail"));
		await counter.flush();

		const atoms = (statements[0]?.params ?? []).filter((_, i) => i % 6 === 1);
		expect(atoms).toHaveLength(MISSED_IDS_PER_PRINCIPAL_DAY + 2);
		expect(atoms).toContain(OVERFLOW_ATOM_KEY);
		expect(atoms).toContain(INVALID_ATOM_KEY);
	});

	it("never surfaces a failed flush, logs it, and keeps the counts for the next flush", async () => {
		const failing = fakeSql(true);
		const events: UsageLogEvent[] = [];
		const counter = new KnowledgeReadCounter(failing.sql, (e) => events.push(e), fixedNow);
		expect(() => counter.count(read("a"))).not.toThrow();
		await expect(counter.flush()).resolves.toBeUndefined();
		await counter.flush();
		expect(events).toEqual([
			expect.objectContaining({ event: "knowledge.read_count_write_failed", reason: "flush_failed", reads: 1 }),
			expect.objectContaining({ event: "knowledge.read_count_write_failed", reason: "flush_failed", reads: 1 }),
		]);
	});
});

describe("CitePairRecorder", () => {
	it("writes one row per distinct cited atom, pinned to the patch's revision", async () => {
		const { sql, statements } = fakeSql();
		new CitePairRecorder(sql, () => undefined).record("story.0061", "33", [{ id: "b" }, { id: "a" }, { id: "b" }]);
		await settle();
		expect(statements[0]?.text).toContain("ON CONFLICT DO NOTHING");
		expect(statements[0]?.params).toEqual(["a", "story.0061", 33, "b", "story.0061", 33]);
	});

	it("never throws into the patch and logs a failed insert", async () => {
		const { sql } = fakeSql(true);
		const events: UsageLogEvent[] = [];
		const recorder = new CitePairRecorder(sql, (e) => events.push(e));
		expect(() => recorder.record("story.0061", "33", [{ id: "a" }])).not.toThrow();
		await settle();
		await settle();
		expect(events).toEqual([
			expect.objectContaining({ event: "knowledge.cite_pairs_write_failed", reason: "insert_failed", pairs: 1 }),
		]);
	});
});

describe("readKnowledgeReads", () => {
	function answer(row: Record<string, unknown>) {
		const queries: Array<{ text: string; params: unknown[] }> = [];
		const sql = {
			unsafe(text: string, params: unknown[] = []) {
				queries.push({ text, params });
				return Object.assign(Promise.resolve([row]), { cancel: vi.fn() });
			},
		} as unknown as Sql;
		return { sql, queries };
	}
	const window = { start: "2026-11-19T05:00:00.000Z", end: "2026-11-20T05:00:00.000Z" };
	const day = {
		day: "2026-11-19",
		as_of: "2026-11-20T05:00:01.000Z",
		units: 40,
		miss_units: 10,
		reads: 450,
		principals: 3,
		top_misses: [{ atom_id: "dead-link", n: 7, principals: 1 }],
		top_reads: [{ atom_id: "node-template-architect", n: 90, principals: 3 }],
	};

	it("reads the miss share of the last full UTC day and never ranks sentinels", async () => {
		const { sql, queries } = answer(day);
		const sample = await readKnowledgeReads(sql, { measure: "miss_share" }, window, new AbortController().signal);
		expect(queries[0]?.params).toEqual([window.end]);
		expect(queries[0]?.text).toContain("AT TIME ZONE 'UTC'");
		expect(queries[0]?.text.match(/NOT IN \('\*invalid\*', '\*overflow\*'\)/g)).toHaveLength(2);
		expect(sample).toMatchObject({ value: 0.25, unit: "ratio", complete: true });
		expect(sample.evidenceRefs).toContain("node:knowledge_read_daily:day=2026-11-19");
	});

	it("returns the unit count as the guardrail", async () => {
		const { sql } = answer(day);
		const sample = await readKnowledgeReads(sql, { measure: "read_units" }, window, new AbortController().signal);
		expect(sample).toMatchObject({ value: 40, unit: "units", complete: true });
	});

	it("reports an empty day as unknown, never as a 0% miss share", async () => {
		const { sql } = answer({ ...day, units: 0, miss_units: 0, reads: 0, principals: 0, top_misses: [], top_reads: [] });
		const sample = await readKnowledgeReads(sql, { measure: "miss_share" }, window, new AbortController().signal);
		expect(sample).toMatchObject({ complete: false, reason: "zero_denominator" });
	});
});
