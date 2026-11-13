// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getConfig } from "@langchain/langgraph";

/** Native middleware uses the registered host reads and returns their actual receipts. */
export async function authorizedReadMessages(
	tools: readonly StructuredToolInterface[],
	requests: readonly { name: string; args: Record<string, unknown> }[],
) {
	if (!requests.length) return [];
	const prefix = `program-read-${randomUUID()}`;
	const calls = requests.map((request, i) => ({
		...request,
		id: `${prefix}-${i}`,
		type: "tool_call" as const,
	}));
	const config = getConfig();
	config.signal?.throwIfAborted();
	const results = await Promise.allSettled(
		calls.map(async (call) => {
			const tool = tools.find((tool) => tool.name === call.name);
			if (!tool) throw new Error(`program_read_unavailable:${call.name}`);
			return tool.invoke(call, config);
		}),
	);
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	return [
		new AIMessage({ content: "", tool_calls: calls }),
		...results.map((result, i) => {
			const call = calls[i];
			if (!call || result.status !== "fulfilled")
				throw new Error("program_read_result_missing");
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
		}),
	];
}
