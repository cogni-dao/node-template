// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it, vi } from "vitest";
import { createFleetTrainLagCalculator } from "../src/fleet-train-lag.js";

const params = {
	publisher: "cogni-dao/node-template",
	members: [{ name: "@cogni-dao/metrics", tagPrefix: "metrics-v" }],
	consumers: [{ repo: "cogni-dao/cogni", manifestPath: "app/package.json" }],
	graceHours: 24,
};

describe("public fleet calculator", () => {
	it("does not let an official alias mask a foreign canonical pin", async () => {
		const calculator = createFleetTrainLagCalculator();
		const official = "https://github.com/cogni-dao/node-template/releases/download/metrics-v0.25.0/metrics.tgz";
		const foreign = "https://github.com/other/fork/releases/download/metrics-v0.1.0/metrics.tgz";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const address = String(input);
			const body = address.includes("matching-refs")
				? [{ ref: "refs/tags/train-v0.25.0" }]
				: address.includes("releases/tags/")
					? { tag_name: "metrics-v0.25.0", published_at: "2026-11-20T00:00:00Z" }
					: { dependencies: { "@cogni/metrics": official, "@cogni-dao/metrics": foreign } };
			return new Response(JSON.stringify(body));
		});
		const controller = new AbortController();
		try {
			const result = await calculator.compute(params, {
				window: { start: "2026-11-21T00:00:00.000Z", end: "2026-11-22T00:00:00.000Z" },
				signal: controller.signal,
				budget: calculator.budget,
				read: async (source) => source(controller.signal, calculator.budget),
			});
			expect(result).toMatchObject({ complete: true, value: 1 });
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("owns the existing descriptor and strictly validates its parameters", () => {
		const calculator = createFleetTrainLagCalculator();
		expect(calculator).toMatchObject({
			id: "fleet.train-lag@1",
			unit: "nodes",
			display: "volume",
			budget: {
				timeoutMs: 30000,
				maxSourceCalls: 1,
				maxRows: 100,
				maxResponseBytes: 1_048_576,
			},
		});
		expect(calculator.paramsSchema.safeParse(params).success).toBe(true);
		expect(
			calculator.paramsSchema.safeParse({ ...params, unexpected: true })
				.success,
		).toBe(false);
		expect(
			calculator.paramsSchema.safeParse({ ...params, graceHours: -1 }).success,
		).toBe(false);
		expect(
			calculator.paramsSchema.safeParse({
				...params,
				consumers: [{ ...params.consumers[0], extra: true }],
			}).success,
		).toBe(false);
	});
});

it("registers the same factory in the reference engine and rejects collisions", async () => {
	const factoryModule = await import("../src/fleet-train-lag.js");
	const factory = createFleetTrainLagCalculator();
	const spy = vi
		.spyOn(factoryModule, "createFleetTrainLagCalculator")
		.mockReturnValue(factory);
	const { createGoalMetrics } = await import("../src/knowledge.js");
	const sql = {} as import("postgres").Sql;
	const deps = {
		knowledgeSql: sql,
		observationsSql: sql,
		node: "test",
		environment: "test",
		log: () => undefined,
	};
	const registered = createGoalMetrics(deps).registry.get(factory.id);
	expect(registered).toBe(factory);
	expect(spy).toHaveBeenCalled();
	expect(() =>
		createGoalMetrics({ ...deps, nodeCalculators: [factory] }),
	).toThrow(expect.objectContaining({ code: "reserved_calculator_family" }));
	const local = { ...factory, id: "example.fleet@1" };
	expect(() =>
		createGoalMetrics({ ...deps, nodeCalculators: [local, local] }),
	).toThrow(expect.objectContaining({ code: "duplicate_calculator" }));
});

it("uses the engine read boundary and reports an unavailable source", async () => {
	const calculator = createFleetTrainLagCalculator();
	const controller = new AbortController();
	const fetchMock = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("unavailable"));
	const read = vi.fn(
		async <T>(
			source: (
				signal: AbortSignal,
				budget: typeof calculator.budget,
			) => Promise<T>,
		) => source(controller.signal, calculator.budget),
	);
	try {
		const result = await calculator.compute(params, {
			window: {
				start: "2026-11-21T00:00:00.000Z",
				end: "2026-11-22T00:00:00.000Z",
			},
			signal: controller.signal,
			budget: calculator.budget,
			read,
		});
		expect(read).toHaveBeenCalledTimes(1);
		expect(result.complete).toBe(false);
		expect(result.reason).toBe("source_failed");
	} finally {
		fetchMock.mockRestore();
	}
});
