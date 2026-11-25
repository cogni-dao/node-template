// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/metrics/sources` (fleet train lag)
 * Purpose: Count the consumer nodes whose pins trail the latest complete package train (story.0085, hub package-release-train).
 * Scope: The publisher's `train-v*` tags, newest-first member Releases within eleven REST requests and one raw manifest per consumer,
 *   without credentials, at fixed provider origins. The pure `latestCompleteTrain` and `assessFleetTrainLag` do the counting so a
 *   fixture of real manifests can prove them.
 * Invariants:
 *   - COMPLETE_TRAIN: `T` is the newest version every member has a Release for, published at least `graceHours` before the reading.
 *   - PIN_BY_RELEASE_URL: a pin counts by the publisher's Release tag it resolves to, never by its dependency key, so legacy
 *     aliases count too.
 *   - VENDORED_LAGS: a `workspace:` target exactly naming a published member is lagging.
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
const FLEET_TRAIN_MAX_REST_REQUESTS = 11;
/** Maximum candidate visits: one tag-list request leaves at most ten member probes. Early rejection permits older trains. */
export const FLEET_TRAIN_CANDIDATES = FLEET_TRAIN_MAX_REST_REQUESTS - 1;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validManifest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return ["dependencies", "devDependencies"].every((key) => {
		const section = value[key];
		return (
			section === undefined ||
			(isRecord(section) &&
				Object.values(section).every((v) => typeof v === "string"))
		);
	});
}

// URL preserves percent escapes in pathname. Decode each segment once, retaining
// its boundaries for trust; decoded separators can only identify an invalid pin.
function releasePathIdentity(pathname: string): { tag: string | undefined; publisher: string | undefined; valid: boolean; hints: readonly string[] } {
	let valid = true;
	const parts = pathname.split("/").map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			valid = false;
			// Native forgiving decoding preserves an encoded member prefix even
			// when later percent/UTF-8 bytes are invalid. Escape form delimiters
			// so literal '+' and '&' keep their path meaning. Never trust this.
			return new URLSearchParams(`part=${part.replace(/[+&]/g, encodeURIComponent)}`).get("part") ?? part;
		}
	});
	valid = valid && parts.length === 7 && parts.slice(1).every((part) => part && part !== "." && part !== ".." && !/[/\\]/.test(part));
	const decoded = parts.join("/").replace(/\\/g, "/");
	const match = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)(?:\/|$)/.exec(decoded);
	// Refusals have no publisher-depth requirement. Keep every marker's tag
	// before native normalization can erase it alongside earlier traversal.
	const segments = decoded.split("/");
	const hints: string[] = [];
	for (let i = 0; i < segments.length - 2; i++) {
		const tag = segments[i + 2];
		if (segments[i] === "releases" && segments[i + 1] === "download" && tag) hints.push(tag);
	}
	return { tag: match?.[2], publisher: match?.[1], valid: valid && !!match, hints };
}

// Only the actual normalized target can establish trust. Otherwise preserve all
// recoverable identities until member classification: an unrelated normalized
// hint cannot discharge a recognizable raw member refusal. Hints never direct IO.
function releaseIdentity(raw: string, publisher?: string): { tag: string | undefined; trusted: boolean; hints: readonly string[] } {
	let url: URL | undefined;
	try {
		url = new URL(raw);
	} catch {
		// Malformed-but-recognizable pins still need reporting below.
	}
	const identity = url && releasePathIdentity(url.pathname);
	if (identity?.valid && url?.origin === "https://github.com" && !url.username && !url.password &&
		(!publisher || identity.publisher?.toLowerCase() === publisher.toLowerCase())) {
		return {
			tag: identity.tag,
			trusted: true,
			hints: [],
		};
	}
	// URL parsing can fail on the authority or erase the tag through traversal.
	// Retain that path as a refusal, after URL's input whitespace preprocessing.
	let start = 0;
	let end = raw.length;
	while (start < end && raw.charCodeAt(start) <= 32) start++;
	while (end > start && raw.charCodeAt(end - 1) <= 32) end--;
	const input = raw.slice(start, end).replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
	// HTTP(S) special URLs accept zero, one or many authority slashes. Extract
	// only the path when a bad authority prevents native URL parsing; URL still
	// owns path normalization. Keep the existing :// recovery for other schemes.
	const path = /^(?:https?:\/*|[a-z][a-z\d+.-]*:\/\/)[^/?#]*(\/[^?#]*)/i.exec(input)?.[1];
	const hints = new Set<string>();
	for (const hint of identity?.hints ?? []) hints.add(hint);
	// A fixed dummy authority lets URL normalize the recovered path even when
	// the manifest authority was invalid. Neither form can establish trust.
	if (path !== undefined) {
		const normalized = new URL(`https://release.invalid${path}`).pathname;
		for (const hint of [...releasePathIdentity(normalized).hints, ...releasePathIdentity(path).hints]) hints.add(hint);
	}
	return { tag: undefined, trusted: false, hints: [...hints] };
}

function validGitRef(ref: string): boolean {
	return ref.startsWith("refs/tags/train-v") && !Array.from(ref).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char)) &&
		!ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".") &&
		ref.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function validPublishedAt(value: string): boolean {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
	if (!match) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}

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
	/** Each reason the consumer trails: `<reason>:<key>@<version>`, reason `behind`, `vendored`, `invalid` or `missing`. */
	readonly reasons: readonly string[];
}

/** The lagging consumers of one manifest set against train `T`. A missing manifest is not passed here. */
export function assessFleetTrainLag(
	train: string,
	members: readonly TrainMember[],
	manifests: readonly { readonly repo: string; readonly manifest: unknown }[],
	publisher?: string,
): ConsumerLag[] {
	const lagging: ConsumerLag[] = [];
	for (const { repo, manifest } of manifests) {
		const m = (manifest ?? {}) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
		const deps = [...Object.entries(m.devDependencies ?? {}), ...Object.entries(m.dependencies ?? {})];
		const reasons: string[] = [];
		const pinned = new Set<string>();
		for (const [key, raw] of deps) {
			if (typeof raw !== "string") continue;
			const namedMember = members.find((x) => x.name === key);
			const { tag, trusted, hints } = releaseIdentity(raw, publisher);
			if (trusted && tag) {
				const member = members.find((x) => tag.startsWith(x.tagPrefix));
				if (namedMember && member !== namedMember) reasons.push(`invalid:${key}@release`);
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
				const member = members.find((x) => x.name === target);
				if (namedMember && member !== namedMember) reasons.push(`invalid:${key}@workspace`);
				if (!member) continue;
				pinned.add(member.name);
				reasons.push(`vendored:${key}@workspace`);
			} else if (namedMember || members.some((x) => hints.some((hint) => hint.startsWith(x.tagPrefix)))) {
				reasons.push(`invalid:${key}@pin`);
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
	if (!response.body) throw new Error("provider_unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxResponseBytes) throw new Error("provider_response_budget");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
	// One logical source call may issue multiple HTTP requests. Count each returned tag,
	// successful Release and consumer manifest against one cumulative interpreted-row budget.
	let sourceRows = 0;
	let restRequests = 0;
	let candidates: string[];
	try {
		restRequests++;
		const refs = await getJson(`${api}/git/matching-refs/tags/train-v?per_page=100`, signal, budget.maxResponseBytes);
		asOf = refs.date;
		if (!Array.isArray(refs.body)) return unknown("tags=malformed", "incomplete_or_invalid_source", asOf);
		sourceRows = refs.body.length;
		if (sourceRows > budget.maxRows) return unknown("tags=row_budget", "incomplete_or_invalid_source", asOf);
		if (refs.body.some((r) => !isRecord(r) || typeof r.ref !== "string" || !validGitRef(r.ref)))
			return unknown("tags=malformed", "incomplete_or_invalid_source", asOf);
		candidates = (refs.body as { ref?: unknown }[])
			.map((r) => (typeof r.ref === "string" ? r.ref.replace(/^refs\/tags\/train-v/, "") : ""))
			.filter((v) => SEMVER.test(v))
			.sort((a, b) => compareVersions(b, a))
			.slice(0, FLEET_TRAIN_CANDIDATES);
	} catch (error) {
		signal.throwIfAborted();
		return unknown(`tags=${(error as Error).message}`, "source_failed", null);
	}
	let train: string | null = null;
	const cutoff = at.getTime() - p.graceHours * 3600_000;
	try {
		for (const version of candidates) {
			const releases: ReleaseLike[] = [];
			for (const member of p.members) {
				const tag = `${member.tagPrefix}${version}`;
				if (restRequests >= FLEET_TRAIN_MAX_REST_REQUESTS) return unknown("releases=request_budget", "incomplete_or_invalid_source", asOf);
				restRequests++;
				const got = await getJson(`${api}/releases/tags/${encodeURIComponent(tag)}`, signal, budget.maxResponseBytes).catch(
					(error: Error) => {
						if (error.message === "provider_status_404") return null; // not published: the train is partial
						throw error;
					},
				);
				if (!got) break;
				if (++sourceRows > budget.maxRows) return unknown("releases=row_budget", "incomplete_or_invalid_source", asOf);
				const body = got.body;
				if (
					!isRecord(body) ||
					body.tag_name !== tag ||
					(body.published_at !== null &&
						(typeof body.published_at !== "string" ||
							!validPublishedAt(body.published_at))) ||
					(body.draft !== undefined && typeof body.draft !== "boolean")
				)
					return unknown(
						`releases=malformed:${tag}`,
						"incomplete_or_invalid_source",
						asOf,
					);
				const release = body as unknown as ReleaseLike;
				if (release.draft || !release.published_at || Date.parse(release.published_at) > cutoff) break;
				releases.push(release);
			}
			train = latestCompleteTrain(releases, p.members, at, p.graceHours);
			if (train !== null) break;
		}
	} catch (error) {
		signal.throwIfAborted();
		return unknown(`releases=${(error as Error).message}`, "source_failed", asOf);
	}
	if (train === null) return unknown(restRequests >= FLEET_TRAIN_MAX_REST_REQUESTS ? "releases=request_budget" : "train=none", "incomplete_or_invalid_source", asOf);

	if (sourceRows + p.consumers.length > budget.maxRows)
		return unknown(`train=${train};manifests=row_budget`, "incomplete_or_invalid_source", asOf);
	const read = await Promise.allSettled(
		p.consumers.map(async (c) => ({
			repo: c.repo,
			manifest: (await getJson(`https://raw.githubusercontent.com/${c.repo}/HEAD/${c.manifestPath}`, signal, budget.maxResponseBytes)).body,
		})),
	);
	signal.throwIfAborted();
	const failed = p.consumers.filter((_, i) => read[i]?.status !== "fulfilled").map((c) => c.repo);
	if (failed.length) {
		const failures = read.flatMap((result, i) => result.status === "rejected" ? [`${p.consumers[i]?.repo}:${result.reason instanceof Error ? result.reason.message : "provider_unavailable"}`] : []);
		return unknown(`train=${train};unreadable=${failed.join(",")};failures=${failures.join(",")}`, "source_failed", asOf);
	}
	const manifests = read.map((r) => (r as PromiseFulfilledResult<{ repo: string; manifest: unknown }>).value);
	const malformed = manifests.filter((m) => !validManifest(m.manifest)).map((m) => m.repo);
	if (malformed.length) return unknown(`train=${train};malformed=${malformed.join(",")}`, "incomplete_or_invalid_source", asOf);
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
