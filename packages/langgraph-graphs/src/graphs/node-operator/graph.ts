import { SCHEDULE_LIST_NAME, SCHEDULE_MANAGE_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { COGNI_TOOL_IDS } from "../cogni/tools";
import type { CreateReactAgentGraphOptions } from "../types";
import { NODE_OPERATOR_PROMPT } from "./prompts";

export const NODE_OPERATOR_TOOL_IDS = [
	...COGNI_TOOL_IDS,
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
] as const;

/**
 * A minimal operating program on the existing billed harness. Chat and schedules share one
 * tool set; host capabilities authorize the run actor. Cogni coordinates registered programs;
 * domain writes such as scoring belong to those programs, not to the coordinator.
 */
export function createNodeOperatorGraph(opts: CreateReactAgentGraphOptions) {
	return createCogniProgram({
		...opts,
		profile: cogniProfile({
			id: "cogni",
			instructions: opts.systemPrompt ?? NODE_OPERATOR_PROMPT,
			modelTier: "main",
			toolIds: opts.tools.map((tool) => tool.name),
			skillIds: (opts.sourceContext?.governingIndex ?? []).map(
				(entry) => entry.id,
			),
			allowedChildProfiles: [],
		}),
	});
}
