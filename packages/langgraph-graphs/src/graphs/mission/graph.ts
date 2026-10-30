// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/mission/graph`
 * Purpose: Generic mission-engine graph factory — prompt-driven via catalog config.
 * Scope: Creates LangGraph React agent with systemPrompt from catalog. Does NOT hardcode any prompt.
 * Invariants:
 *   - FACTORY_SEAM: Wraps createReactAgent — LangChain v1 migration is a single-file change
 *   - SYSTEM_PROMPT_REQUIRED: Throws if systemPrompt not provided
 *   - Pure factory function — no side effects, no env reads
 * Side-effects: none
 * Links: agent-roles spec
 * @public
 */

import { WORK_ITEM_TRANSITION_NAME } from "@cogni/ai-tools";
import { MessagesAnnotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { CreateReactAgentGraphOptions } from "../types";
import { cogniProfile, createCogniProgram } from "./cogni";
import { COGNI_READ_PROMPT } from "./cogni-read";
import { createScoresGuard } from "./score-guard";

/**
 * Graph name constants for mission-engine roles.
 */
export const OPERATING_REVIEW_GRAPH_NAME = "operating-review" as const;
export const GIT_REVIEWER_GRAPH_NAME = "git-reviewer" as const;

/**
 * Create a mission-engine graph with a catalog-driven system prompt.
 *
 * This is the factory seam for all mission-engine roles. It wraps createReactAgent
 * so the LangChain v1 migration (createAgent replaces createReactAgent) is
 * a single-file change here.
 *
 * @param opts - Options with LLM, tools, and systemPrompt (required)
 * @returns Compiled LangGraph ready for invoke()
 * @throws Error if systemPrompt is not provided
 */
export function createMissionGraph(opts: CreateReactAgentGraphOptions) {
	// Behavior mode is the program: READ (chat) answers and files nothing; the scheduled programs
	// DECIDE. The read topology has no write tool bound at all.
	if (opts.program) {
		const readToolIds = opts.tools
			.map((tool) => tool.name)
			.filter((name) => name !== WORK_ITEM_TRANSITION_NAME);
		const child = createCogniProgram({
			...opts,
			disableCheckpointer: true,
			profile: cogniProfile({
				id: "general-purpose",
				instructions:
					"Read the requested node evidence and return a concise sourced result. Do not write.",
				modelTier: "flash",
				toolIds: readToolIds,
				allowedChildProfiles: [],
				outputPolicy: "answer",
			}),
			children: [],
		}).withConfig({ recursionLimit: 30 });
		const ledgerReader = createCogniProgram({
			...opts,
			disableCheckpointer: true,
			profile: cogniProfile({
				id: "ledger-reader",
				instructions:
					"Read the goals and work ledger requested in the task. Cite observed sources; never write.",
				modelTier: "flash",
				toolIds: [
					"core__goal_list",
					"core__work_item_query",
					"core__work_item_read",
					"core__knowledge_read",
					"core__get_current_time",
				],
				allowedChildProfiles: [],
				outputPolicy: "answer",
			}),
			children: [],
		}).withConfig({ recursionLimit: 30 });
		const deciding =
			(opts.program === "cogni-decide" || opts.program === "work-review") &&
			opts.requestIntent === "decide";
		const writer = opts.tools.find(
			(tool) => tool.name === WORK_ITEM_TRANSITION_NAME,
		);
		const requiredGuidanceIds = deciding
			? [
					"dao-goals-design",
					"program-behavior-mode",
					"work-item-scores-design",
					"mission-loop-expert",
				]
			: [];
		const profile = cogniProfile({
			id: opts.program,
			instructions: `${opts.systemPrompt ?? COGNI_READ_PROMPT}${deciding ? `\nBefore a scores write, read each exact guidance id: ${requiredGuidanceIds.join(", ")}. Read each item completely and cite actual observed source URLs.` : ""}`,
			modelTier: "main",
			toolIds: readToolIds,
			allowedChildProfiles: ["general-purpose", "ledger-reader"],
			outputPolicy: deciding ? "scores" : "answer",
			requiredGuidanceIds,
		});
		const guardedTools =
			deciding && opts.receipts && writer
				? [
						createScoresGuard(
							opts.receipts,
							writer,
							profile.requiredGuidanceIds,
						),
					]
				: [];
		return createCogniProgram({
			...opts,
			guardedTools,
			profile,
			children: [
				{
					name: "general-purpose",
					description: "Read relevant node evidence for the assigned task.",
					runnable: child,
					mode: "isolated",
				},
				{
					name: "ledger-reader",
					description: "Read and summarize the goal and work ledger.",
					runnable: ledgerReader,
					mode: "isolated",
				},
			],
		});
	}
	if (!opts.systemPrompt) {
		throw new Error(
			"createMissionGraph requires systemPrompt — mission graphs are prompt-driven via catalog",
		);
	}

	// Use 'prompt' (not deprecated 'messageModifier') — LangGraph converts string to SystemMessage
	return createReactAgent({
		llm: opts.llm,
		tools: [...opts.tools],
		prompt: opts.systemPrompt,
		stateSchema: MessagesAnnotation,
	});
}
