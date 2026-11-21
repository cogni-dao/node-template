import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/observability", () => ({
	EVENT_NAMES: { ADAPTER_TAVILY_ERROR: "tavily.error" },
	makeLogger: () => ({ error() {} }),
}));

import { TavilyWebSearchAdapter } from "@/adapters/server/ai/tavily-web-search.adapter";

afterEach(() => vi.unstubAllGlobals());

describe("bounded research passages", () => {
	it("requests and returns the passage beyond a snippet", async () => {
		const raw = `${"x".repeat(200)} decisive evidence`;
		const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
			expect(JSON.parse(String(init.body)).include_raw_content).toBe(true);
			return Response.json({
				query: "q",
				results: [
					{
						title: "t",
						url: "https://example.org/",
						content: "snippet",
						raw_content: raw,
					},
				],
			});
		});
		vi.stubGlobal("fetch", fetcher);
		const result = await new TavilyWebSearchAdapter({ apiKey: "test" }).search({
			query: "q",
			includeRawContent: true,
		});
		expect(result.results[0]?.rawContent).toContain("decisive evidence");
		expect(result.results[0]?.rawContentState).toBe("available");
	});

	it("refuses an oversized streamed response without exposing its body", async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(1_048_577));
				controller.close();
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);
		await expect(
			new TavilyWebSearchAdapter({ apiKey: "test" }).search({ query: "q" }),
		).rejects.toThrow("web_search_response_too_large");
	});
});

describe("passage projection", () => {
	it("marks missing passages and bounds escaped Unicode while exposing excess results", async () => {
		const values = Array.from({ length: 6 }, (_, i) => ({
			title: "t",
			url: `https://example.org/${i}`,
			content: "s",
			raw_content: i ? '\\"😀'.repeat(10000) : null,
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ results: values })),
		);
		const result = await new TavilyWebSearchAdapter({ apiKey: "test" }).search({
			query: "q",
			includeRawContent: true,
		});
		expect(result.partial).toBe(true);
		expect(result.results).toHaveLength(5);
		expect(result.results[0]?.rawContentState).toBe("unavailable");
		expect(result.results[1]?.rawContentState).toBe("partial");
		expect(
			new TextEncoder().encode(JSON.stringify(result)).length,
		).toBeLessThanOrEqual(48 * 1024);
		expect(
			new TextEncoder().encode(JSON.stringify(result.results[1]?.rawContent))
				.length,
		).toBeLessThanOrEqual(8 * 1024);
		expect(result.results[1]?.rawContent).not.toMatch(/[\uD800-\uDBFF]$/);
	});
});

describe("provider failures", () => {
	it("does not expose a provider error body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("provider secret body", { status: 500 })),
		);
		const error = await new TavilyWebSearchAdapter({ apiKey: "test" })
			.search({ query: "q" })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toBe("Error: web_search_http_error");
	});
	it("keeps snippet-only defaults", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				expect(JSON.parse(String(init.body)).include_raw_content).toBe(false);
				return Response.json({
					results: [
						{
							title: "t",
							url: "https://example.org",
							content: "s",
							raw_content: "unexpected",
						},
					],
				});
			}),
		);
		const result = await new TavilyWebSearchAdapter({ apiKey: "test" }).search({
			query: "q",
		});
		expect(result.results[0]?.rawContentState).toBe("not_requested");
		expect(result.results[0]?.rawContent).toBeUndefined();
	});
});
