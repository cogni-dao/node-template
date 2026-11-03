// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it } from "vitest";
import {
	assessKpi,
	bucketObservations,
	type KpiAssessmentInput,
	type MetricHistory,
	type MetricObservation,
	metricHistoryRange,
	selectEvaluation,
} from "../src/index";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;
function reading(
	value: number | null,
	end: string,
	status: MetricObservation["status"] = "ok",
	observedAt: string = end,
): MetricObservation {
	return {
		id: `00000000-0000-4000-8000-${String(Date.parse(end) % 1e12).padStart(12, "0")}`,
		metricId: "ratio",
		definitionRevision: "1",
		definitionHash: "h",
		calculatorVersion: "work.convergence@1",
		paramsHash: "p",
		node: "n",
		environment: "e",
		dataScope: "d",
		window: { start: end, end },
		sourceWatermarks: [{ source: "s", asOf: end }],
		observedAt,
		status,
		value,
		unit: "ratio",
		reason: status === "ok" ? null : "zero_denominator",
		evidenceRefs: [],
	};
}
const fresh = reading(1.2, "2026-11-02T11:00:00.000Z");
function input(over: Partial<KpiAssessmentInput> = {}): KpiAssessmentInput {
	return {
		binding: {
			metricId: "ratio",
			comparator: "gte",
			target: { value: 1, unit: "ratio" },
		},
		metric: { unit: "ratio", maxAgeSeconds: 7200 },
		latestAttempt: fresh,
		lastGood: fresh,
		viewState: "ok",
		deadline: "2027-01-31T00:00:00Z",
		evaluation: null,
		daily: [],
		now: NOW,
		...over,
	};
}

describe("assessKpi first-match rules", () => {
	it("covers all ten statuses with enum reasons", () => {
		const cases: Array<[Partial<KpiAssessmentInput>, string, string | null]> = [
			[
				{ metric: null, unavailable: "calculator_unavailable" },
				"not_measured",
				"calculator_unavailable",
			],
			[
				{ deadline: "2026-11-02T11:00:00Z", evaluation: fresh },
				"evaluating",
				"evaluation_not_due",
			],
			[{ deadline: "2026-11-02T09:00:00Z", evaluation: fresh }, "met", null],
			[
				{
					deadline: "2026-11-02T09:00:00Z",
					evaluation: reading(0.5, "2026-11-02T08:00:00.000Z"),
				},
				"missed",
				null,
			],
			[
				{ deadline: "2026-11-02T09:00:00Z", evaluation: null },
				"unresolved",
				"no_reading_at_evaluation",
			],
			[
				{
					latestAttempt: {
						...reading(null, "2026-11-02T11:30:00.000Z", "unavailable"),
						reason: "insufficient_history",
					},
				},
				"building",
				"insufficient_history",
			],
			[
				{
					latestAttempt: reading(
						null,
						"2026-11-02T11:30:00.000Z",
						"unavailable",
					),
				},
				"failing",
				"zero_denominator",
			],
			[
				{
					latestAttempt: reading(2, "2026-11-02T08:00:00.000Z"),
					lastGood: reading(2, "2026-11-02T08:00:00.000Z"),
				},
				"delayed",
				null,
			],
			[{}, "on_track", null],
			[
				{
					latestAttempt: reading(0.4, "2026-11-02T11:00:00.000Z"),
					lastGood: reading(0.4, "2026-11-02T11:00:00.000Z"),
				},
				"behind",
				null,
			],
		];
		const seen = new Set<string>();
		for (const [over, status, reason] of cases) {
			const a = assessKpi(input(over));
			expect([a.status, a.reason]).toEqual([status, reason]);
			seen.add(a.status);
		}
		expect(seen.size).toBe(10);
	});
	it("does not treat a young series as building: a historical window is complete at its first reading", () => {
		expect(assessKpi(input()).status).toBe("on_track");
	});
	it("builds, not fails, while source history is younger than the window", () => {
		const young = {
			...reading(null, "2026-11-02T11:30:00.000Z", "unavailable"),
			reason: "insufficient_history",
		};
		expect(
			assessKpi(input({ latestAttempt: young, lastGood: null })),
		).toMatchObject({
			status: "building",
			reason: "insufficient_history",
			value: null,
			observationId: null,
		});
		const broken = { ...young, reason: "history_unavailable" };
		expect(
			assessKpi(input({ latestAttempt: broken, lastGood: null })),
		).toMatchObject({
			status: "failing",
			reason: "history_unavailable",
			value: null,
		});
	});
	it("keeps the last good value visible while failing and never reports zero for unknown", () => {
		const a = assessKpi(
			input({
				latestAttempt: reading(null, "2026-11-02T11:30:00.000Z", "error"),
			}),
		);
		expect(a).toMatchObject({
			status: "failing",
			value: 1.2,
			observationId: fresh.id,
		});
		const none = assessKpi(input({ latestAttempt: null, lastGood: null }));
		expect(none).toMatchObject({
			status: "delayed",
			value: null,
			reason: "metric_unavailable",
		});
		expect(assessKpi(input({ metric: null })).reason).toBe("no_binding");
	});
	it("refuses a unit mismatch instead of comparing", () => {
		expect(
			assessKpi(
				input({
					metric: { unit: "items", maxAgeSeconds: 60 },
				}),
			),
		).toMatchObject({ status: "not_measured", reason: "unit_mismatch" });
	});
	it("derives pace for display only; status never depends on the chart range", () => {
		const daily: MetricHistory["buckets"] = Array.from(
			{ length: 28 },
			(_, i) => {
				const start = Date.parse("2026-10-06T00:00:00Z") + i * DAY;
				return {
					start: new Date(start).toISOString(),
					end: new Date(start + DAY).toISOString(),
					status: i % 3 === 0 ? ("missing" as const) : ("ok" as const),
					value: i % 3 === 0 ? null : 0.5 + i * 0.01,
					observationId: null,
				};
			},
		);
		const withPace = assessKpi(input({ daily }));
		const without = assessKpi(input({ daily: [] }));
		const short = assessKpi(input({ daily: daily.slice(-5) }));
		expect(withPace.status).toBe(without.status);
		expect(short.status).toBe(without.status);
		expect(withPace.pace.observed).toBeCloseTo(0.07, 6);
		expect(without.pace.observed).toBeNull();
		expect(short.pace.observed).toBeNull();
		expect(withPace.pace.needed).toBeLessThan(0);
		expect(
			assessKpi(input({ deadline: "2026-11-02T09:00:00Z", evaluation: fresh }))
				.pace.needed,
		).toBeNull();
	});
});

describe("fixed evaluation selection", () => {
	it("looks only backward and becomes final", () => {
		const at = "2026-11-02T00:00:00.000Z";
		const before = reading(1, "2026-11-01T23:30:00.000Z");
		const later = reading(9, "2026-11-02T00:30:00.000Z");
		const tooOld = reading(3, "2026-11-01T22:00:00.000Z");
		const lateWrite = reading(
			4,
			"2026-11-01T23:50:00.000Z",
			"ok",
			"2026-11-02T02:00:00.000Z",
		);
		const failed = reading(null, "2026-11-01T23:55:00.000Z", "error");
		expect(
			selectEvaluation([later, before, tooOld, lateWrite, failed], at, 3600)
				?.id,
		).toBe(before.id);
		expect(selectEvaluation([later, tooOld], at, 3600)).toBeNull();
	});
});

describe("ranged history bucketing", () => {
	it("validates alignment, size and future ranges", () => {
		const now = new Date("2026-11-02T12:00:00Z");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-11-01T00:30:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1h",
				},
				now,
			),
		).toThrow("misaligned_range");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-10-28T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1w",
				},
				now,
			),
		).toThrow("misaligned_range");
		expect(
			metricHistoryRange(
				{
					from: "2026-10-19T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1w",
				},
				now,
			).starts,
		).toHaveLength(2);
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-01-01T00:00:00Z",
					to: "2026-11-02T00:00:00Z",
					step: "1h",
				},
				now,
			),
		).toThrow("too_many_buckets");
		expect(() =>
			metricHistoryRange(
				{
					from: "2026-11-02T00:00:00Z",
					to: "2026-11-03T00:00:00Z",
					step: "1d",
				},
				now,
			),
		).toThrow("invalid_range");
		expect(
			metricHistoryRange(
				{
					from: "2026-11-02T00:00:00Z",
					to: "2026-11-03T00:00:00Z",
					step: "1d",
				},
				now,
				{ allowOpenBucket: true },
			).starts,
		).toHaveLength(1);
	});
	it("keeps the last ok reading, half-open edges and real gaps", () => {
		const range = metricHistoryRange(
			{ from: "2026-11-01T00:00:00Z", to: "2026-11-01T04:00:00Z", step: "1h" },
			NOW,
		);
		const rows = [
			reading(1, "2026-11-01T00:10:00.000Z"),
			reading(2, "2026-11-01T00:50:00.000Z"),
			reading(null, "2026-11-01T00:55:00.000Z", "error"),
			reading(null, "2026-11-01T02:00:00.000Z", "unavailable"),
			reading(7, "2026-11-01T04:00:00.000Z"),
		];
		const buckets = bucketObservations(rows, range);
		expect(buckets.map((b) => [b.status, b.value])).toEqual([
			["ok", 2],
			["missing", null],
			["unavailable", null],
			["missing", null],
		]);
		expect(buckets[0]).toMatchObject({
			start: "2026-11-01T00:00:00.000Z",
			end: "2026-11-01T01:00:00.000Z",
		});
	});
});
