// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
	createStaticToolSourceFromRecord,
	createToolAllowlistPolicy,
	createToolRunner,
} from "@cogni/ai-core";
import {
	createWebSearchImplementation,
	toBoundToolRuntime,
	webSearchContract,
} from "@cogni/ai-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cogni/ai-tools", async () => ({
	...(await import("../../../../packages/ai-tools/src/tools/web-search")),
	...(await import("../../../../packages/ai-tools/src/runtime-adapter")),
	...(await import(
		"../../../../packages/ai-tools/src/capabilities/web-search-projection"
	)),
}));

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock("@/shared/observability", () => ({
	EVENT_NAMES: { ADAPTER_TAVILY_ERROR: "tavily.error" },
	makeLogger: () => ({ error: (...args: unknown[]) => logs.push(args) }),
}));

import { createWebSearchCapability } from "@/bootstrap/capabilities/web-search";
import { type ServerEnv, serverSchema } from "@/shared/env/server-env";

const nodeKey = "synthetic-node-credential";
const legacyKey = "synthetic-legacy-credential";
const marker = "private-marker-439";
const env = (values: Record<string, unknown>): ServerEnv =>
	({ isTestMode: false, ...values }) as ServerEnv;

async function run(capability: ReturnType<typeof createWebSearchCapability>) {
	const events: unknown[] = [];
	const tool = toBoundToolRuntime({
		contract: webSearchContract,
		implementation: createWebSearchImplementation({
			webSearchCapability: capability,
		}),
	});
	const runner = createToolRunner(
		createStaticToolSourceFromRecord({ core__web_search: tool }),
		(event) => events.push(event),
		{
			policy: createToolAllowlistPolicy(["core__web_search"]),
			ctx: { runId: "test-run" },
		},
	);
	const result = await runner.exec("core__web_search", { query: "example" });
	return { result, events };
}

afterEach(() => {
	vi.unstubAllGlobals();
	logs.length = 0;
});

describe("node web search authentication", () => {
	it("accepts only the node input in the typed schema and selects it for the real adapter", async () => {
		const parsed = serverSchema
			.pick({ NODE_TAVILY_API_KEY: true })
			.parse({ NODE_TAVILY_API_KEY: nodeKey, TAVILY_API_KEY: legacyKey });
		expect(parsed).toEqual({ NODE_TAVILY_API_KEY: nodeKey });
		const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
			expect(JSON.parse(String(init.body)).api_key).toBe(nodeKey);
			return Response.json({
				results: [
					{ title: "Title", url: "https://example.org/", content: "Snippet" },
				],
			});
		});
		vi.stubGlobal("fetch", fetcher);
		const result = await createWebSearchCapability(
			env({ ...parsed, TAVILY_API_KEY: legacyKey }),
		).search({ query: "example" });
		expect(result).toMatchObject({
			query: "example",
			partial: false,
			results: [{ title: "Title", content: "Snippet" }],
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("refuses missing and legacy-only input, while test mode remains fake", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		for (const values of [{}, { TAVILY_API_KEY: legacyKey }]) {
			await expect(
				createWebSearchCapability(env(values)).search({ query: "example" }),
			).rejects.toThrow(
				"WebSearchCapability not configured. Set NODE_TAVILY_API_KEY environment variable.",
			);
		}
		expect(
			(
				await createWebSearchCapability(
					env({ isTestMode: true, NODE_TAVILY_API_KEY: nodeKey }),
				).search({ query: "example" })
			).results[0]?.title,
		).toBe('Mock Result 1 for "example"');
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(["transport", "stream", "auth", "quota"])(
		"normalizes %s failure before the runner without fallback or leaks",
		async (failure) => {
			const privateError = new Error(`web_search_${marker}_${nodeKey}`);
			const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
				expect(JSON.parse(String(init.body)).api_key).toBe(nodeKey);
				if (failure === "transport") throw privateError;
				if (failure === "stream")
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(privateError);
							},
						}),
					);
				return new Response("denied", {
					status: failure === "auth" ? 401 : 429,
				});
			});
			vi.stubGlobal("fetch", fetcher);
			const capability = createWebSearchCapability(
				env({ NODE_TAVILY_API_KEY: nodeKey, TAVILY_API_KEY: legacyKey }),
			);
			const { result, events } = await run(capability);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(result).toEqual({
				ok: false,
				errorCode: "execution",
				safeMessage: "web_search_unavailable",
			});
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "tool_call_result",
					result: { error: "web_search_unavailable" },
					isError: true,
				}),
			);
			const visible = JSON.stringify({ result, events, logs });
			expect(visible).not.toContain(marker);
			expect(visible).not.toContain(nodeKey);
			expect(visible).not.toContain(legacyKey);
		},
	);
});
