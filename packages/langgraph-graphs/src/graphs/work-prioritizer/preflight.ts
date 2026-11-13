// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { isToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { authorizedReadMessages } from "../cogni/authorized-read-messages";
import { hasKnowledgeBody } from "./completion";
import { REQUIRED_GUIDANCE_IDS } from "./prompts";
import { OPEN_STATUSES, WORK_ITEM_QUERY_MAX_LIMIT } from "./tools";

/** Required guides whose preflight read returned no complete body. */
export function missingRequiredGuidance(
	messages: readonly unknown[],
): string[] {
	const present = new Set<string>();
	for (const message of messages) {
		if (!isToolMessage(message as never)) continue;
		const tool = message as { name?: string; content: unknown };
		if (tool.name !== "core__knowledge_read" || typeof tool.content !== "string")
			continue;
		let value: unknown;
		try {
			value = JSON.parse(tool.content);
		} catch {
			continue;
		}
		for (const id of REQUIRED_GUIDANCE_IDS)
			if (hasKnowledgeBody(value, id)) present.add(id);
	}
	return REQUIRED_GUIDANCE_IDS.filter((id) => !present.has(id));
}

/** Fixed prerequisites use native state and the same authorized, instrumented read tools.
 * A missing required guide ends the run before any model call: writes would be refused anyway. */
export function createTriagePreflight(
	tools: readonly StructuredToolInterface[],
) {
	return createMiddleware({
		name: "TriageReadPreflight",
		beforeAgent: {
			canJumpTo: ["end"],
			hook: async () => {
				const messages = await authorizedReadMessages(tools, [
					...REQUIRED_GUIDANCE_IDS.map((id) => ({
						name: "core__knowledge_read",
						args: { id },
					})),
					{ name: "core__goal_list", args: {} },
					{ name: "core__goal_progress", args: { history: "none" } },
					{
						name: "core__work_item_query",
						args: {
							statuses: ["needs_triage"],
							limit: WORK_ITEM_QUERY_MAX_LIMIT,
							sortBy: "createdAt",
							sortDirection: "desc",
						},
					},
					{
						name: "core__work_item_query",
						args: {
							statuses: [...OPEN_STATUSES],
							scored: false,
							limit: WORK_ITEM_QUERY_MAX_LIMIT,
							sortBy: "createdAt",
							sortDirection: "desc",
						},
					},
				]);
				return missingRequiredGuidance(messages).length
					? { messages, jumpTo: "end" as const }
					: { messages };
			},
		},
	});
}
