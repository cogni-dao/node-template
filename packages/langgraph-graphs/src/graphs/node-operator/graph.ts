import {
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
	WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { COGNI_TOOL_IDS } from "../cogni/tools";
import type { CreateReactAgentGraphOptions } from "../types";
import { createPrioritizerRunHooks } from "../work-prioritizer/graph";
import { REQUIRED_GUIDANCE_IDS } from "../work-prioritizer/prompts";
import type { RunReceipts } from "../work-prioritizer/receipts";
import { createScoresGuard } from "../work-prioritizer/score-guard";
import { NODE_OPERATOR_PROMPT } from "./prompts";

export const NODE_OPERATOR_TOOL_IDS = [
	...COGNI_TOOL_IDS,
	WORK_ITEM_TRANSITION_NAME,
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
] as const;

/**
 * A minimal operating program on the existing billed harness. Chat and schedules share one
 * tool set; host capabilities authorize the run actor. The raw work-item writer is never exposed:
 * only the prioritizer's scores-only guard reaches it.
 */
export function createNodeOperatorGraph(opts: CreateReactAgentGraphOptions) {
	const receipts = opts.programState as RunReceipts | undefined;
	const writer = opts.tools.find(
		(tool) => tool.name === WORK_ITEM_TRANSITION_NAME,
	);
	const toolIds = opts.tools
		.map((tool) => tool.name)
		.filter((name) => name !== WORK_ITEM_TRANSITION_NAME);
	return createCogniProgram({
		...opts,
		guardedTools:
			receipts && writer
				? [createScoresGuard(receipts, writer, REQUIRED_GUIDANCE_IDS)]
				: [],
		profile: cogniProfile({
			id: "cogni",
			instructions: opts.systemPrompt ?? NODE_OPERATOR_PROMPT,
			modelTier: "main",
			toolIds,
			skillIds: (opts.sourceContext?.governingIndex ?? []).map(
				(entry) => entry.id,
			),
			allowedChildProfiles: [],
		}),
	});
}
createNodeOperatorGraph.createRunHooks = createPrioritizerRunHooks;
