// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/sources` (fleet train lag)
 * Purpose: Count the consumer nodes whose pins trail the latest complete package train (story.0085, hub package-release-train).
 * Scope: The publisher's `train-v*` tags, the member Releases of the two newest trains and one raw manifest read per consumer,
 *   without credentials, at fixed provider origins. The pure `latestCompleteTrain` and `assessFleetTrainLag` do the counting so a
 *   fixture of real manifests can prove them.
 * Invariants:
 *   - COMPLETE_TRAIN: `T` is the newest version every member has a Release for, published at least `graceHours` before the reading.
 *   - PIN_BY_RELEASE_URL: a pin counts by the publisher's Release tag it resolves to, never by its dependency key, so legacy
 *     aliases count too.
 *   - VENDORED_LAGS: a `workspace:` copy of a member is lagging: its bytes are not the published ones.
 *   - UNKNOWN_NOT_ZERO: a failed or malformed read is an incomplete sample naming its repo, never 0.
 * Side-effects: IO (HTTPS GET api.github.com tags and releases, at most 11 requests; raw.githubusercontent.com manifests)
 * Links: hub package-release-train, publish-shared-runtime-core
 * @public
 */

import type { MetricBudget, MetricSample } from "./contracts.js";

export interface TrainMember {
	/** The published package name, for example `@cogni-dao/work-items`. */
	readonly name: string;
	/** Its Release tag prefix, for example `work-items-v`. */
	readonly tagPrefix: string;
}

export interface TrainConsumer {
	/** `owner/repo`. */
	readonly repo: string;
	/** The manifest path on the default branch, for example `app/package.json`. */
	readonly manifestPath: string;
}

export interface FleetTrainLagParams {
	/** `owner/repo` that publishes the members' Releases. */
	readonly publisher: string;
	readonly members: readonly TrainMember[];
	readonly consumers: readonly TrainConsumer[];
	/** A train counts only once its last member Release is this old. */
	readonly graceHours: number;
}

export interface ReleaseLike {
	readonly tag_name: string;
	readonly published_at: string | null;
	readonly draft?: boolean;
}

/** Most consumers one reading evaluates; each is one manifest read. */
export const FLEET_TRAIN_MAX_CONSUMERS = 20;
/** Newest trains whose member Releases one reading checks: the newest, and the one before it while the newest is in its grace. */
export const FLEET_TRAIN_CANDIDATES = 2;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(a: string, b: string): number {
	const pa = SEMVER.exec(a);
	const pb = SEMVER.exec(b);
	if (!pa || !pb) return Number.NaN;
	for (let i = 1; i <= 3; i++) {
		const d = Number(pa[i]) - Number(pb[i]);
		if (d !== 0) return d;
	}
	return 0;
}

/** The newest version every member has a published Release for, at least `graceHours` old at `at`. */
export function latestCompleteTrain(
	releases: readonly ReleaseLike[],
	members: readonly TrainMember[],
	at: Date,
	graceHours: number,
): string | null {
	const byVersion = new Map<string, Map<string, number>>();
	for (const release of releases) {
		if (release.draft || !release.published_at) continue;
		const member = members.find((m) => release.tag_name.startsWith(m.tagPrefix));
		if (!member) continue;
		const version = release.tag_name.slice(member.tagPrefix.length);
		if (!SEMVER.test(version)) continue;
		const published = Date.parse(release.published_at);
		if (!Number.isFinite(published)) continue;
		const seen = byVersion.get(version) ?? new Map<string, number>();
		seen.set(member.name, published);
		byVersion.set(version, seen);
	}
	const cutoff = at.getTime() - graceHours * 3600_000;
	let best: string | null = null;
	for (const [version, seen] of byVersion) {
		if (seen.size !== members.length) continue;
		if (Math.max(...seen.values()) > cutoff) continue;
		if (best === null || compareVersions(version, best) > 0) best = version;
	}
	return best;
}

export interface ConsumerLag {
	readonly repo: string;
	/** Each reason the consumer trails: `<reason>:<key>@<version>`, reason `behind`, `vendored` or `missing`. */
	readonly reasons: readonly string[];
}

/** The lagging consumers of one manifest set against train `T`. A missing manifest is not passed here. */
export function assessFleetTrainLag(
	train: string,
	members: readonly TrainMember[],
	manifests: readonly { readonly repo: string; readonly manifest: unknown }[],
	publisher?: string,
): ConsumerLag[] {
	// `@cogni/work-items` and `@cogni-dao/work-items` name one member: a vendored copy may keep either scope.
	const base = (name: string) => name.replace(/^@[^/]+\//, "");
	const lagging: ConsumerLag[] = [];
	for (const { repo, manifest } of manifests) {
		const m = (manifest ?? {}) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
		const deps = { ...(m.devDependencies ?? {}), ...(m.dependencies ?? {}) };
		const reasons: string[] = [];
		const pinned = new Set<string>();
		for (const [key, raw] of Object.entries(deps)) {
			if (typeof raw !== "string") continue;
			const release = /github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(raw);
			const tag = release && (!publisher || release[1]?.toLowerCase() === publisher.toLowerCase()) ? release[2] : undefined;
			if (tag) {
				const member = members.find((x) => tag.startsWith(x.tagPrefix));
				if (!member) continue;
				pinned.add(member.name);
				const version = tag.slice(member.tagPrefix.length);
				const cmp = compareVersions(version, train);
				if (!(cmp >= 0)) reasons.push(`behind:${key}@${version}`);
				continue;
			}
			if (raw.startsWith("workspace:")) {
				// `workspace:@cogni-dao/work-items@*` names its target; `workspace:*` and `workspace:0.22.0` mean the key.
				const spec = raw.slice("workspace:".length);
				const at = spec.lastIndexOf("@");
				const target = spec.startsWith("@") ? (at > 0 ? spec.slice(0, at) : spec) : key;
				const member = members.find((x) => base(x.name) === base(target));
				if (!member) continue;
				pinned.add(member.name);
				reasons.push(`vendored:${key}@workspace`);
			}
		}
		for (const member of members) if (!pinned.has(member.name)) reasons.push(`missing:${member.name}@none`);
		if (reasons.length) lagging.push({ repo, reasons });
	}
	return lagging;
}

/**
 * One unauthenticated GET at a fixed GitHub origin, bounded while streaming. A quota refusal throws `provider_rate_limited`.
 * Manifests come from raw.githubusercontent.com, which the REST quota does not count, so a reading spends one REST call.
 */
async function getJson(url: string, signal: AbortSignal, maxResponseBytes: number): Promise<{ body: unknown; date: string | null }> {
	const response = await fetch(url, {
		signal,
		redirect: "error",
		headers: { Accept: "application/vnd.github+json", "User-Agent": "Cogni-node-metrics" },
		cache: "no-store",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(response.status === 403 || response.status === 429 ? "provider_rate_limited" : `provider_status_${response.status}`);
	}
	const text = await response.text();
	if (text.length > maxResponseBytes) throw new Error("provider_response_budget");
	const date = response.headers.get("date");
	return { body: JSON.parse(text), date: date ? new Date(date).toISOString() : null };
}

/** `owner/repo`, the shape GitHub allows. The calculator's params schema reuses it. */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
/** A manifest path: directories of safe segments ending in `package.json`, never `..`. */
export const MANIFEST_PATH_PATTERN = /^(?:[A-Za-z0-9_-]+\/)*package\.json$/;

/** Count of consumers trailing the latest complete train, with each lagging repo and reason as evidence. */
export async function readFleetTrainLag(
	p: FleetTrainLagParams,
	at: Date,
	signal: AbortSignal,
	budget: Readonly<MetricBudget>,
): Promise<MetricSample> {
	if (!GITHUB_REPO_PATTERN.test(p.publisher) || p.consumers.length > FLEET_TRAIN_MAX_CONSUMERS)
		throw new Error("invalid_fleet_params");
	for (const c of p.consumers)
		if (!GITHUB_REPO_PATTERN.test(c.repo) || !MANIFEST_PATH_PATTERN.test(c.manifestPath)) throw new Error("invalid_fleet_params");
	const unknown = (counts: string, reason: "source_failed" | "incomplete_or_invalid_source", asOf: string | null): MetricSample => ({
		value: 0,
		unit: "nodes",
		complete: false,
		reason,
		sourceWatermarks: [{ source: "github.releases", asOf }],
		evidenceRefs: [`fleet:train-lag:${counts}`],
	});
	// Train tags first: the Releases list is newest-first across every package, so a day-old train falls off its first page.
	const api = `https://api.github.com/repos/${p.publisher}`;
	let asOf: string | null = null;
	let candidates: string[];
	try {
		const refs = await getJson(`${api}/git/matching-refs/tags/train-v?per_page=100`, signal, budget.maxResponseBytes);
		asOf = refs.date;
		if (!Array.isArray(refs.body)) return unknown("tags=malformed", "incomplete_or_invalid_source", asOf);
		candidates = (refs.body as { ref?: unknown }[])
			.map((r) => (typeof r.ref === "string" ? r.ref.replace(/^refs\/tags\/train-v/, "") : ""))
			.filter((v) => SEMVER.test(v))
			.sort((a, b) => compareVersions(b, a))
			.slice(0, FLEET_TRAIN_CANDIDATES);
	} catch (error) {
		signal.throwIfAborted();
		return unknown(`tags=${(error as Error).message}`, "source_failed", null);
	}
	const releases: ReleaseLike[] = [];
	try {
		for (const version of candidates)
			for (const member of p.members) {
				const tag = `${member.tagPrefix}${version}`;
				const got = await getJson(`${api}/releases/tags/${encodeURIComponent(tag)}`, signal, budget.maxResponseBytes).catch(
					(error: Error) => {
						if (error.message === "provider_status_404") return null; // not published: the train is partial
						throw error;
					},
				);
				if (got) releases.push(got.body as ReleaseLike);
			}
	} catch (error) {
		signal.throwIfAborted();
		return unknown(`releases=${(error as Error).message}`, "source_failed", asOf);
	}
	const train = latestCompleteTrain(releases, p.members, at, p.graceHours);
	if (train === null) return unknown("train=none", "incomplete_or_invalid_source", asOf);

	const read = await Promise.allSettled(
		p.consumers.map(async (c) => ({
			repo: c.repo,
			manifest: (await getJson(`https://raw.githubusercontent.com/${c.repo}/HEAD/${c.manifestPath}`, signal, budget.maxResponseBytes)).body,
		})),
	);
	const failed = p.consumers.filter((_, i) => read[i]?.status !== "fulfilled").map((c) => c.repo);
	if (failed.length) return unknown(`train=${train};unreadable=${failed.join(",")}`, "source_failed", asOf);
	const manifests = read.map((r) => (r as PromiseFulfilledResult<{ repo: string; manifest: unknown }>).value);
	const lagging = assessFleetTrainLag(train, p.members, manifests, p.publisher);
	return {
		value: lagging.length,
		unit: "nodes",
		complete: true,
		sourceWatermarks: [{ source: "github.releases", asOf }],
		evidenceRefs: [
			`https://github.com/${p.publisher}/releases`,
			`fleet:train-lag:counts:evaluated=${manifests.length};lagging=${lagging.length};train=${train}`,
			...lagging.map((l) => `fleet:train-lag:lagging=${l.repo}:${l.reasons.join(",")}`),
		],
	};
}
