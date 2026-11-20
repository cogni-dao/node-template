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

	it("names toks5's workspace copies as vendored", () => {
		expect(byRepo.get("cogni-dao/toks5")).toContain("vendored:@cogni/work-items@workspace");
		expect(byRepo.get("cogni-dao/toks5")).toContain("vendored:@cogni-dao/metrics@workspace");
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
				if (url.endsWith("/git/matching-refs/tags/train-v")) return json([{ ref: "refs/tags/train-v0.24.0" }]);
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
				if (url.endsWith("/git/matching-refs/tags/train-v")) return json([{ ref: "refs/tags/train-v0.24.0" }]);
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
			vi.fn(async (url: string) => (url.endsWith("/train-v") ? json([]) : json({}, 404))),
		);
		const sample = await readFleetTrainLag(params, at, new AbortController().signal, budget);
		expect(sample).toMatchObject({ complete: false, reason: "incomplete_or_invalid_source" });
		expect(sample.evidenceRefs[0]).toBe("fleet:train-lag:train=none");
	});
});
