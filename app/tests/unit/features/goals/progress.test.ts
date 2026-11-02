// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0

import type { MetricObservation } from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import { metricTrace, requiredPace } from "@/features/goals/lib/metric-trend";

const at = Date.parse("2026-11-02T06:00:00Z");
const point = (
	value: number | null,
	minutes: number,
	status: MetricObservation["status"] = "ok",
) =>
	({
		id: String(minutes),
		metricId: "work",
		definitionHash: "same",
		status,
		value,
		window: { end: new Date(at + minutes * 60000).toISOString() },
		observedAt: new Date(at + minutes * 60000).toISOString(),
		sourceWatermarks: [
			{ source: "work", asOf: new Date(at + minutes * 60000).toISOString() },
		],
	}) as MetricObservation;
describe("observed goal feedback", () => {
	it("breaks observed rates at stale source evidence even when status is ok", () => {
		const stale = point(10, 1);
		stale.sourceWatermarks = [{ source: "work", asOf: new Date(at).toISOString() }];
		const recovered = metricTrace(
			[point(10, 0), stale, point(0, 2)],
			180000,
			30000,
		);
		expect(recovered.segments).toHaveLength(2);
		expect(recovered.rate).toBeNull();
		expect(metricTrace([point(10, 0), stale], 180000, 30000).rate).toBeNull();
	});
	it("computes a rate from elapsed observation time, not sample count", () => {
		const result = metricTrace(
			[point(4, 10), point(8, 0), point(7, 2)],
			1800000,
		);
		expect(result.rate).toBe(-0.4);
		expect(result.span).toBe(600000);
		expect(result.rateUnit).toBe("min");
	});
	it("does not bridge downtime or claim a trend from one current point", () => {
		const result = metricTrace(
			[point(8, 0), point(7, 1), point(4, 100)],
			180000,
		);
		expect(result.segments).toHaveLength(2);
		expect(result.rate).toBeNull();
	});
	it("breaks the line at failed measurements and hides an old trend on latest failure", () => {
		const result = metricTrace(
			[point(8, 0), point(7, 1), point(null, 2, "error")],
			180000,
		);
		expect(result.rate).toBeNull();
		expect(
			metricTrace([point(8, 0), point(null, 1, "error"), point(6, 2)], 180000)
				.segments,
		).toHaveLength(2);
	});
	it("preserves genuine zero and flat traces", () => {
		expect(metricTrace([point(0, 0), point(0, 1)], 180000).rate).toBe(0);
	});
	it("does not invent an expected rate without a future deadline", () => {
		expect(requiredPace(5, 0, null, at, 60000)).toBeNull();
		expect(
			requiredPace(5, 0, new Date(at).toISOString(), at, 60000),
		).toBeNull();
		expect(
			requiredPace(5, 0, new Date(at + 5 * 60000).toISOString(), at, 60000),
		).toBe(-1);
	});
});
