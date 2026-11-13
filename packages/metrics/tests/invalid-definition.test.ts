// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** A stored definition this node cannot run is a 422, so one bad row never stops the refresh tick. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MetricError, MetricRegistry } from "../src/index";

const registry = new MetricRegistry();
registry.register({
	id: "work.count@1",
	unit: "items",
	paramsSchema: z.strictObject({ mode: z.literal("open") }),
	budget: { timeoutMs: 50, maxSourceCalls: 1, maxRows: 1, maxResponseBytes: 1000 },
	compute: async () => {
		throw new Error("never computed");
	},
});
const def = (spec: object) => ({ id: "m", title: "m", revision: "1", spec }) as never;
const status = (fn: () => void) => {
	try {
		fn();
		return "ok";
	} catch (e) {
		return e instanceof MetricError ? `${e.status} ${e.code}` : "unexpected";
	}
};

describe("registry.validate", () => {
	it("accepts a runnable definition", () => {
		expect(status(() => registry.validate(def({ calculatorId: "work.count@1", params: { mode: "open" }, maxAgeSeconds: 60 })))).toBe("ok");
	});
	it.each([
		["params the calculator no longer accepts", { calculatorId: "work.count@1", params: { measure: "edits" }, maxAgeSeconds: 60 }, "422 invalid_definition"],
		["an invalid core spec", { calculatorId: "work.count@1", params: {}, maxAgeSeconds: 0 }, "422 invalid_definition"],
		["an unknown calculator", { calculatorId: "brief.conformance@1", params: {}, maxAgeSeconds: 60 }, "422 unknown_calculator"],
	])("rejects %s with a MetricError 422", (_n, spec, expected) => {
		expect(status(() => registry.validate(def(spec)))).toBe(expected);
	});
});
