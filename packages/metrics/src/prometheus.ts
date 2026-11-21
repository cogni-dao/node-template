// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `http.requests@1`: request health read from `http_requests_total{route,status}`
 * through a Prometheus-compatible instant reader the node injects. Package code
 * pins every PromQL text under a query id and builds it only from code constants
 * and validated scope values; no definition row, param or result label ever
 * reaches a query. Every read is checked for freshness, coverage and volume, so
 * a missing, stale or partial series reads unknown and never 0.
 *
 * Invariants: SCOPE_IN_CODE (node and env matchers are on every query);
 * ABSENT_IS_NOT_ZERO (an empty, stale or partial feed is incomplete with a
 * marker); NEVER_TRUNCATE (a vector over `PROM_MAX_SERIES` is incomplete);
 * NO_ERROR_TEXT (a reader failure is a class name at most).
 */
import { z } from "zod";
import {
	type CalculatorContext,
	type MetricCalculator,
	MetricError,
	type MetricSample,
} from "./contracts.js";

/** One vector element of a Prometheus instant query. */
export interface PromInstantSample {
	metric: Readonly<Record<string, string>>;
	/** `[unix seconds, value as a string]`, per the Prometheus HTTP API. */
	value: readonly [number, string];
}
/**
 * The instant read the calculator needs. The app's `MetricsQueryPort.queryInstant`
 * satisfies it structurally, so this package imports nothing from an app.
 */
export interface PromInstantReader {
	queryInstant(params: {
		query: string;
		time: Date;
		signal?: AbortSignal;
	}): Promise<{ resultType: string; result: ReadonlyArray<PromInstantSample> }>;
}

/** The series every request-health query reads. */
export const HTTP_REQUESTS_SERIES = "http_requests_total";
/**
 * Label names on the series. `node` and `env` are set by the operator's lane scrape
 * (bug.5641, honor_labels=false, so the app's own labels become `exported_*`);
 * `route` and `status` are set by the app's route wrapper.
 * The node and env names are the defaults of the ONE override point
 * (`PromScopeInput.labelNames`).
 */
export const HTTP_REQUEST_LABEL_NAMES = {
	app: "app",
	env: "env",
	node: "node",
	route: "route",
	status: "status",
} as const;
/** A value in a selector: letters, digits, dot, underscore, hyphen. */
export const PROM_SELECTOR_VALUE = /^[A-Za-z0-9._-]{1,64}$/;
const PROM_LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Routes that are probes (`meta.*`) or machine traffic (`*.internal`); the KPI leaves them out. */
const EXCLUDED_ROUTES = String.raw`meta\\..*|.*\\.internal`;
/** Freshest sample at most this old at window end. */
export const PROM_MAX_AGE_SECONDS = 600;
/** The oldest sample may start this share of the window after its start. */
export const PROM_MAX_START_GAP = 0.1;
/** More series than this in one vector is incomplete, never truncated. */
export const PROM_MAX_SERIES = 2000;
/** The calculator budget; each source call stays below `timeoutMs`. */
export const HTTP_REQUESTS_TIMEOUT_MS = 15000;
export const HTTP_REQUESTS_CALL_TIMEOUT_MS = 10000;
export const HTTP_REQUESTS_MAX_SOURCE_CALLS = 3;
const MAX_RESPONSE_BYTES = 1048576;
/** The routes named in the diagnostic's evidence. */
const WORST_ROUTES_NAMED = 3;

export const HTTP_REQUESTS_ID = "http.requests@1";
export const httpRequestsParams = z.strictObject({
	output: z.enum(["success_ratio", "worst_route_failure"]),
	hours: z.number().int().min(1).max(168),
	minRequests: z.number().int().min(1).max(1_000_000),
});
export type HttpRequestsParams = z.infer<typeof httpRequestsParams>;

/** What a node says about the series' scope. */
export interface PromScopeInput {
	/** Extra fixed matchers (for example `{job: "node-lanes"}`); never the node or env names. */
	labels?: Record<string, string>;
	/** The ONE override point for the scrape's label names. */
	labelNames?: { node?: string; env?: string };
}

const invalidScope = () => new MetricError("invalid_prometheus_scope", 422);
const selectorValue = (value: string) => {
	if (!PROM_SELECTOR_VALUE.test(value)) throw invalidScope();
	return value;
};

/** Validated label names and fixed labels; throws on a reserved or malformed one. */
export function promScope(input: PromScopeInput) {
	const nodeName = input.labelNames?.node ?? HTTP_REQUEST_LABEL_NAMES.node;
	const envName = input.labelNames?.env ?? HTTP_REQUEST_LABEL_NAMES.env;
	const reserved = new Set<string>([
		nodeName,
		envName,
		HTTP_REQUEST_LABEL_NAMES.route,
		HTTP_REQUEST_LABEL_NAMES.status,
	]);
	if (
		!PROM_LABEL_NAME.test(nodeName) ||
		!PROM_LABEL_NAME.test(envName) ||
		nodeName === envName
	)
		throw invalidScope();
	const labels = Object.entries(input.labels ?? {}).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	for (const [name, value] of labels) {
		if (!PROM_LABEL_NAME.test(name) || reserved.has(name)) throw invalidScope();
		selectorValue(value);
	}
	return { nodeName, envName, labels };
}

/** The matcher list every query carries: fixed labels, then env, then node. */
export function promMatchers(
	scope: ReturnType<typeof promScope>,
	node: string,
	environment: string,
): string {
	return [
		...scope.labels.map(([name, value]) => `${name}="${value}"`),
		`${scope.envName}="${selectorValue(environment)}"`,
		`${scope.nodeName}="${selectorValue(node)}"`,
	].join(",");
}

/** The six pinned queries, keyed by query id. `hours` must be an integer 1..168. */
export function httpRequestQueries(matchers: string, hours: number) {
	if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw invalidScope();
	const S = HTTP_REQUESTS_SERIES;
	const { route, status } = HTTP_REQUEST_LABEL_NAMES;
	const w = `${hours}h`;
	const served = `${route}!~"${EXCLUDED_ROUTES}"`;
	const sel = (extra?: string) => `${S}{${matchers}${extra ? `,${extra}` : ""}}`;
	return {
		// The ratio is computed in the query. The numerator falls back to 0, so a
		// window where every request failed reads 0%, not an empty vector.
		success_ratio: `100 * (sum(increase(${sel(`${status}!="5xx",${served}`)}[${w}])) or vector(0)) / sum(increase(${sel(served)}[${w}]))`,
		volume: `sum(increase(${sel(served)}[${w}]))`,
		freshness: `max(last_over_time(timestamp(${sel()})[30m:1m]))`,
		coverage: `min(min_over_time(timestamp(${sel()})[${w}:5m]))`,
		route_totals: `sum by (${route}) (increase(${sel()}[${w}]))`,
		route_failures: `sum by (${route}) (increase(${sel(`${status}="5xx"`)}[${w}]))`,
	} as const;
}

type Vector = ReadonlyArray<{ labels: Readonly<Record<string, string>>; value: number }>;
/** An instant read, parsed; `invalid` names why it cannot be trusted. */
type Read = { rows: Vector } | { invalid: string };
/** A reader failure that is not an abort; only its class name survives. */
class SourceFailure extends Error {
	constructor(readonly className: string) {
		super("source_failed");
	}
}

/** One read bounded by its own timeout and the caller's signal. */
async function instant(
	reader: PromInstantReader,
	query: string,
	time: Date,
	parent: AbortSignal,
): Promise<Read> {
	const controller = new AbortController();
	const abort = () => controller.abort(parent.reason);
	if (parent.aborted) abort();
	parent.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("source_timeout")),
		HTTP_REQUESTS_CALL_TIMEOUT_MS,
	);
	const signal = controller.signal;
	const stopped = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
	stopped.catch(() => undefined);
	let result: Awaited<ReturnType<PromInstantReader["queryInstant"]>>;
	try {
		result = await Promise.race([
			reader.queryInstant({ query, time, signal }),
			stopped,
		]);
	} catch (error) {
		// An abort or timeout propagates, so the service records `error`.
		if (signal.aborted) throw signal.reason ?? error;
		const name = error instanceof Error ? error.constructor.name : "";
		throw new SourceFailure(/^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "unknown");
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", abort);
	}
	if (result.resultType !== "vector" || !Array.isArray(result.result))
		return { invalid: "invalid_vector" };
	if (result.result.length > PROM_MAX_SERIES) return { invalid: "series_cap" };
	const rows: Array<Vector[number]> = [];
	for (const item of result.result) {
		const raw = item?.value?.[1];
		if (typeof raw !== "string" || typeof item.metric !== "object")
			return { invalid: "invalid_vector" };
		rows.push({ labels: item.metric ?? {}, value: Number(raw) });
	}
	return { rows };
}

/** A usable number: finite and not negative. */
const usable = (n: number) => Number.isFinite(n) && n >= 0;

type Scalar =
	| { state: "empty" }
	| { state: "invalid" }
	| { state: "ok"; value: number };
function scalar(read: Read): Scalar {
	if ("invalid" in read) return { state: "invalid" };
	if (read.rows.length === 0) return { state: "empty" };
	const only = read.rows[0];
	if (read.rows.length !== 1 || !only || !usable(only.value))
		return { state: "invalid" };
	return { state: "ok", value: only.value };
}

/** Counts by route; a missing, malformed or repeated route label is invalid. */
function byRoute(read: Read): Map<string, number> | null {
	if ("invalid" in read) return null;
	const out = new Map<string, number>();
	for (const row of read.rows) {
		const route = row.labels[HTTP_REQUEST_LABEL_NAMES.route];
		if (
			typeof route !== "string" ||
			!PROM_SELECTOR_VALUE.test(route) ||
			out.has(route) ||
			!usable(row.value)
		)
			return null;
		out.set(route, row.value);
	}
	return out;
}

const round = (n: number) => Math.round(n);

/**
 * Build the `http.requests@1` calculator. Without a reader it is still
 * registered, so every node publishes the same catalog; it then reads unknown
 * with the `prometheus:not_configured` marker.
 */
export function createHttpRequestsCalculator(deps: {
	prometheus?: { query: PromInstantReader } & PromScopeInput;
	node: string;
	environment: string;
	/** `tick.shareOnce`: identical reads inside one refresh tick run once. */
	share: <T>(
		key: string,
		fn: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	) => Promise<T>;
}): MetricCalculator {
	const scope = deps.prometheus ? promScope(deps.prometheus) : null;
	return {
		id: HTTP_REQUESTS_ID,
		unit: "%",
		display: "slo",
		windowSeconds: (params) => httpRequestsParams.parse(params).hours * 3600,
		paramsSchema: httpRequestsParams,
		// One call reads freshness and coverage, one the volume or per-route
		// totals, one the ratio or per-route failures. Rows cap each vector.
		budget: {
			timeoutMs: HTTP_REQUESTS_TIMEOUT_MS,
			maxSourceCalls: HTTP_REQUESTS_MAX_SOURCE_CALLS,
			maxRows: PROM_MAX_SERIES,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		},
		compute: async (params, ctx) => compute(httpRequestsParams.parse(params), ctx),
	};

	function compute(p: HttpRequestsParams, ctx: CalculatorContext) {
		const base = [
			"source:prometheus",
			`series:${HTTP_REQUESTS_SERIES}`,
			`query:http.requests.${p.output}@1`,
			`window:${p.hours}h`,
		];
		const unknown = (
			reason: NonNullable<MetricSample["reason"]>,
			markers: string[],
			asOf: string | null = null,
		): MetricSample => ({
			value: 0,
			unit: "%",
			complete: false,
			reason,
			sourceWatermarks: [{ source: `prometheus.${HTTP_REQUESTS_SERIES}`, asOf }],
			evidenceRefs: [...base, ...markers],
		});
		if (!deps.prometheus || !scope)
			return Promise.resolve(unknown("source_failed", ["prometheus:not_configured"]));
		const reader = deps.prometheus.query;
		const end = Date.parse(ctx.window.end);
		if (!Number.isFinite(end))
			return Promise.resolve(unknown("incomplete_or_invalid_source", ["invalid_window"]));
		const time = new Date(end);
		const q = httpRequestQueries(
			promMatchers(scope, deps.node, deps.environment),
			p.hours,
		);
		const endSeconds = end / 1000;
		const startSeconds = endSeconds - p.hours * 3600;
		// Reads in one minute share the same evaluation instant to the minute.
		const minute = Math.floor(end / 60000);
		const run = (text: string, signal: AbortSignal) =>
			deps.share(`prom:${minute}:${text}`, (s) => instant(reader, text, time, s), signal);
		return measure();

		async function measure(): Promise<MetricSample> {
			const first = p.output === "success_ratio" ? q.volume : q.route_totals;
			const second = p.output === "success_ratio" ? q.success_ratio : q.route_failures;
			const settled = await Promise.allSettled([
				ctx.read((signal) =>
					Promise.all([run(q.freshness, signal), run(q.coverage, signal)]),
				),
				ctx.read((signal) => run(first, signal)),
				ctx.read((signal) => run(second, signal)),
			]);
			let failure: SourceFailure | undefined;
			for (const outcome of settled) {
				if (outcome.status === "fulfilled") continue;
				// An abort, a timeout or a call-budget error ends the run as an error.
				if (!(outcome.reason instanceof SourceFailure)) throw outcome.reason;
				failure ??= outcome.reason;
			}
			if (failure)
				return unknown("source_failed", [`error:${failure.className}`]);
			const [health, a, b] = settled.map((o) =>
				o.status === "fulfilled" ? o.value : undefined,
			) as [[Read, Read], Read, Read];
			const [freshRead, coverRead] = health;
			for (const read of [freshRead, coverRead, a, b])
				if ("invalid" in read)
					return unknown("incomplete_or_invalid_source", [read.invalid]);
			const fresh = scalar(freshRead);
			const cover = scalar(coverRead);
			// No sample in the last 30 minutes: absent if none ever shows in the
			// window, stale if the window saw some.
			if (fresh.state === "empty")
				return unknown("incomplete_or_invalid_source", [
					cover.state === "empty" ? "series_absent" : "feed_stale",
				]);
			if (fresh.state === "invalid" || endSeconds - fresh.value < 0)
				return unknown("incomplete_or_invalid_source", ["invalid_timestamp"]);
			const newest = new Date(fresh.value * 1000).toISOString();
			if (endSeconds - fresh.value > PROM_MAX_AGE_SECONDS)
				return unknown("incomplete_or_invalid_source", ["feed_stale"], newest);
			if (cover.state === "invalid")
				return unknown("incomplete_or_invalid_source", ["invalid_timestamp"], newest);
			// Only the left edge is checked: a gap inside the window is a known limit.
			if (
				cover.state === "empty" ||
				cover.value - startSeconds > PROM_MAX_START_GAP * p.hours * 3600
			)
				return unknown("incomplete_or_invalid_source", ["partial_window"], newest);
			const ok = (value: number, evidence: string[]): MetricSample => ({
				value,
				unit: "%",
				complete: true,
				sourceWatermarks: [
					{ source: `prometheus.${HTTP_REQUESTS_SERIES}`, asOf: newest },
				],
				evidenceRefs: [...base, `newest:${newest}`, ...evidence],
			});

			if (p.output === "success_ratio") {
				const volume = scalar(a);
				if (volume.state === "invalid")
					return unknown("incomplete_or_invalid_source", ["invalid_volume"], newest);
				if (volume.state === "empty" || volume.value < p.minRequests)
					return unknown(
						"zero_denominator",
						[`counts:requests=${volume.state === "ok" ? round(volume.value) : 0}`],
						newest,
					);
				const ratio = scalar(b);
				// 100 * n / (n + failed) cannot pass 100; a larger value is a broken read.
				if (ratio.state !== "ok" || ratio.value > 100 + 1e-6)
					return unknown("incomplete_or_invalid_source", ["invalid_ratio"], newest);
				return ok(Math.min(100, ratio.value), [
					`counts:requests=${round(volume.value)}`,
				]);
			}

			const totals = byRoute(a);
			const failures = byRoute(b);
			if (!totals || !failures)
				return unknown("incomplete_or_invalid_source", ["invalid_route"], newest);
			// Meta and internal routes stay in: a failing probe must stay visible.
			const ranked = [...totals]
				.filter(([, total]) => total >= p.minRequests)
				.map(([route, total]) => {
					const failed = failures.get(route) ?? 0;
					return { route, total, failed, share: (failed / total) * 100 };
				});
			const counts = `counts:routes=${totals.size};eligible=${ranked.length}`;
			if (ranked.length === 0)
				return unknown("zero_denominator", [counts], newest);
			if (ranked.some((r) => r.share > 100 + 1e-6))
				return unknown("incomplete_or_invalid_source", ["invalid_ratio"], newest);
			// Highest share first; equal shares (to 1e-6 percent) by route id ascending.
			const key = (r: { share: number }) => Math.round(r.share * 1e6);
			ranked.sort(
				(x, y) =>
					key(y) - key(x) || (x.route < y.route ? -1 : x.route > y.route ? 1 : 0),
			);
			const top = ranked[0];
			if (!top) return unknown("zero_denominator", [counts], newest);
			return ok(Math.min(100, top.share), [
				counts,
				...ranked
					.slice(0, WORST_ROUTES_NAMED)
					.map((r) => `worst:${r.route}:failed=${round(r.failed)};total=${round(r.total)}`),
			]);
		}
	}
}
