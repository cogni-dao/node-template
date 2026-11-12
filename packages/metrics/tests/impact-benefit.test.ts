// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it } from "vitest";
import { expectedKpiBenefit } from "../src/assess";

describe("expected KPI benefit", () => {
	it("preserves beneficial, neutral and adverse inequality effects beyond the target", () => {
		for (const [withValue, gte, lte] of [
			[99, 4, -4],
			[95, 0, 0],
			[91, -4, 4],
		] as const) {
			expect(
				expectedKpiBenefit({
					comparator: "gte",
					target: 90,
					without: 95,
					with: withValue,
				}),
			).toBe(gte);
			expect(
				expectedKpiBenefit({
					comparator: "lte",
					target: 90,
					without: 95,
					with: withValue,
				}),
			).toBe(lte);
		}
	});
	it("measures equality by distance and handles overshoot", () => {
		expect(
			[99, 95, 91].map((withValue) =>
				expectedKpiBenefit({
					comparator: "eq",
					target: 94,
					without: 95,
					with: withValue,
				}),
			),
		).toEqual([-4, 0, -2]);
	});
	it("does not turn unknown, nonfinite or overflowing inputs into a number", () => {
		for (const withValue of [null, NaN, Infinity, -Number.MAX_VALUE]) {
			expect(
				expectedKpiBenefit({
					comparator: "gte",
					target: 90,
					without: Number.MAX_VALUE,
					with: withValue,
				}),
			).toBeNull();
		}
	});
});
