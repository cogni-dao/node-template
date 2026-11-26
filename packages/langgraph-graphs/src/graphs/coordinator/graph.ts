import { ACCOUNT_CREDITS_READ_NAME, SANDBOX_SHELL_NAME, SCHEDULE_LIST_NAME, SCHEDULE_MANAGE_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { COGNI_TOOL_IDS } from "../cogni/tools";
import type { CompiledAgentGraph, CreateReactAgentGraphOptions } from "../types";
import { COORDINATOR_PROMPT } from "./prompts";
import { chatStepBudgetAnswer } from "./shell-progress";
import {
	createNodeScheduleGuard,
	createWorkflowGuidancePreflight,
	CoordinatorReceipts,
	type WorkflowGuidance,
} from "./guidance";

/**
 * Cogni's reads plus schedule management; its only write is arranging jobs. `core__account_credits_read` is a read that opens only after the
 * account owner turns "this node's AI" On for their account (task.5465, an `account` grant on the run's account); until then the run-start filter
 * withholds it, so listing it here changes nothing for a person who has not said yes.
 */
export const COORDINATOR_TOOL_IDS: readonly string[] = [
	...COGNI_TOOL_IDS.filter((id) => id !== "core__metric_compute"),
	ACCOUNT_CREDITS_READ_NAME,
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
	SANDBOX_SHELL_NAME,
];

/**
 * A minimal operating program on the existing billed harness. Chat and schedules share one
 * tool set; host capabilities authorize the run actor. Cogni coordinates registered programs;
 * domain writes such as scoring belong to those programs, not to the coordinator.
 */
export function createCoordinatorGraph(
	opts: CreateReactAgentGraphOptions & {
		readonly workflowGuidance?: readonly WorkflowGuidance[];
	},
): CompiledAgentGraph {
	const receipts =
		opts.programState instanceof CoordinatorReceipts
			? opts.programState
			: new CoordinatorReceipts();
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
			instructions: opts.systemPrompt ?? COORDINATOR_PROMPT,
			modelTier: "main",
			toolIds: opts.tools.map((tool) => tool.name),
			skillIds: (opts.sourceContext?.governingIndex ?? []).map(
				(entry) => entry.id,
			),
			allowedChildProfiles: [],
		}),
	});
}

export function createCoordinatorRunHooks(context: { interactive?: boolean } = {}) {
	const receipts = new CoordinatorReceipts();
	return {
		graphOptions: { programState: receipts },
		observeTool: (
			name: string,
			args: unknown,
			result: { ok: boolean; value?: unknown },
		) => receipts.observe(name, args, result),
		// A run that hits the step limit ends in a report of what it actually did, not a crash. The words come
		// from the run that happened: a chat reports its sandbox work and the next step to the user; only a
		// scheduled coordinating tick reports schedule changes.
		projectStepBudget: () => {
			const changes = receipts.scheduleChanges;
			const progress = receipts.shell.summary();
			const answer = context.interactive
				? chatStepBudgetAnswer(progress)
				: `STEP_BUDGET: the coordinating tick reached its step limit. Schedule changes: ${changes.length ? changes.join(", ") : "none"}.`;
			return {
				answer,
				output: {
					telemetry: {
						aborted: true,
						abortReason: "step_budget",
						scheduleChanges: [...changes],
						...(context.interactive && { shell: progress }),
					},
				},
			};
		},
	};
}
createCoordinatorGraph.createRunHooks = createCoordinatorRunHooks;
