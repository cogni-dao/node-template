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
 * 7. behind: otherwise.
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
	// 3. building
	const latest = input.latestAttempt;
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
			"delayed",
			latest?.status === "pending" ? null : "metric_unavailable",
			null,
		);
	if (
		now.getTime() - Date.parse(lastGood.window.end) > maxAge ||
		(latest?.id === lastGood.id && input.viewState === "stale")
	)
		return result("delayed", null, lastGood);
	// Rule 1 also covers a stored reading whose unit differs from the target.
	if (lastGood.unit !== binding.target.unit)
		return result("not_measured", "unit_mismatch", null);
	// 6/7. on_track or behind.
	return result(
		satisfies(
			binding.comparator,
			lastGood.value as number,
			binding.target.value,
		)
			? "on_track"
			: "behind",
		null,
		lastGood,
	);
}
