// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/poet/graph`
 * Purpose: Poetic AI assistant graph factory.
 * Scope: Creates LangGraph React agent with injected LLM and tools. Does NOT execute graphs or read env.
 * Invariants:
 *   - Pure factory function — no side effects, no env reads
 *   - LLM and tools are injected, not instantiated
 *   - TYPE_TRANSPARENT_RETURN: No explicit return type annotation to preserve CompiledStateGraph for CLI schema extraction
 * Side-effects: none
 * Links: LANGGRAPH_AI.md, AGENT_DEVELOPMENT_GUIDE.md
 * @public
 */

import { cogniProfile, createCogniProgram } from "../mission/cogni";
import type { CreateReactAgentGraphOptions } from "../types";
import { POET_SYSTEM_PROMPT } from "./prompts";

/**
 * Graph name constant for routing.
 */
export const POET_GRAPH_NAME = "poet" as const;

/**
 * Create a poetic AI assistant graph.
 *
 * This is the simplest possible LangGraph agent:
 * - Uses createReactAgent (prebuilt pattern)
 * - LLM handles tool calling decisions
 * - Agent loops until no more tool calls needed
 *
 * NOTE: Return type is intentionally NOT annotated to preserve the concrete
 * CompiledStateGraph type for LangGraph CLI schema extraction.
 *
 * @param opts - Options with LLM and tools
 * @returns Compiled LangGraph ready for invoke()
 *
 * @example
 * ```typescript
 * const llm = new CogniCompletionAdapter();
 * const tools = toLangChainTools({ contracts, exec: toolRunner.exec });
 * const graph = createPoetGraph({ llm, tools });
 *
 * const result = await graph.invoke({
 *   messages: [new HumanMessage("What time is it?")]
 * });
 * ```
 */
export function createPoetGraph(opts: CreateReactAgentGraphOptions) {
	const child = createCogniProgram({
		...opts,
		disableCheckpointer: true,
		profile: cogniProfile({
			id: "general-purpose",
			instructions:
				"Complete the delegated creative task using only available read tools.",
			modelTier: "flash",
			toolIds: ["core__get_current_time"],
			allowedChildProfiles: [],
			outputPolicy: "answer",
		}),
		children: [],
	}).withConfig({ recursionLimit: 30 });
	return createCogniProgram({
		...opts,
		profile: cogniProfile({
			id: "poet",
			instructions: POET_SYSTEM_PROMPT,
			modelTier: "main",
			toolIds: ["core__get_current_time"],
			allowedChildProfiles: ["general-purpose"],
			outputPolicy: "answer",
		}),
		children: [
			{
				name: "general-purpose",
				description: "Complete an independent creative subtask.",
				runnable: child,
				mode: "isolated",
			},
		],
	});
}
