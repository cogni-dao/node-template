// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import type { ToolSpec } from "@cogni/ai-core";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { describe, expect, it, vi } from "vitest";
import type { CompletionFn } from "../../src/inproc";
import { createInProcGraphRunner } from "../../src/inproc";

const schema: ToolSpec["inputSchema"] = {
	type: "object",
	description: "Create a product",
	properties: {
		product: {
			type: "object",
			description: "Product details",
			properties: {
				name: {
					type: "string",
					description: "Product name",
					minLength: 2,
					maxLength: 40,
				},
				tags: {
					type: "array",
					description: "Product tags",
					minItems: 1,
					maxItems: 3,
					items: { type: "string", minLength: 2, maxLength: 12 },
				},
			},
			required: ["name", "tags"],
			additionalProperties: false,
		},
	},
	required: ["product"],
	additionalProperties: false,
};

const spec: ToolSpec = {
	name: "product__create",
	description: "Create a product",
	inputSchema: schema,
	effect: "external_side_effect",
	redaction: { mode: "top_level_only", allowlist: [] },
};

describe("product ToolSpec through the public runner", () => {
	it.each([true, false])(
		"preserves model schema and delegates allowed=%s",
		async (allowed) => {
			const args = { product: { name: "Widget", tags: ["sale"] } };
			const receipt = {
				code: "policy_denied",
				retryable: false as const,
				lookup: { scope: "product:create" },
			};
			const execute = vi.fn(async () =>
				allowed
					? { ok: true as const, value: { id: "p1" } }
					: {
							ok: false as const,
							errorCode: "policy_denied" as const,
							safeMessage: "Denied",
							receipt,
						},
			);
			const completions: Parameters<CompletionFn>[0][] = [];
			const completionFn: CompletionFn = (params) => {
				completions.push(params);
				const first = completions.length === 1;
				return {
					stream: (async function* () {})(),
					final: Promise.resolve(
						first
							? {
									ok: true,
									content: "",
									toolCalls: [
										{
											id: "call-1",
											type: "function",
											function: {
												name: spec.name,
												arguments: JSON.stringify(args),
											},
										},
									],
									finishReason: "tool_calls",
								}
							: { ok: true, content: "done", finishReason: "stop" },
					),
				};
			};
			const run = createInProcGraphRunner({
				createGraph: ({ llm, tools }) => createReactAgent({ llm, tools }),
				completionFn,
				createToolExecFn: () => execute,
				toolContracts: [],
				mcpToolSpecs: [spec],
				request: {
					runId: "schema-run",
					messages: [{ role: "user", content: "Create product" }],
					configurable: {
						model: "test-model",
						toolIds: [spec.name],
						actorId: "actor-1",
					},
				},
			});
			for await (const _event of run.stream) {
				/* drain */
			}
			expect((await run.final).ok).toBe(true);
			expect(completions[0]?.model).toBe("test-model");
			expect(completions[0]?.tools).toEqual([
				{
					type: "function",
					function: {
						name: spec.name,
						description: spec.description,
						parameters: schema,
					},
				},
			]);
			expect(execute).toHaveBeenCalledOnce();
			expect(execute).toHaveBeenCalledWith(spec.name, args, undefined);
			expect(
				completions[1]?.messages.find((message) => message.role === "tool")
					?.content,
			).toBe(
				allowed
					? JSON.stringify({ id: "p1" })
					: JSON.stringify({
							error: "policy_denied",
							message: "Denied",
							retryable: false,
							lookup: receipt.lookup,
						}),
			);
		},
	);
});
