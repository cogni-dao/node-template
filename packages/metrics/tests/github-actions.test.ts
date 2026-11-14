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
		expect(p95.evidenceRefs).toEqual([
			"https://github.com/cogni-dao/node-template/actions/workflows/ci.yaml",
			"github:actions:node-template/ci.yaml:runs=10,failures=2,shas=9,flakyShas=2",
		]);
		expect(p95.sourceWatermarks).toEqual([
			{ source: "github.actions", asOf: "2026-11-14T00:00:05.000Z" },
		]);
	});

	it("leaves cancelled and skipped runs out, so cancel-in-progress cannot inflate failures or shrink durations", async () => {
		serve([
			[
				run({ conclusion: "cancelled", minutes: 1 }),
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

	it("asks the provider for the window, the event and completed runs only", async () => {
		const urls = serve([[run()]]);
		await readGithubActions(params("failure_rate", { event: "pull_request" }), window, read);
		const q = new URL(urls[0] as string).searchParams;
		expect(new URL(urls[0] as string).pathname).toBe(
			"/repos/cogni-dao/node-template/actions/workflows/ci.yaml/runs",
		);
		expect(q.get("created")).toBe(">=2026-11-07T00:00:00Z");
		expect(q.get("status")).toBe("completed");
		expect(q.get("event")).toBe("pull_request");
	});

	it("reads every page of a window that fits the cap", async () => {
		const full = Array.from({ length: 100 }, () => run());
		serve([full, full.map((r) => ({ ...r, id: r.id + 1000 })), [run({ conclusion: "failure" })]]);
		const sample = await readGithubActions(params("failure_rate"), window, read);
		expect(sample.complete).toBe(true);
		expect(sample.evidenceRefs[1]).toContain("runs=201,failures=1");
	});

	it("is unknown, not a partial value, when the window holds more runs than the page cap reads", async () => {
		serve([[run()]], GITHUB_ACTIONS_MAX_PAGES * 100 + 1);
		const sample = await readGithubActions(params("failure_rate"), window, read);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
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
