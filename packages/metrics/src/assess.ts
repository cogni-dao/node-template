// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Pure KPI assessment, evaluation selection and history bucketing. No I/O, no clock.
 *
 * assessKpi rules, first match wins (metric-foundation-design "One assessment"):
 * 1. not_measured: no binding; calculator/metric absent, denied or unreadable;
 *    or a unit mismatch between the binding target and the metric/reading (unit_mismatch).
 * 2. At or after the deadline: evaluating (evaluation_not_due) until deadline + maxAge,
 *    then met / missed from the backward-final reading, else unresolved (no_reading_at_evaluation).
 * 3. building (insufficient_history): the latest attempt reports insufficient_history
 *    (source history does not yet cover the KPI window).
 * 4. failing: the latest attempt is error or unavailable; reason from that attempt.
 * 5. delayed: no ok reading yet (metric_unavailable; null while the first attempt is pending),
 *    the newest ok reading is older than maxAge, or its source evidence is stale.
 *    A never-measured scheduled metric is late data, not a failure or a young source.
 * 6. on_track: the fresh value satisfies the comparator.
 * 7. behind: otherwise. A binding with `breach: "failing"` returns failing / target_breached
 *    instead, before the deadline only (rule 2 already ended the pre-deadline path).
 * Pace is display only and never decides status. Value/observationId are the reading
 * the status speaks about: evaluation reading (2), last good (3-5), fresh (6-7).
 */
import {
	type KpiAssessment,
	type KpiBinding,
	type KpiReason,
	KpiReasonSchema,
	MetricError,
	type MetricHistory,
	type MetricHistoryInput,
	type MetricHistoryStep,
	type MetricObservation,
	type MetricView,
} from "./contracts.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Use the authorized service for every read, including pinned observations. */
export function createWorkMetricReader(
	service: {
		read(id: string): Promise<MetricView>;
		observation(
			id: string,
			observationId: string,
		): Promise<{ observation: MetricObservation }>;
	},
	now: () => Date = () => new Date(),
) {
	const readLatest = async (id: string, requireReadable: boolean) => {
		const view = await service.read(id);
		const attempt = view.latestAttempt;
		if (!attempt) {
			if (requireReadable && view.viewState === "error")
				throw new MetricError("metrics_unavailable", 503);
			return null;
		}
		const age = now().getTime() - Date.parse(attempt.window.end);
		const fresh =
			Number.isFinite(age) &&
			age >= 0 &&
			age <= view.definition.spec.maxAgeSeconds * 1000;
		return {
			...attempt,
			metricTitle: view.definition.title,
			maxAgeSeconds: view.definition.spec.maxAgeSeconds,
			viewState:
				view.viewState === "ok" && !fresh ? ("stale" as const) : view.viewState,
		};
	};
	return {
		latest: (id: string) => readLatest(id, false),
		async baselineId(id: string) {
			const attempt = await readLatest(id, true);
			return attempt?.viewState === "ok" &&
				attempt.status === "ok" &&
				attempt.value !== null &&
				Number.isFinite(attempt.value) &&
				attempt.observedAt !== null &&
				Number.isFinite(Date.parse(attempt.observedAt))
				? attempt.id
				: null;
		},
		async observation(id: string, observationId: string) {
			return (await service.observation(id, observationId)).observation;
		},
	};
}

/** Compare authorized observations from the same measurement series. */
export function assessDirection(
	direction: "up" | "down" | null,
	baseline: MetricObservation | null,
	current:
		| (MetricObservation & {
				viewState?: MetricView["viewState"];
				maxAgeSeconds?: number;
		  })
		| null,
): "as_declared" | "against" | "flat" | "unknown" | null {
	if (direction === null) return null;
	if (
		!baseline ||
		!current ||
		baseline.status !== "ok" ||
		current.status !== "ok" ||
		(current.viewState !== undefined && current.viewState !== "ok") ||
		baseline.value === null ||
		current.value === null ||
		!Number.isFinite(baseline.value) ||
		!Number.isFinite(current.value)
	)
		return "unknown";
	for (const observation of [baseline, current]) {
		if (
			!observation.observedAt ||
			!Number.isFinite(Date.parse(observation.observedAt)) ||
			!observation.sourceWatermarks.length ||
			observation.sourceWatermarks.some(
				(watermark) =>
					!watermark.asOf || !Number.isFinite(Date.parse(watermark.asOf)),
			)
		)
			return "unknown";
		const maxAgeSeconds = current.maxAgeSeconds;
		if (maxAgeSeconds !== undefined) {
			const windowAge =
				Date.parse(observation.observedAt) - Date.parse(observation.window.end);
			if (
				!Number.isFinite(maxAgeSeconds) ||
				maxAgeSeconds < 0 ||
				!Number.isFinite(windowAge) ||
				windowAge < 0 ||
				windowAge > maxAgeSeconds * 1000
			)
				return "unknown";
		}
		if (
			maxAgeSeconds !== undefined &&
			observation.sourceWatermarks.some((watermark) => {
				const age =
					Date.parse(observation.observedAt as string) -
					Date.parse(watermark.asOf as string);
				return age < 0 || age > maxAgeSeconds * 1000;
			})
		)
			return "unknown";
	}
	for (const field of [
		"metricId",
		"definitionHash",
		"calculatorVersion",
		"paramsHash",
		"node",
		"environment",
		"dataScope",
		"unit",
	] as const)
		if (baseline[field] !== current[field]) return "unknown";
	const duration = (o: MetricObservation) =>
		Date.parse(o.window.end) - Date.parse(o.window.start);
	const first = duration(baseline),
		second = duration(current);
	if (
		!Number.isFinite(first) ||
		first < 0 ||
		first !== second ||
		Date.parse(current.window.end) < Date.parse(baseline.window.end)
	)
		return "unknown";
	if (baseline.value === current.value) return "flat";
	return current.value > baseline.value === (direction === "up")
		? "as_declared"
		: "against";
}
export const HISTORY_STEP_MS: Record<MetricHistoryStep, number> = {
	"1h": HOUR,
	"1d": DAY,
	"1w": WEEK,
};
/** 1h and 1d align to 2000-01-01T00:00Z; 1w aligns to Monday 2000-01-03T00:00Z. */
export const HISTORY_ORIGIN_MS: Record<MetricHistoryStep, number> = {
	"1h": Date.UTC(2000, 0, 1),
	"1d": Date.UTC(2000, 0, 1),
	"1w": Date.UTC(2000, 0, 3),
};
export const MAX_HISTORY_BUCKETS = 400;

export interface MetricHistoryRange {
	from: string;
	to: string;
	step: MetricHistoryStep;
	stepMs: number;
	/** Bucket start instants, ascending. Each bucket is [start, start + step). */
	starts: number[];
}

/** Validates alignment and size before any read; never truncates silently. */
export function metricHistoryRange(
	input: MetricHistoryInput,
	now: Date,
	options?: { allowOpenBucket?: boolean },
): MetricHistoryRange {
	const from = Date.parse(input.from);
	const to = Date.parse(input.to);
	const stepMs = HISTORY_STEP_MS[input.step];
	const origin = HISTORY_ORIGIN_MS[input.step];
	if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
		throw new MetricError("invalid_range", 400);
	if ((from - origin) % stepMs !== 0 || (to - origin) % stepMs !== 0)
		throw new MetricError("misaligned_range", 400);
	// The internal trend may include the bucket that contains now; callers may not.
	const limit = options?.allowOpenBucket
		? floorTo(now.getTime(), input.step) + stepMs
		: now.getTime();
	if (to > limit) throw new MetricError("invalid_range", 400);
	const count = (to - from) / stepMs;
	if (count > MAX_HISTORY_BUCKETS)
		throw new MetricError("too_many_buckets", 400);
	return {
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		step: input.step,
		stepMs,
		starts: Array.from({ length: count }, (_, i) => from + i * stepMs),
	};
}

export function floorTo(ms: number, step: MetricHistoryStep): number {
	const origin = HISTORY_ORIGIN_MS[step];
	const size = HISTORY_STEP_MS[step];
	return origin + Math.floor((ms - origin) / size) * size;
}

/**
 * Reference bucketing over stored attempts (keyed on window.end). The Postgres
 * adapter computes the same result in SQL. Value is the last ok reading; a
 * bucket with only failed attempts carries the latest failure status.
 */
export function bucketObservations(
	observations: readonly MetricObservation[],
	range: Pick<MetricHistoryRange, "starts" | "stepMs">,
): MetricHistory["buckets"] {
	return range.starts.map((start) => {
		const end = start + range.stepMs;
		const inside = observations
			.filter((o) => {
				const t = Date.parse(o.window.end);
				return o.status !== "pending" && t >= start && t < end;
			})
			.sort(
				(a, b) =>
					Date.parse(b.window.end) - Date.parse(a.window.end) ||
					b.id.localeCompare(a.id),
			);
		const ok = inside.find((o) => o.status === "ok" && o.value !== null);
		const pick = ok ?? inside[0];
		return {
			start: new Date(start).toISOString(),
			end: new Date(end).toISOString(),
			status: (pick?.status ?? "missing") as
				| "ok"
				| "error"
				| "unavailable"
				| "missing",
			value: ok?.value ?? null,
			observationId: pick?.id ?? null,
		};
	});
}

/** Backward-only fixed evaluation; the eligible set never grows after evaluationAt + maxAge. */
export function selectEvaluation(
	observations: readonly MetricObservation[],
	evaluationAt: string,
	maxAgeSeconds: number,
): MetricObservation | null {
	const at = Date.parse(evaluationAt);
	const maxAge = maxAgeSeconds * 1000;
	return (
		observations
			.filter((o) => {
				const end = Date.parse(o.window.end);
				const observed = o.observedAt ? Date.parse(o.observedAt) : Number.NaN;
				return (
					o.status === "ok" &&
					o.value !== null &&
					end >= at - maxAge &&
					end <= at &&
					observed <= at + maxAge
				);
			})
			.sort(
				(a, b) =>
					Date.parse(b.window.end) - Date.parse(a.window.end) ||
					Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? "") ||
					b.id.localeCompare(a.id),
			)[0] ?? null
	);
}

export function satisfies(
	comparator: KpiBinding["comparator"],
	value: number,
	target: number,
): boolean {
	return comparator === "gte"
		? value >= target
		: comparator === "lte"
			? value <= target
			: value === target;
}

/** Stored observation reasons are strings; readers act only on the enum. */
export function toKpiReason(reason: string | null | undefined): KpiReason {
	const parsed = KpiReasonSchema.safeParse(reason);
	return parsed.success ? parsed.data : "source_failed";
}

export interface KpiAssessmentInput {
	binding: KpiBinding;
	/** Null when the calculator or metric is absent, denied or unreadable (rule 1). */
	metric: { unit: string; maxAgeSeconds: number } | null;
	unavailable?: KpiReason | undefined;
	latestAttempt: MetricObservation | null;
	lastGood: MetricObservation | null;
	viewState: MetricView["viewState"];
	/** Goal evaluateAt or binding.evaluationAt. */
	deadline: string | null;
	/** Backward-final reading for the deadline (rule 2); ignored before it. */
	evaluation: MetricObservation | null;
	/** Trailing 28 daily buckets for display pace. Never decides status. */
	daily: MetricHistory["buckets"];
	now: Date;
}

function observedPace(daily: MetricHistory["buckets"]): number | null {
	const points = daily.filter((b) => b.status === "ok" && b.value !== null);
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last || points.length < 2) return null;
	const span = Date.parse(last.start) - Date.parse(first.start);
	if (span < WEEK) return null;
	return (((last.value as number) - (first.value as number)) * WEEK) / span;
}

/** First matching rule wins; see metric-foundation-design "One assessment". */
export function assessKpi(input: KpiAssessmentInput): KpiAssessment {
	const { binding, metric, now } = input;
	const deadline = input.deadline
		? new Date(Date.parse(input.deadline)).toISOString()
		: null;
	const deadlineMs = deadline ? Date.parse(deadline) : null;
	const observed = observedPace(input.daily.slice(-28));
	const result = (
		status: KpiAssessment["status"],
		reason: KpiReason | null,
		reading: MetricObservation | null,
	): KpiAssessment => {
		const value = reading?.value ?? null;
		const needed =
			value !== null && deadlineMs !== null && now.getTime() < deadlineMs
				? ((binding.target.value - value) * WEEK) / (deadlineMs - now.getTime())
				: null;
		return {
			status,
			reason,
			value,
			unit: reading?.unit ?? metric?.unit ?? binding.target.unit,
			observationId: reading?.id ?? null,
			observedAt: reading?.observedAt ?? null,
			comparator: binding.comparator,
			target: binding.target,
			deadline,
			pace: {
				observed: Number.isFinite(observed) ? observed : null,
				needed: needed !== null && Number.isFinite(needed) ? needed : null,
			},
		};
	};
	// 1. not_measured
	if (!metric)
		return result("not_measured", input.unavailable ?? "no_binding", null);
	if (metric.unit !== binding.target.unit)
		return result("not_measured", "unit_mismatch", null);
	const maxAge = metric.maxAgeSeconds * 1000;
	// 2. At or after the deadline: backward-only, final after deadline + maxAge.
	if (deadlineMs !== null && now.getTime() >= deadlineMs) {
		const reading =
			input.evaluation?.status === "ok" && input.evaluation.value !== null
				? input.evaluation
				: null;
		if (now.getTime() < deadlineMs + maxAge)
			return result("evaluating", "evaluation_not_due", reading);
		if (!reading) return result("unresolved", "no_reading_at_evaluation", null);
		if (reading.unit !== binding.target.unit)
			return result("unresolved", "unit_mismatch", reading);
		return result(
			satisfies(
				binding.comparator,
				reading.value as number,
				binding.target.value,
			)
				? "met"
				: "missed",
			null,
			reading,
		);
	}
	const lastGood =
		input.lastGood?.status === "ok" && input.lastGood.value !== null
			? input.lastGood
			: null;
	// Fixed predictions remain unresolved before their immutable deadline.
	// Rolling progress and refresh state do not decide a future commitment.
	if (
		deadlineMs !== null &&
		binding.evaluationAt &&
		binding.baselineObservationId
	)
		return result(
			"unresolved",
			"evaluation_not_due",
			lastGood?.unit === binding.target.unit ? lastGood : null,
		);
	// 3. building
	const latest = input.latestAttempt;
	const pending = latest?.status === "pending" || input.viewState === "pending";
	if (
		latest?.status === "unavailable" &&
		latest.reason === "insufficient_history"
	)
		return result("building", "insufficient_history", lastGood);
	// 4. failing
	if (latest && (latest.status === "error" || latest.status === "unavailable"))
		return result("failing", toKpiReason(latest.reason), lastGood);
	// 5. delayed: no ok reading, an old one, or stale source evidence.
	if (!lastGood)
		return result(
			pending ? "building" : "delayed",
			pending ? null : "metric_unavailable",
			null,
		);
	if (
		!Number.isFinite(Date.parse(lastGood.window.end)) ||
		Date.parse(lastGood.window.end) > now.getTime() ||
		lastGood.sourceWatermarks.length === 0 ||
		lastGood.sourceWatermarks.some(({ asOf }) => {
			const at = Date.parse(asOf ?? "");
			return (
				!Number.isFinite(at) ||
				at > now.getTime() ||
				now.getTime() - at > maxAge
			);
		}) ||
		now.getTime() - Date.parse(lastGood.window.end) > maxAge ||
		(latest?.id === lastGood.id && input.viewState === "stale")
	)
		return result("delayed", null, lastGood);
	// Rule 1 also covers a stored reading whose unit differs from the target.
	if (lastGood.unit !== binding.target.unit)
		return result("not_measured", "unit_mismatch", null);
	// A pending refresh never promotes its historical value to current success.
	// Freshness/unit checks still precede this qualification; deadline verdicts precede it all.
	if (pending) return result("building", null, lastGood);
	// 6/7. on_track or behind; an opted-in breach is failing, never behind.
	if (
		satisfies(
			binding.comparator,
			lastGood.value as number,
			binding.target.value,
		)
	)
		return result("on_track", null, lastGood);
	return binding.breach === "failing"
		? result("failing", "target_breached", lastGood)
		: result("behind", null, lastGood);
}

/** Expected benefit in KPI units; this does not establish eligibility or causation. */
export function expectedKpiBenefit(input: {
	comparator: "gte" | "lte" | "eq";
	target: number;
	without: number | null;
	with: number | null;
}): number | null {
	const { comparator, target, without, with: withValue } = input;
	if (
		without === null ||
		withValue === null ||
		![target, without, withValue].every(Number.isFinite)
	)
		return null;
	const benefit =
		comparator === "gte"
			? withValue - without
			: comparator === "lte"
				? without - withValue
				: Math.abs(without - target) - Math.abs(withValue - target);
	return Number.isFinite(benefit) ? benefit : null;
}
