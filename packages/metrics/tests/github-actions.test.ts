// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * github.actions@1: CI health read from the Actions runs list. The reader runs
 * against a stubbed fetch that serves fixture pages; every assertion is on the
 * returned sample, the thing a KPI would store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GITHUB_ACTIONS_MAX_PAGES,
	type GithubActionsParams,
	readGithubActions,
} from "../src/sources.js";

const window = {
	start: "2026-11-07T00:00:00.000Z",
	end: "2026-11-14T00:00:00.000Z",
};
const signal = new AbortController().signal;
const budget = {
	timeoutMs: 1000,
	maxSourceCalls: 10,
	maxRows: 1000,
	maxResponseBytes: 10_000_000,
};
const read = <T>(source: (s: AbortSignal, b: typeof budget) => Promise<T>) =>
	source(signal, budget);

let nextId = 1;
/** A run created inside the window; `minutes` is its wall-clock duration. */
function run(
	over: Partial<{
		conclusion: string;
		head_sha: string;
		run_attempt: number;
		created_at: string;
		minutes: number;
	}> = {},
) {
	const started = Date.parse("2026-11-10T00:00:00.000Z");
	const minutes = over.minutes ?? 10;
	return {
		id: nextId++,
		head_sha: over.head_sha ?? `sha-${nextId}`,
		conclusion: over.conclusion ?? "success",
		run_attempt: over.run_attempt ?? 1,
		created_at: over.created_at ?? "2026-11-10T00:00:00Z",
		run_started_at: new Date(started).toISOString(),
		updated_at: new Date(started + minutes * 60000).toISOString(),
	};
}

/** Serve `pages` in order; `total` defaults to the number of runs served. */
function serve(pages: object[][], total?: number) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			const page = Number(new URL(url).searchParams.get("page"));
			const body = {
				total_count: total ?? pages.flat().length,
				workflow_runs: pages[page - 1] ?? [],
			};
			return new Response(JSON.stringify(body), {
				headers: { date: "Sat, 14 Nov 2026 00:00:05 GMT" },
			});
		}),
	);
	return urls;
}
afterEach(() => vi.unstubAllGlobals());

const params = (
	output: GithubActionsParams["output"],
	more: Partial<GithubActionsParams> = {},
): GithubActionsParams => ({
	owner: "cogni-dao",
	repo: "node-template",
	workflow: "ci.yaml",
	output,
	...more,
});

describe("github.actions@1 reader", () => {
	it("reads failure rate, flake rate and duration quantile from one small fixture", async () => {
		// 10 runs on 8 SHAs: 2 failures; SHA a failed then passed (flaky), SHA b
		// passed on a retry (flaky), SHA c only failed (not flaky).
		const pages = [
			[
				run({ head_sha: "a", conclusion: "failure", minutes: 5 }),
				run({ head_sha: "a", conclusion: "success", minutes: 6 }),
				run({ head_sha: "b", conclusion: "success", run_attempt: 2, minutes: 7 }),
				run({ head_sha: "c", conclusion: "failure", minutes: 8 }),
				run({ head_sha: "d", minutes: 9 }),
				run({ head_sha: "e", minutes: 10 }),
				run({ head_sha: "f", minutes: 11 }),
				run({ head_sha: "g", minutes: 12 }),
				run({ head_sha: "h", minutes: 13 }),
				run({ head_sha: "i", minutes: 40 }),
			],
		];
		serve(pages);
		const failure = await readGithubActions(params("failure_rate"), window, read);
		expect(failure).toMatchObject({ value: 20, unit: "%", complete: true });
		const flake = await readGithubActions(params("flake_rate"), window, read);
		// 2 flaky of 9 SHAs.
		expect(flake.value).toBeCloseTo((2 / 9) * 100, 10);
		expect(flake.unit).toBe("%");
		// Nearest rank: p95 of 10 durations is the 10th (the 40 minute run), p50 the 5th.
		const p95 = await readGithubActions(params("duration"), window, read);
		expect(p95).toMatchObject({ value: 40, unit: "min", complete: true });
		const p50 = await readGithubActions(
			params("duration", { quantile: 0.5 }),
			window,
			read,
		);
		expect(p50.value).toBe(9);
		expect(p95.evidenceRefs.join(" ")).toContain("runs=10,failures=2");
		expect(p95.sourceWatermarks).toEqual([
			{ source: "github.actions", asOf: "2026-11-14T00:00:05.000Z" },
		]);
	});

	it("leaves cancelled and skipped runs out, so cancel-in-progress cannot inflate failures or shrink durations", async () => {
		serve([
			[
				// Odd fields on a run that gives no verdict must not void the reading.
				{ ...run({ conclusion: "cancelled" }), run_started_at: null, head_sha: null },
				run({ conclusion: "skipped", minutes: 0 }),
				run({ conclusion: "failure", minutes: 20 }),
				run({ conclusion: "success", minutes: 10 }),
			],
		]);
		expect((await readGithubActions(params("failure_rate"), window, read)).value).toBe(50);
		expect((await readGithubActions(params("duration"), window, read)).value).toBe(20);
	});

	it("counts startup_failure and timed_out as failures", async () => {
		serve([
			[
				run({ conclusion: "startup_failure" }),
				run({ conclusion: "timed_out" }),
				run({ conclusion: "success" }),
				run({ conclusion: "success" }),
			],
		]);
		expect((await readGithubActions(params("failure_rate"), window, read)).value).toBe(50);
	});

	it("measures the half-open window: a run created at the end is out, one at the start is in", async () => {
		serve([
			[
				run({ created_at: "2026-11-07T00:00:00Z", conclusion: "failure" }),
				run({ created_at: "2026-11-13T23:59:59Z", conclusion: "success" }),
				run({ created_at: "2026-11-14T00:00:00Z", conclusion: "failure" }),
				run({ created_at: "2026-11-06T23:59:59Z", conclusion: "failure" }),
			],
		]);
		expect((await readGithubActions(params("failure_rate"), window, read)).value).toBe(50);
	});

	it("reads a window of exactly the page cap, and is unknown rather than truncated one run past it", async () => {
		const cap = GITHUB_ACTIONS_MAX_PAGES * 100;
		const page = () => Array.from({ length: 100 }, (_, i) => run({ minutes: i + 1 }));
		serve(Array.from({ length: GITHUB_ACTIONS_MAX_PAGES }, page), cap);
		expect(await readGithubActions(params("failure_rate"), window, read)).toMatchObject({
			value: 0,
			complete: true,
		});
		// 0.55 of 1000 runs is rank 550 (value 55); float 0.55 * 1000 would round up to rank 551 (56).
		expect(
			(await readGithubActions(params("duration", { quantile: 0.55 }), window, read)).value,
		).toBe(55);
		serve([page()], cap + 1);
		expect(await readGithubActions(params("failure_rate"), window, read)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it("reports a quota refusal on a later page as a rate-limited source failure, never a partial value", async () => {
		const full = Array.from({ length: 100 }, () => run({ conclusion: "failure" }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				new URL(url).searchParams.get("page") === "1"
					? new Response(JSON.stringify({ total_count: 250, workflow_runs: full }))
					: new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
							status: 403,
							headers: { "x-ratelimit-remaining": "0" },
						}),
			),
		);
		const limited = await readGithubActions(params("failure_rate"), window, read);
		expect(limited).toMatchObject({ complete: false, reason: "source_failed" });
		expect(limited.evidenceRefs.join(" ")).toContain("rate-limited");
	});

	it("is unknown, never 0, when no run in the window gives a verdict", async () => {
		serve([[run({ conclusion: "cancelled" }), run({ conclusion: "skipped" })]]);
		for (const output of ["failure_rate", "flake_rate", "duration"] as const) {
			expect(await readGithubActions(params(output), window, read)).toMatchObject({
				complete: false,
				reason: "zero_denominator",
			});
		}
		serve([[]]);
		expect(await readGithubActions(params("failure_rate"), window, read)).toMatchObject({
			complete: false,
			reason: "zero_denominator",
		});
	});

	it("is unknown when the provider page is not a runs list", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }))),
		);
		expect(await readGithubActions(params("failure_rate"), window, read)).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});
});
