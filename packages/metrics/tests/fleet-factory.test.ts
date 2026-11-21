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
	it.each(["dependencies", "devDependencies"] as const)("retains invalid Release aliases in %s beside five current pins", async (section) => {
		const calculator = createFleetTrainLagCalculator();
		const members = ["work-items", "knowledge-store", "knowledge-base-ui", "metrics", "ai-tools"].map((name) => ({ name: `@cogni-dao/${name}`, tagPrefix: `${name}-v` }));
		const consumers = Array.from({ length: 6 }, (_, i) => ({ repo: `cogni-dao/consumer${i}`, manifestPath: "package.json" }));
		const official = Object.fromEntries(members.map((m) => [m.name, `https://github.com/cogni-dao/node-template/releases/download/${m.tagPrefix}0.25.0/x.tgz`]));
		let bad: string | undefined;
		const calls: string[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const address = String(input);
			calls.push(address);
			expect(["https://api.github.com", "https://raw.githubusercontent.com"]).toContain(new URL(address).origin);
			const tag = /releases\/tags\/(.+)$/.exec(address)?.[1];
			const body = address.includes("matching-refs") ? [{ ref: "refs/tags/train-v0.25.0" }]
				: tag ? { tag_name: decodeURIComponent(tag), published_at: "2026-11-20T00:00:00Z" }
				: { dependencies: { ...official, ...(section === "dependencies" && bad && address.includes("consumer0/") ? { "old-metrics": bad } : {}) }, devDependencies: section === "devDependencies" && bad && address.includes("consumer0/") ? { "old-metrics": bad } : {} };
			return new Response(JSON.stringify(body));
		});
		const controller = new AbortController();
		const compute = async () => {
			calls.length = 0;
			const result = await calculator.compute({ ...params, members, consumers }, {
				window: { start: "2026-11-21T00:00:00.000Z", end: "2026-11-22T00:00:00.000Z" },
				signal: controller.signal, budget: calculator.budget, read: async (source) => source(controller.signal, calculator.budget),
			});
			expect(calls.filter((address) => address.startsWith("https://api.github.com/"))).toHaveLength(6);
			expect(calls.filter((address) => address.startsWith("https://raw.githubusercontent.com/"))).toHaveLength(6);
			return result;
		};
		try {
			expect(await compute()).toMatchObject({ complete: true, value: 0 });
			for (bad of [
				"https://github.com.evil.test/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"http://github.com/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://foreign.example/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://user@github.com/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://[invalid/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://github.com/cogni-dao/node-template/releases/download/metrics-v0.1.0/",
				"https://github.com/cogni-dao/node-template/releases/download/metrics-v0.1.0%2Fbad/x.tgz",
				"https://github.com/outsider/temporary/../node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://foreign.example/cogni-dao/staging/%2E%2e/node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://github.com.evil.test/cogni-dao/node-template/tmp/../releases/download/metrics-v0.1.0/x.tgz",
				"https:\\github.com\\outsider\\removed\\..\\node-template\\releases\\download\\metrics-v0.1.0\\x.tgz",
				" \tHTTPS://FOREIGN.EXAMPLE/cogni-dao/node-template/releases/download/metrics-v0.1.0/x.tgz\r\n",
				"http://github.com/cogni-dao/deleted/%2e./node-template/releases/download/metrics-v0.1.0/x.tgz",
				"https://user:secret@github.com/cogni-dao/node-template/./releases/download/metrics-v0.1.0/x.tgz",
				"https://[invalid/cogni-dao/node-template/releases/download/metrics-v0.1.0%broken/x.tgz",
			]) {
				const result = await compute();
				expect(result, bad).toMatchObject({ complete: true, value: 1 });
				expect(result.evidenceRefs).toContain("fleet:train-lag:counts:evaluated=6;lagging=1;train=0.25.0");
			}
			for (const normalized of [
				"https://github.com/cogni-dao/staging/../node-template/releases/download/metrics-vVERSION/x.tgz",
				"https://github.com/cogni-dao/node-template/removed/%2e%2E/releases/download/metrics-vVERSION/x.tgz",
				"https:\\github.com\\cogni-dao\\node-template\\releases\\download\\metrics-vVERSION\\x.tgz",
				"\tHTTPS://GITHUB.COM/cogni-dao/node-template/./releases/download/metrics-vVERSION/x.tgz\n",
			]) {
				bad = normalized.replace("VERSION", "0.1.0");
				const old = await compute();
				expect(old, bad).toMatchObject({ complete: true, value: 1 });
				expect(old.evidenceRefs).toContain("fleet:train-lag:lagging=cogni-dao/consumer0:behind:old-metrics@0.1.0");
				bad = normalized.replace("VERSION", "0.25.0");
				expect(await compute(), bad).toMatchObject({ complete: true, value: 0 });
			}
		} finally { fetchMock.mockRestore(); }
	});
	it.each([false, true])("selects the first mature train through the factory (two young trains: %s)", async (twoYoung) => {
		const calculator = createFleetTrainLagCalculator();
		const members = ["work-items", "knowledge-store", "knowledge-base-ui", "metrics", "ai-tools"].map((name) => ({ name: `@cogni-dao/${name}`, tagPrefix: `${name}-v` }));
		const consumers = Array.from({ length: 6 }, (_, i) => ({ repo: `cogni-dao/consumer${i}`, manifestPath: "package.json" }));
		const calls: string[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const address = String(input);
			calls.push(address);
			const tag = /releases\/tags\/(.+)$/.exec(address)?.[1];
			const body = address.includes("matching-refs") ? ["0.24.0", "0.26.0", "0.25.0"].map((v) => ({ ref: `refs/tags/train-v${v}` }))
				: tag ? { tag_name: decodeURIComponent(tag), published_at: twoYoung && !tag.endsWith("0.24.0") ? "2026-11-21T00:00:00.001Z" : "2026-11-21T00:00:00.000Z" }
				: { dependencies: Object.fromEntries(members.map((m) => [m.name, `https://github.com/cogni-dao/node-template/releases/download/${m.tagPrefix}0.26.0/x.tgz`])), devDependencies: { "@cogni/metrics": "workspace:*" } };
			return new Response(JSON.stringify(body));
		});
		const controller = new AbortController();
		try {
			const result = await calculator.compute({ ...params, members, consumers }, {
				window: { start: "2026-11-21T00:00:00.000Z", end: "2026-11-22T00:00:00.000Z" },
				signal: controller.signal, budget: calculator.budget, read: async (source) => source(controller.signal, calculator.budget),
			});
			expect(result).toMatchObject({ complete: true, value: 0 });
			expect(result.evidenceRefs).toContain(`fleet:train-lag:counts:evaluated=6;lagging=0;train=${twoYoung ? "0.24.0" : "0.26.0"}`);
			expect(calls.filter((address) => address.startsWith("https://api.github.com/"))).toHaveLength(twoYoung ? 8 : 6);
			expect(calls.filter((address) => address.startsWith("https://raw.githubusercontent.com/"))).toHaveLength(6);
			if (!twoYoung) expect(calls.some((address) => /releases\/tags\/.*0\.(24|25)\.0/.test(address))).toBe(false);
		} finally { fetchMock.mockRestore(); }
	});
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
