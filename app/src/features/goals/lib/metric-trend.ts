// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import type { MetricObservation } from "@cogni-dao/metrics/contracts";
/** Observed change only. Never bridge a failed reading or an unobserved gap. */
export function metricTrace(
	history: readonly MetricObservation[],
	maxGapMs: number,
	maxSourceAgeMs = maxGapMs,
) {
	const ordered = [...history].sort(
		(a, b) => Date.parse(a.window.end) - Date.parse(b.window.end),
	);
	const segments: { at: number; value: number; id: string }[][] = [];
	let segment: { at: number; value: number; id: string }[] = [];
	for (const r of ordered) {
		const at = Date.parse(r.window.end);
		const measuredAt = Date.parse(r.observedAt ?? r.window.end);
		const sourceFresh =
			Number.isFinite(measuredAt) &&
			!!r.sourceWatermarks?.length &&
			r.sourceWatermarks.every((w) => {
				const sourceAt = w.asOf ? Date.parse(w.asOf) : NaN;
				return (
					Number.isFinite(sourceAt) &&
					sourceAt <= measuredAt &&
					measuredAt - sourceAt <= maxSourceAgeMs
				);
			});
		const previous = segment.at(-1);
		if (
			r.status !== "ok" ||
			r.value === null ||
			!Number.isFinite(at) ||
			!sourceFresh
		) {
			if (segment.length) segments.push(segment);
			segment = [];
			continue;
		}
		if (previous && (at - previous.at > maxGapMs || at <= previous.at)) {
			segments.push(segment);
			segment = [];
		}
		segment.push({ at, value: r.value, id: r.id });
	}
	if (segment.length) segments.push(segment);
	// A failed latest reading cannot borrow an earlier successful trend.
	const recent = segment.length ? segment : undefined;
	const first = recent?.[0],
		last = recent?.at(-1);
	const span = first && last ? last.at - first.at : 0;
	const unitMs =
		span >= 86400000 ? 86400000 : span >= 3600000 ? 3600000 : 60000;
	return {
		segments,
		span,
		rate:
			first && last && span > 0
				? (last.value - first.value) / (span / unitMs)
				: null,
		rateUnit: unitMs === 86400000 ? "day" : unitMs === 3600000 ? "h" : "min",
		unitMs,
	};
}
/** Average pace needed from the current observation to a commitment, not an AI forecast. */
export function requiredPace(
	value: number,
	target: number,
	deadline: string | null,
	now: number,
	unitMs: number,
) {
	const end = deadline ? Date.parse(deadline) : NaN;
	return Number.isFinite(end) && end > now
		? (target - value) / ((end - now) / unitMs)
		: null;
}
