// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/tests/fleet-train-lag`
 * Purpose: The fleet metric counts every consumer whose pins trail the latest complete train, from the six real manifests of
 *   2026-11-20, naming legacy aliases and vendored copies; a partial or too-new train never counts; a failed read is unknown
 *   (story.0085, hub package-release-train).
 * Scope: The pure counters over a fixture, and the reader over a fake `fetch`.
 * Invariants: COMPLETE_TRAIN, PIN_BY_RELEASE_URL, VENDORED_LAGS, UNKNOWN_NOT_ZERO.
 * Side-effects: none (fetch is stubbed)
 * @internal
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assessFleetTrainLag, latestCompleteTrain, readFleetTrainLag } from "../src/fleet-sources.js";

const MEMBERS = [
	{ name: "@cogni-dao/work-items", tagPrefix: "work-items-v" },
	{ name: "@cogni-dao/knowledge-store", tagPrefix: "knowledge-store-v" },
	{ name: "@cogni-dao/knowledge-base-ui", tagPrefix: "knowledge-base-ui-v" },
	{ name: "@cogni-dao/metrics", tagPrefix: "metrics-v" },
	{ name: "@cogni-dao/ai-tools", tagPrefix: "ai-tools-v" },
];
const manifests = JSON.parse(
	readFileSync(new URL("./fixtures/fleet-manifests-2026-11-20.json", import.meta.url), "utf8"),
) as { repo: string; manifest: unknown }[];
const release = (tag: string, published: string) => ({ tag_name: tag, published_at: published });
const at = new Date("2026-11-22T00:00:00Z");

describe("assessFleetTrainLag on the real 2026-11-20 manifests", () => {
	const lagging = assessFleetTrainLag("0.24.0", MEMBERS, manifests);
	const byRepo = new Map(lagging.map((l) => [l.repo, l.reasons]));

	it("all six consumers trail train 0.24.0, the operator included", () => {
		expect(lagging.map((l) => l.repo).sort()).toEqual(
			["cogni-dao/beacon", "cogni-dao/cogni", "cogni-dao/levelup", "cogni-dao/poly", "cogni-dao/red", "cogni-dao/toks5"].sort(),
		);
	});

	it("counts a legacy alias by its Release URL, not its key", () => {
		expect(byRepo.get("cogni-dao/poly")).toContain("behind:@cogni/legacy-work-items@0.1.8");
		expect(byRepo.get("cogni-dao/poly")).toContain("behind:@cogni/shared-ai-tools@0.12.0");
		expect(byRepo.get("cogni-dao/cogni")).toContain("behind:@cogni/shared-knowledge-store@0.20.0");
	});

	it("names toks5's explicit public workspace targets as vendored", () => {
		expect(byRepo.get("cogni-dao/toks5")).toContain("vendored:@cogni/work-items@workspace");
		expect(byRepo.get("cogni-dao/toks5")).toContain("vendored:@cogni-dao/metrics@workspace");
	});

	it("keeps current Release pins current alongside private same-basename wrappers", () => {
		const url = (m: (typeof MEMBERS)[number]) =>
			`https://github.com/cogni-dao/node-template/releases/download/${m.tagPrefix}0.24.0/x.tgz`;
		const manifest = {
			dependencies: {
				...Object.fromEntries(MEMBERS.map((m) => [`shared-${m.tagPrefix}`, url(m)])),
				"@cogni/ai-tools": "workspace:*",
				"private-alias": "workspace:@cogni/work-items@*",
			},
			devDependencies: { "@cogni/knowledge-store": "workspace:*" },
		};
		expect(assessFleetTrainLag("0.24.0", MEMBERS, [{ repo: "cogni-dao/x", manifest }], "cogni-dao/node-template")).toEqual([]);
	});

	it("counts exact public workspace targets and leaves private targets missing", () => {
		const manifest = { dependencies: {
			"@cogni-dao/metrics": "workspace:*",
			"public-alias": "workspace:@cogni-dao/work-items@*",
			"private-alias": "workspace:@cogni/knowledge-store@*",
		} };
		const reasons = assessFleetTrainLag("0.24.0", MEMBERS, [{ repo: "cogni-dao/x", manifest }])[0]?.reasons;
		expect(reasons).toContain("vendored:@cogni-dao/metrics@workspace");
		expect(reasons).toContain("vendored:public-alias@workspace");
		expect(reasons).not.toContain("vendored:private-alias@workspace");
		expect(reasons).toContain("missing:@cogni-dao/knowledge-store@none");
	});

	it("ignores another publisher's Releases", () => {
		const foreign = { dependencies: { "@cogni/work-items": "https://github.com/someone/fork/releases/download/work-items-v0.30.0/x.tgz" } };
		const reasons = assessFleetTrainLag("0.24.0", MEMBERS, [{ repo: "cogni-dao/x", manifest: foreign }], "cogni-dao/node-template")[0]?.reasons;
		expect(reasons).toContain("missing:@cogni-dao/work-items@none");
	});

	it("a consumer pinned wholly to the train is not lagging", () => {
		const url = (m: (typeof MEMBERS)[number]) =>
			`https://github.com/cogni-dao/node-template/releases/download/${m.tagPrefix}0.24.0/x.tgz`;
		const current = { dependencies: Object.fromEntries(MEMBERS.map((m) => [m.name.replace("@cogni-dao/", "@cogni/"), url(m)])) };
		expect(assessFleetTrainLag("0.24.0", MEMBERS, [{ repo: "cogni-dao/x", manifest: current }])).toEqual([]);
		const short = { dependencies: { "@cogni/work-items": url(MEMBERS[0] as (typeof MEMBERS)[number]) } };
		expect(assessFleetTrainLag("0.24.0", MEMBERS, [{ repo: "cogni-dao/x", manifest: short }])[0]?.reasons).toContain(
			"missing:@cogni-dao/metrics@none",
		);
	});
});

describe("latestCompleteTrain", () => {
	const all = (v: string, published: string) => MEMBERS.map((m) => release(`${m.tagPrefix}${v}`, published));

	it("takes the newest train whose five Releases exist and are past the grace", () => {
		expect(latestCompleteTrain([...all("0.24.0", "2026-11-20T00:00:00Z"), ...all("0.25.0", "2026-11-20T06:00:00Z")], MEMBERS, at, 24)).toBe(
			"0.25.0",
		);
	});

	it("falls back while the newest is inside its grace or partial", () => {
		const young = all("0.25.0", "2026-11-21T12:00:00Z");
		expect(latestCompleteTrain([...all("0.24.0", "2026-11-20T00:00:00Z"), ...young], MEMBERS, at, 24)).toBe("0.24.0");
		const partial = all("0.25.0", "2026-11-20T00:00:00Z").slice(1);
		expect(latestCompleteTrain([...all("0.24.0", "2026-11-20T00:00:00Z"), ...partial], MEMBERS, at, 24)).toBe("0.24.0");
		expect(latestCompleteTrain(partial, MEMBERS, at, 24)).toBeNull();
	});
});

describe("readFleetTrainLag", () => {
	afterEach(() => vi.unstubAllGlobals());
	const params = {
		publisher: "cogni-dao/node-template",
		members: MEMBERS,
		consumers: manifests.map((m) => ({ repo: m.repo, manifestPath: "app/package.json" })),
		graceHours: 24,
	};
	const budget = { timeoutMs: 30000, maxSourceCalls: 1, maxRows: 100, maxResponseBytes: 1_048_576 };
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { date: "Sun, 22 Nov 2026 00:00:00 GMT" } });

	it("reads tags, member Releases and manifests, and counts the lagging consumers", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url);
				if (url.includes("/git/matching-refs/tags/train-v")) return json([{ ref: "refs/tags/train-v0.24.0" }]);
				const tag = /releases\/tags\/(.+)$/.exec(url)?.[1];
				if (tag) return json(release(decodeURIComponent(tag), "2026-11-20T00:00:00Z"));
				const repo = /githubusercontent\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1];
				return json(manifests.find((m) => m.repo === repo)?.manifest ?? {});
			}),
		);
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ value: 6, unit: "nodes", complete: true });
		expect(sample.evidenceRefs).toContain("fleet:train-lag:counts:evaluated=6;lagging=6;train=0.24.0");
		expect(calls.filter((c) => c.startsWith("https://api.github.com"))).toHaveLength(6);
	});

	it("an unreadable manifest is unknown naming the repo, never a count", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.includes("/git/matching-refs/tags/train-v")) return json([{ ref: "refs/tags/train-v0.24.0" }]);
				const tag = /releases\/tags\/(.+)$/.exec(url)?.[1];
				if (tag) return json(release(decodeURIComponent(tag), "2026-11-20T00:00:00Z"));
				return url.includes("cogni-dao/red/") ? json({}, 500) : json({});
			}),
		);
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		expect(sample.evidenceRefs[0]).toContain("unreadable=cogni-dao/red");
	});

	it("no complete train is unknown, never zero", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (url.includes("/tags/train-v") ? json([]) : json({}, 404))),
		);
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs[0]).toBe("fleet:train-lag:train=none");
	});
});

describe("source qualification against six current consumers", () => {
	afterEach(() => vi.unstubAllGlobals());
	const publisher = "cogni-dao/node-template";
	const url = (m: (typeof MEMBERS)[number], version = "0.24.0") =>
		`https://github.com/${publisher}/releases/download/${m.tagPrefix}${version}/x.tgz`;
	const current = () => ({
		dependencies: {
			...Object.fromEntries(MEMBERS.map((m) => [m.name, url(m)])),
			"@cogni/ai-tools": "workspace:*",
		},
		devDependencies: {} as Record<string, string>,
	});
	const cohort = () =>
		manifests.map(({ repo }) => ({ repo, manifest: current() }));
	const assess = (rows: ReturnType<typeof cohort>) =>
		assessFleetTrainLag("0.24.0", MEMBERS, rows, publisher);

	it("detects each individual fault without private-wrapper false positives", () => {
		expect(assess(cohort())).toEqual([]);
		const shadow = cohort();
		(shadow[0] as (typeof shadow)[number]).manifest.devDependencies[(MEMBERS[0] as (typeof MEMBERS)[number]).name] = url(
			(MEMBERS[0] as (typeof MEMBERS)[number]),
			"0.1.8",
		);
		expect(assess(shadow)).toEqual([
			{ repo: (shadow[0] as (typeof shadow)[number]).repo, reasons: [`behind:${(MEMBERS[0] as (typeof MEMBERS)[number]).name}@0.1.8`] },
		]);
		for (const bad of [
			url((MEMBERS[0] as (typeof MEMBERS)[number])).replace("github.com", "notgithub.com"),
			url((MEMBERS[0] as (typeof MEMBERS)[number])).replace("https:", "http:"),
			url((MEMBERS[0] as (typeof MEMBERS)[number])).replace(publisher, "someone/fork"),
		]) {
			const rows = cohort();
			(rows[0] as (typeof rows)[number]).manifest.dependencies[(MEMBERS[0] as (typeof MEMBERS)[number]).name] = bad;
			expect(assess(rows)[0]?.reasons).toContain(
				`missing:${(MEMBERS[0] as (typeof MEMBERS)[number]).name}@none`,
			);
		}
		const vendor = cohort();
		(vendor[0] as (typeof vendor)[number]).manifest.dependencies[(MEMBERS[0] as (typeof MEMBERS)[number]).name] = "workspace:*";
		expect(assess(vendor)[0]?.reasons).toContain(
			`vendored:${(MEMBERS[0] as (typeof MEMBERS)[number]).name}@workspace`,
		);
		const missing = cohort();
		delete (missing[0] as (typeof missing)[number]).manifest.dependencies[(MEMBERS[0] as (typeof MEMBERS)[number]).name];
		expect(assess(missing)[0]?.reasons).toContain(
			`missing:${(MEMBERS[0] as (typeof MEMBERS)[number]).name}@none`,
		);
	});

	const params = {
		publisher,
		members: MEMBERS,
		consumers: manifests.map(({ repo }) => ({
			repo,
			manifestPath: "app/package.json",
		})),
		graceHours: 24,
	};
	const budget = {
		timeoutMs: 30000,
		maxSourceCalls: 1,
		maxRows: 100,
		maxResponseBytes: 1_048_576,
	};
	const response = (value: unknown, status = 200) =>
		new Response(JSON.stringify(value), { status });
	function fakeFetch(manifest: unknown) {
		return vi.fn(async (address: string) => {
			if (address.includes("matching-refs"))
				return response([{ ref: "refs/tags/train-v0.24.0" }]);
			const tag = /releases\/tags\/(.+)$/.exec(address)?.[1];
			if (tag)
				return response(
					release(decodeURIComponent(tag), "2026-11-20T00:00:00Z"),
				);
			return response(
				address.includes("cogni-dao/poly/") ? manifest : current(),
			);
		});
	}

	it.each([
		null,
		[],
		{ dependencies: null },
		{ dependencies: [] },
		{ dependencies: { bad: 42 } },
	])("rejects malformed manifest %#", async (manifest) => {
		vi.stubGlobal("fetch", fakeFetch(manifest));
		const sample = await readFleetTrainLag(
			params,
			at,
			new AbortController().signal,
			budget,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
		expect(sample.evidenceRefs[0]).toContain("cogni-dao/poly");
	});

	it("bounds multibyte responses while streaming and cancels excess", async () => {
		let cancelled = false;
		const bytes = new TextEncoder().encode(
			JSON.stringify({ padding: "界".repeat(300) }),
		);
		const fetcher = fakeFetch(current());
		vi.stubGlobal(
			"fetch",
			vi.fn(async (address: string) => {
				if (!address.includes("cogni-dao/poly/")) return fetcher(address);
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(bytes);
						},
						cancel() {
							cancelled = true;
						},
					}),
				);
			}),
		);
		const sample = await readFleetTrainLag(
			params,
			at,
			new AbortController().signal,
			{ ...budget, maxResponseBytes: 600 },
		);
		expect(sample.complete).toBe(false);
		expect(cancelled).toBe(true);
	});

	it("enforces the two-train request cap and exact grace boundary", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (address: string) => {
				calls.push(address);
				if (address.includes("matching-refs"))
					return response([
						{ ref: "refs/tags/train-v0.25.0" },
						{ ref: "refs/tags/train-v0.24.0" },
						{ ref: "refs/tags/train-v0.23.0" },
					]);
				const tag = /releases\/tags\/(.+)$/.exec(address)?.[1];
				if (tag)
					return response(
						release(
							decodeURIComponent(tag),
							tag.endsWith("0.25.0")
								? "2026-11-21T00:00:00.001Z"
								: "2026-11-20T00:00:00Z",
						),
					);
				return response(current());
			}),
		);
		const sample = await readFleetTrainLag(
			params,
			at,
			new AbortController().signal,
			budget,
		);
		expect(sample).toMatchObject({ complete: true, value: 0 });
		expect(sample.evidenceRefs[1]).toContain("train=0.24.0");
		expect(
			calls.filter((x) => x.startsWith("https://api.github.com")),
		).toHaveLength(11);
		expect(
			calls.filter((x) => x.startsWith("https://raw.githubusercontent.com")),
		).toHaveLength(6);
		const exact = MEMBERS.map((m) =>
			release(`${m.tagPrefix}0.25.0`, "2026-11-21T00:00:00.000Z"),
		);
		expect(latestCompleteTrain(exact, MEMBERS, at, 24)).toBe("0.25.0");
		expect(
			latestCompleteTrain(exact, MEMBERS, new Date(at.getTime() - 1), 24),
		).toBeNull();
	});

	it.each([403, 429])(
		"reports provider refusal %i as unavailable",
		async (status) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => response({}, status)),
			);
			const sample = await readFleetTrainLag(
				params,
				at,
				new AbortController().signal,
				budget,
			);
			expect(sample).toMatchObject({
				complete: false,
				reason: "source_failed",
			});
			expect(sample.evidenceRefs[0]).toContain("provider_rate_limited");
		},
	);

	it("reports interrupted manifest streams as failed with their repository", async () => {
		const fetcher = fakeFetch(current());
		vi.stubGlobal(
			"fetch",
			vi.fn(async (address: string) =>
				address.includes("cogni-dao/poly/")
					? new Response(
							new ReadableStream({
								start(controller) {
									controller.error(new Error("stream_interrupted"));
								},
							}),
						)
					: fetcher(address),
			),
		);
		const sample = await readFleetTrainLag(
			params,
			at,
			new AbortController().signal,
			budget,
		);
		expect(sample).toMatchObject({ complete: false, reason: "source_failed" });
		expect(sample.evidenceRefs[0]).toContain("cogni-dao/poly");
	});

	it("propagates caller cancellation while reading a manifest", async () => {
		const abort = new AbortController();
		const fetcher = fakeFetch(current());
		vi.stubGlobal(
			"fetch",
			vi.fn(async (address: string) => {
				if (!address.includes("cogni-dao/poly/")) return fetcher(address);
				return new Response(
					new ReadableStream({
						start(controller) {
							abort.signal.addEventListener("abort", () =>
								controller.error(abort.signal.reason),
							);
							queueMicrotask(() => abort.abort(new Error("timeout")));
						},
					}),
				);
			}),
		);
		await expect(
			readFleetTrainLag(params, at, abort.signal, budget),
		).rejects.toThrow("timeout");
	});

	it.each([
		null,
		[],
		{},
		{ tag_name: "wrong", published_at: "2026-11-20T00:00:00Z" },
	])("rejects malformed Release response %#", async (value) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (address: string) =>
				address.includes("matching-refs")
					? response([{ ref: "refs/tags/train-v0.24.0" }])
					: response(value),
			),
		);
		const sample = await readFleetTrainLag(
			params,
			at,
			new AbortController().signal,
			budget,
		);
		expect(sample).toMatchObject({
			complete: false,
			reason: "incomplete_or_invalid_source",
		});
	});

	it.each(["..", "%2e%2e", "%2f..%2fescape", "x\\..\\..\\escape"])("does not count normalized Release traversal %s", (asset) => {
		const rows = cohort();
		const first = rows[0] as (typeof rows)[number];
		const member = MEMBERS[0] as (typeof MEMBERS)[number];
		first.manifest.dependencies[member.name] = url(member).replace("x.tgz", asset);
		expect(assess(rows)[0]?.reasons).toContain(`missing:${member.name}@none`);
	});

	it("rejects mixed valid and malformed train refs", async () => {
		const fetcher = fakeFetch(current());
		vi.stubGlobal("fetch", vi.fn(async (address: string) => address.includes("matching-refs")
			? response([{ ref: "refs/tags/train-v0.24.0" }, { ref: "refs/tags/train-v0.25.0 bad" }]) : fetcher(address)));
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
	});

	it.each(["0", "2026-02-30T00:00:00Z"])("rejects malformed publication timestamp %s", async (published) => {
		const fetcher = fakeFetch(current());
		vi.stubGlobal("fetch", vi.fn(async (address: string) => address.includes("releases/tags/work-items-v0.24.0")
			? response(release("work-items-v0.24.0", published)) : fetcher(address)));
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
	});


	it("rejects tag rows beyond the source row budget", async () => {
		const fetcher = fakeFetch(current());
		vi.stubGlobal("fetch", vi.fn(async (address: string) => address.includes("matching-refs")
			? response(Array.from({ length: 101 }, (_, n) => ({ ref: `refs/tags/train-v0.24.${n}` }))) : fetcher(address)));
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, { ...budget, maxRows: 100 });
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs[0]).toContain("row_budget");
	});

	it.each([4, 11])("rejects cumulative Release or manifest rows above budget %i", async (maxRows) => {
		vi.stubGlobal("fetch", fakeFetch(current()));
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, { ...budget, maxRows });
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs[0]).toContain("row_budget");
	});

	it("accepts the exact cumulative source row budget", async () => {
		vi.stubGlobal("fetch", fakeFetch(current()));
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, { ...budget, maxRows: 12 });
		expect(sample).toMatchObject({ complete: true, value: 0 });
	});

});
