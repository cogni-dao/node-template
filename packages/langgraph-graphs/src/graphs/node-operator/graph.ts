import { ACCOUNT_CREDITS_READ_NAME, SCHEDULE_LIST_NAME, SCHEDULE_MANAGE_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { COGNI_TOOL_IDS } from "../cogni/tools";
import type { CreateReactAgentGraphOptions } from "../types";
import { NODE_OPERATOR_PROMPT } from "./prompts";
import {
	createNodeScheduleGuard,
	createWorkflowGuidancePreflight,
	NodeOperatorReceipts,
	type WorkflowGuidance,
} from "./guidance";

/**
 * Cogni's reads plus schedule management; its only write is arranging jobs. `core__account_credits_read` is a read that opens only after the
 * account owner turns "this node's AI" On for their account (task.5465, an `account` grant on the run's account); until then the run-start filter
 * withholds it, so listing it here changes nothing for a person who has not said yes.
 */
export const NODE_OPERATOR_TOOL_IDS: readonly string[] = [
	...COGNI_TOOL_IDS.filter((id) => id !== "core__metric_compute"),
	ACCOUNT_CREDITS_READ_NAME,
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
];

/**
 * A minimal operating program on the existing billed harness. Chat and schedules share one
 * tool set; host capabilities authorize the run actor. Cogni coordinates registered programs;
 * domain writes such as scoring belong to those programs, not to the coordinator.
 */
export function createNodeOperatorGraph(
	opts: CreateReactAgentGraphOptions & {
		readonly workflowGuidance?: readonly WorkflowGuidance[];
	},
) {
	const receipts =
		opts.programState instanceof NodeOperatorReceipts
			? opts.programState
			: new NodeOperatorReceipts();
	const workflows = opts.workflowGuidance ?? [];
	const writer = opts.tools.find((tool) => tool.name === SCHEDULE_MANAGE_NAME);
	return createCogniProgram({
		...opts,
		tools: opts.tools.filter((tool) => tool.name !== SCHEDULE_MANAGE_NAME),
		guardedTools: writer
			? [createNodeScheduleGuard(receipts, writer, workflows)]
			: [],
		programMiddleware: [
			createWorkflowGuidancePreflight(
				receipts,
				opts.tools.filter((tool) => opts.readToolIds?.includes(tool.name)),
				workflows,
			),
		],
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

export function createNodeOperatorRunHooks() {
	const receipts = new NodeOperatorReceipts();
	return {
		graphOptions: { programState: receipts },
		observeTool: (
			name: string,
			args: unknown,
			result: { ok: boolean; value?: unknown },
		) => receipts.observe(name, args, result),
	};
}
createNodeOperatorGraph.createRunHooks = createNodeOperatorRunHooks;
