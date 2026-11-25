// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { randomUUID } from "node:crypto";
import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { Command, getConfig } from "@langchain/langgraph";
import { createMiddleware, MiddlewareError } from "langchain";
import { InvalidCompletionError } from "../../runtime/cogni/completion-adapter";
import { authorizedReadMessages } from "../cogni/authorized-read-messages";
import {
	ChildBoundaryError,
	cogniProfile,
	createCogniProgram,
} from "../cogni/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import {
	BUDGET_PROMPT,
	CRITIC_DESCRIPTION,
	CRITIC_PROMPT,
	MISSION_RESEARCH_PROMPT,
	REQUIRED_GUIDANCE_IDS,
	repairPrompt,
} from "./prompts";
import { ResearchReceipts } from "./receipts";
import { MISSION_RESEARCH_TOOL_IDS } from "./tools";

const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;
const HOST_CRITIC_PREFIX = "host-critic-";
const answerText = (message: AIMessage) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.map((part) =>
					typeof part === "object" && part && "text" in part
						? String(part.text)
						: "",
				)
				.join("");
export function createMissionResearchGraph(opts: CreateReactAgentGraphOptions) {
	const receipts =
		opts.programState instanceof ResearchReceipts
			? opts.programState
			: new ResearchReceipts(opts.sourceContext?.origin ?? "");
	for (const entry of opts.sourceContext?.governingIndex ?? [])
		receipts.domains.add(entry.domain);
	const exhausted = () =>
		receipts.tools >= 24 ||
		[
			"search_budget",
			"evidence_limit",
			"draft_limit",
			"critic_input_limit",
			"critic_output_limit",
		].some((reason) => receipts.reasons.has(reason));
	const profile = cogniProfile({
		id: "mission-research",
		instructions: MISSION_RESEARCH_PROMPT,
		modelTier: "main",
		toolIds: [...MISSION_RESEARCH_TOOL_IDS],
		skillIds: (opts.sourceContext?.governingIndex ?? []).map((item) => item.id),
		allowedChildProfiles: ["critic"],
	});
	// The host, not the model, owns the required stages: read the methods and goals, critique the
	// first valid draft once, allow one revision, and give one repair turn for an unbindable answer.
	const stages = createMiddleware({
		name: "MissionResearchStages",
		beforeAgent: {
			canJumpTo: ["end"],
			hook: async () => {
				if (receipts.bootstrapped) return;
				receipts.bootstrapped = true;
				receipts.tools += REQUIRED_GUIDANCE_IDS.length + 1;
				let messages: Awaited<ReturnType<typeof authorizedReadMessages>> = [];
				try {
					messages = await authorizedReadMessages(opts.tools, [
						...REQUIRED_GUIDANCE_IDS.map((id) => ({
							name: "core__knowledge_read",
							args: { id },
						})),
						{ name: "core__goal_list", args: {} },
					]);
				} catch (error) {
					// Cancellation and timeouts stay native failures, never an incomplete handoff.
					if (getConfig().signal?.aborted) throw error;
					receipts.reasons.add("guidance_failure");
					return { jumpTo: "end" as const };
				}
				const missing = REQUIRED_GUIDANCE_IDS.some(
					(id) => !receipts.guidance.has(id),
				);
				if (missing) receipts.reasons.add("missing_guidance");
				if (!receipts.goalsObserved) receipts.reasons.add("missing_goal_context");
				return missing || !receipts.goalsObserved
					? { messages, jumpTo: "end" as const }
					: { messages };
			},
		},
		afterModel: {
			canJumpTo: ["model", "tools", "end"],
			hook: (state) => {
				const last = state.messages.at(-1);
				if (!AIMessage.isInstance(last) || last.tool_calls?.length) return;
				const answer = answerText(last);
				const critiqued = receipts.criticDispatched;
				if (critiqued && (!receipts.critique || receipts.refined)) return;
				const problems = receipts.check(answer);
				if (problems.length) {
					const stage = critiqued ? "final" : "draft";
					// Exhausted collection still gets its repair turn: capability calls are refused, so the
					// researcher can only bind, remove or mark unknown what it already observed.
					if (receipts.repaired.has(stage)) return;
					receipts.repaired.add(stage);
					return {
						messages: [
							new HumanMessage(
								repairPrompt(problems, {
									domains: [...receipts.domains],
									owners: [...receipts.owners.keys()],
									sources: [...receipts.sources.keys()],
								}),
							),
						],
						jumpTo: "model" as const,
					};
				}
				if (critiqued) {
					receipts.refined = true;
					return;
				}
				// A bindable but partial draft is an explicit incomplete handoff, not a critique target.
				if (!receipts.isCompleteDraft(answer)) return;
				receipts.tasks++;
				receipts.criticDispatched = true;
				return {
					messages: [
						new AIMessage({
							...(last.id ? { id: last.id } : {}),
							content: last.content,
							response_metadata: last.response_metadata,
							...(last.usage_metadata
								? { usage_metadata: last.usage_metadata }
								: {}),
							tool_calls: [
								{
									id: `${HOST_CRITIC_PREFIX}${randomUUID()}`,
									name: "task",
									args: { subagent_type: "critic", description: answer },
									type: "tool_call",
								},
							],
						}),
					],
					jumpTo: "tools" as const,
				};
			},
		},
	});
	const middleware = createMiddleware({
		name: "MissionResearchBoundaries",
		wrapModelCall: async (request, handler) => {
			// Offer only the program's capabilities: the host runs the critic, the methods arrive by
			// bootstrap, and built-in scratch and todo turns spent the run's step limit on candidate.
			const capabilities = new Set<string>(MISSION_RESEARCH_TOOL_IDS);
			const tools = request.tools.filter(
				(tool) => "name" in tool && capabilities.has(String(tool.name)),
			);
			const result = await handler(
				exhausted()
					? {
							...request,
							tools,
							systemMessage: request.systemMessage.concat(
								new SystemMessage(BUDGET_PROMPT),
							),
						}
					: { ...request, tools },
			);
			if (AIMessage.isInstance(result))
				for (const call of result.tool_calls ?? [])
					if (call.name === "task") {
						receipts.tasks++;
						if (receipts.tasks > 1) receipts.reasons.add("excess_task_attempt");
					}
			return result;
		},
		wrapToolCall: async (request, handler) => {
			const call = request.toolCall;
			const hostCritic =
				call.name === "task" &&
				(call.id ?? "").startsWith(HOST_CRITIC_PREFIX);
			const alreadyExhausted = exhausted();
			// The operation budget covers capability calls and the critic, not scratch files or todos.
			const counted = call.name.startsWith("core__") || call.name === "task";
			if (counted) receipts.tools++;
			const reject = (reason: string) => {
				receipts.reasons.add(reason);
				return new ToolMessage({
					name: call.name,
					tool_call_id: call.id ?? "",
					content: reason,
					status: "error",
				});
			};
			// The host critic has its own one-dispatch bound; collection exhaustion never forbids it.
			if (counted && receipts.tools > 24 && !hostCritic)
				return reject("tool_budget");
			if (alreadyExhausted && call.name.startsWith("core__"))
				return reject("research_budget");
			if (
				call.args === null ||
				typeof call.args !== "object" ||
				Array.isArray(call.args)
			)
				return reject("invalid_tool_arguments");
			if (call.name === "task" && !hostCritic) return reject("invalid_task");
			if (call.name === "core__web_search") {
				receipts.searches++;
				if (receipts.searches > 6) return reject("search_budget");
				const maxResults = call.args.maxResults;
				if (maxResults !== undefined && typeof maxResults !== "number")
					return reject("invalid_tool_arguments");
				request = {
					...request,
					toolCall: {
						...call,
						args: {
							...call.args,
							maxResults: Math.min(maxResults ?? 3, 3),
						},
					},
				};
			}
			if (
				call.name === "core__knowledge_read" &&
				(typeof call.args.id !== "string" ||
					call.args.domain !== undefined ||
					call.args.node !== undefined)
			)
				return reject("knowledge_read_scope");
			if (call.name === "task") {
				if (
					call.args.subagent_type !== "critic" ||
					typeof call.args.description !== "string" ||
					receipts.taskId
				)
					return reject("invalid_task");
				const description = receipts.prepare(
					call.args.description,
					call.id ?? "",
				);
				if (!description) return reject("invalid_draft");
				request = {
					...request,
					toolCall: { ...call, args: { ...call.args, description } },
				};
			}
			try {
				const result = await handler(request);
				const update =
					result instanceof Command && !Array.isArray(result.update)
						? result.update
						: undefined;
				const messages =
					result instanceof ToolMessage
						? [result]
						: Array.isArray(update?.messages)
							? update.messages
							: [];
				if (call.name === "task") {
					const response = messages.find(
						(message: unknown) => message instanceof ToolMessage,
					) as ToolMessage | undefined;
					if (
						!response ||
						response.status === "error" ||
						response.tool_call_id !== call.id
					)
						return reject("critic_failed");
					receipts.complete(response.content);
				}
				if (call.name.startsWith("core__") && bytes(result) > 48 * 1024)
					return reject("evidence_limit");
				return result;
			} catch (error) {
				if (call.name !== "task") return reject("tool_failed");
				let cause: unknown = error;
				const seen = new Set<unknown>();
				while (
					MiddlewareError.isInstance(cause) &&
					"cause" in cause &&
					!seen.has(cause)
				) {
					seen.add(cause);
					cause = cause.cause;
				}
				if (cause instanceof ChildBoundaryError)
					return reject(
						cause.code === "output_limit"
							? "critic_output_limit"
							: "critic_failed",
					);
				if (cause instanceof Error && cause.name === "GraphRecursionError")
					return reject("critic_failed");
				if (
					cause instanceof InvalidCompletionError &&
					(cause.message === "empty_model_completion" ||
						cause.message === "malformed_tool_arguments")
				)
					return reject("critic_failed");
				throw error;
			}
		},
	});
	const {
		store: _store,
		memoryNamespace: _memoryNamespace,
		...isolated
	} = opts;
	const readSkill = opts.readSkill;
	return createCogniProgram({
		...isolated,
		...(readSkill && {
			readSkill: (id: string) => {
				if (exhausted()) {
					receipts.reasons.add("research_budget");
					throw new Error("research_budget");
				}
				return readSkill(id);
			},
		}),
		program: "mission-research",
		// The methods plus bounded source evidence exceed the 24k default; summarizing them away
		// mid-run left the researcher re-reading history instead of drafting.
		summarizationTokens: 96_000,
		profile: { ...profile, limits: { maxTaskCalls: 1, maxDepth: 1 } },
		childStatePolicy: "messages-only",
		taskLimitExitBehavior: "continue",
		programMiddleware: [stages, middleware],
		children: [
			{
				description: CRITIC_DESCRIPTION,
				profile: cogniProfile({
					id: "critic",
					instructions: CRITIC_PROMPT,
					modelTier: "main",
					toolIds: [],
					skillIds: [],
					allowedChildProfiles: [],
				}),
			},
		],
	});
}
export function createResearchRunHooks(context: { origin?: string }) {
	const receipts = new ResearchReceipts(context.origin ?? "");
	return {
		graphOptions: { programState: receipts },
		observeTool: (
			name: string,
			args: unknown,
			result: { ok: boolean; value?: unknown },
		) => {
			if (result.ok) receipts.observe(name, args, result.value);
			else receipts.reasons.add("source_failure");
		},
		onSkillReadFailure: () => {
			receipts.reasons.add("guidance_failure");
		},
		projectAnswer: (answer: string) => receipts.project(answer).answer,
		projectOutput: (answer: string) => {
			try {
				return JSON.parse(answer) as Record<string, unknown>;
			} catch {
				return receipts.project("").output;
			}
		},
		projectStepBudget: () => receipts.project("", "step_budget"),
	};
}
createMissionResearchGraph.createRunHooks = createResearchRunHooks;
