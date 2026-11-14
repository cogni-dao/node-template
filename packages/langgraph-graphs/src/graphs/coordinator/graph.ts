import { SCHEDULE_LIST_NAME, SCHEDULE_MANAGE_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import { COGNI_TOOL_IDS } from "../cogni/tools";
import type { CreateReactAgentGraphOptions } from "../types";
import { COORDINATOR_PROMPT } from "./prompts";
import {
	createNodeScheduleGuard,
	createWorkflowGuidancePreflight,
	CoordinatorReceipts,
	type WorkflowGuidance,
} from "./guidance";

/** Cogni's reads plus schedule management; its only write is arranging jobs. */
export const COORDINATOR_TOOL_IDS: readonly string[] = [
	...COGNI_TOOL_IDS.filter((id) => id !== "core__metric_compute"),
	SCHEDULE_LIST_NAME,
	SCHEDULE_MANAGE_NAME,
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
) {
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

export function createCoordinatorRunHooks() {
	const receipts = new CoordinatorReceipts();
	return {
		graphOptions: { programState: receipts },
		observeTool: (
			name: string,
			args: unknown,
			result: { ok: boolean; value?: unknown },
		) => receipts.observe(name, args, result),
		// A tick that hits the step limit ends in a report of its actual schedule writes, not a crash.
		projectStepBudget: () => {
			const changes = receipts.scheduleChanges;
			const answer = `STEP_BUDGET: the coordinating tick reached its step limit. Schedule changes: ${changes.length ? changes.join(", ") : "none"}.`;
			return {
				answer,
				output: {
					telemetry: {
						aborted: true,
						abortReason: "step_budget",
						scheduleChanges: [...changes],
					},
				},
			};
		},
	};
}
createCoordinatorGraph.createRunHooks = createCoordinatorRunHooks;
