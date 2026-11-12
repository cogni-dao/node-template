// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getConfig } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import { REQUIRED_GUIDANCE_IDS } from "./prompts";

/** Fixed prerequisites use native state and the same authorized, instrumented read tools. */
export function createTriagePreflight(
	tools: readonly StructuredToolInterface[],
) {
	return createMiddleware({
		name: "TriageReadPreflight",
		beforeAgent: async () => {
			const prefix = `triage-preflight-${randomUUID()}`;
			const requests = [
				...REQUIRED_GUIDANCE_IDS.map((id) => ({
					name: "core__knowledge_read",
					args: { id },
				})),
				{ name: "core__goal_list", args: {} },
				{ name: "core__goal_progress", args: { history: "none" } },
			].map((request, i) => ({
				...request,
				id: `${prefix}-${i}`,
				type: "tool_call" as const,
			}));
			const config = getConfig();
			config.signal?.throwIfAborted();
			const results = await Promise.allSettled(
				requests.map(async (call) => {
					const tool = tools.find((tool) => tool.name === call.name);
					if (!tool)
						throw new Error(`triage_preflight_read_unavailable:${call.name}`);
					return tool.invoke(call, config);
				}),
			);
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			const messages = results.map((result, i) => {
				const call = requests[i];
				if (!call) throw new Error("triage_preflight_result_missing");
				if (result.status !== "fulfilled")
					throw new Error("triage_preflight_result_missing");
				return result.value instanceof ToolMessage
					? result.value
					: new ToolMessage({
							name: call.name,
							tool_call_id: call.id,
							content:
								typeof result.value === "string"
									? result.value
									: JSON.stringify(result.value),
						});
			});
			return {
				messages: [
					new AIMessage({ content: "", tool_calls: requests }),
					...messages,
				],
			};
		},
	});
}
