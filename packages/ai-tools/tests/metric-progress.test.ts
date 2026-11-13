// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import { createMetricTools } from "../src/tools/metric";

describe("goal progress tool value bounds", () => {
	it("defaults to explicit history=none and still permits full chart reads", async () => {
		const source = {
			goals: [],
			asOf: "2026-11-12T00:00:00.000Z",
			environment: "local",
			servedUnavailable: "source_failed",
		};
		const goalProgress = vi.fn(async () => source);
		const tool = createMetricTools(() => undefined, {
			goalProgress,
		}).tools.find((t) => t.contract.name === "core__goal_progress");
		if (!tool) throw new Error("goal-progress tool missing");
		expect(await tool.implementation.execute({})).toEqual({
			...source,
			historyMode: "none",
		});
		expect(await tool.implementation.execute({ history: "full" })).toEqual({
			...source,
			historyMode: "full",
		});
		expect(goalProgress).toHaveBeenCalledTimes(2);
	});
});
