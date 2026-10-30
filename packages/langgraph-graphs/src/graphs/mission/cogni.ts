// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** The reusable cogni core; models, capabilities and host identity are injected. */
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StructuredTool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import {
	type CompiledSubAgent,
	CompositeBackend,
	createDeepAgent,
	createSubAgentMiddleware,
	createSummarizationMiddleware,
	StateBackend,
	StoreBackend,
} from "deepagents";
import {
	createMiddleware,
	MiddlewareError,
	modelRetryMiddleware,
	todoListMiddleware,
	toolCallLimitMiddleware,
} from "langchain";
import { InvalidCompletionError } from "../../runtime/cogni/completion-adapter";
import type { CreateReactAgentGraphOptions } from "../types";
import { HubSkillBackend } from "./skill-backend";

/** Only tools actually exported by this node's core tool catalog. */
export const COGNI_TOOL_IDS = [
	"core__goal_list",
	"core__knowledge_read",
	"core__knowledge_search",
	"core__repo_list",
	"core__repo_open",
	"core__repo_search",
	"core__work_item_query",
	"core__work_item_read",
	"core__get_current_time",
] as const;

export interface AgentProfile {
	readonly id: string;
	readonly instructions: string;
	readonly modelTier: string;
	readonly skillIds: readonly string[];
	readonly requiredGuidanceIds: readonly string[];
	readonly toolIds: readonly string[];
	readonly allowedChildProfiles: readonly string[];
	readonly limits: { readonly maxTaskCalls: number; readonly maxDepth: number };
	readonly outputPolicy: "answer" | "scores";
}

export function cogniProfile(
	input: Pick<
		AgentProfile,
		| "id"
		| "instructions"
		| "modelTier"
		| "toolIds"
		| "allowedChildProfiles"
		| "outputPolicy"
	> &
		Partial<Pick<AgentProfile, "skillIds" | "requiredGuidanceIds">>,
): AgentProfile {
	return {
		...input,
		skillIds: input.skillIds ?? [],
		requiredGuidanceIds: input.requiredGuidanceIds ?? [],
		limits: { maxTaskCalls: 4, maxDepth: 1 },
	};
}

/** Construct the shared core with a host-selected prompt and an explicit child registry. */
export function createCogniProgram(
	opts: CreateReactAgentGraphOptions & {
		readonly children?: CompiledSubAgent[];
		readonly disableCheckpointer?: boolean;
		readonly guardedTools?: readonly StructuredTool[];
		readonly profile?: AgentProfile;
	},
) {
	const model = opts.profile
		? (opts.tierModels?.[opts.profile.modelTier] ??
			(!opts.tierModels ? opts.llm : undefined))
		: opts.llm;
	if (!(model instanceof BaseLanguageModel)) {
		throw new Error("cogni_requires_base_language_model");
	}
	const allowedTools = new Set(opts.profile?.toolIds ?? COGNI_TOOL_IDS);
	const readTools = new Set(opts.readToolIds ?? COGNI_TOOL_IDS);
	const tools = opts.tools
		.filter((tool) => allowedTools.has(tool.name) && readTools.has(tool.name))
		.map((tool) => {
			if (!(tool instanceof StructuredTool))
				throw new Error(`unsupported_tool:${tool.name}`);
			return tool;
		});
	if (
		opts.profile &&
		opts.children?.some(
			(child) => !opts.profile?.allowedChildProfiles.includes(child.name),
		)
	)
		throw new Error("cogni_child_profile_not_allowed");
	if (
		opts.children?.length &&
		(opts.disableCheckpointer || (opts.profile?.limits.maxDepth ?? 1) < 1)
	)
		throw new Error("cogni_child_depth_exceeded");
	const routes: Record<string, StoreBackend | HubSkillBackend> = {};
	if (opts.memoryNamespace && opts.store)
		routes["/memories/"] = new StoreBackend({
			store: opts.store,
			namespace: [...opts.memoryNamespace],
		});
	const index = (opts.sourceContext?.governingIndex ?? []).filter(
		(entry) =>
			!opts.profile?.skillIds.length ||
			opts.profile.skillIds.includes(entry.id),
	);
	routes["/skills/"] = new HubSkillBackend(
		index.map((entry) => entry.id),
		opts.readSkill ??
			(async () => {
				throw new Error("skill_source_unavailable");
			}),
	);
	const backend = new CompositeBackend(new StateBackend(), routes);
	const guidanceIndex = JSON.stringify(index);
	if (
		index.length > 50 ||
		new TextEncoder().encode(guidanceIndex).length > 16_384
	)
		throw new Error("cogni_guidance_index_exceeds_limit");
	return createDeepAgent({
		name: "cogni",
		model,
		tools: [...tools, ...(opts.guardedTools ?? [])],
		systemPrompt: [
			opts.profile?.instructions ??
				opts.systemPrompt ??
				"Read the available evidence and answer. Do not perform domain writes.",
			...(opts.sourceContext?.mission
				? [
						`Host-owned mission (${opts.sourceContext.mission.sourceRef}):\n${opts.sourceContext.mission.content}`,
					]
				: []),
			...(opts.sourceContext?.governingIndex
				? [
						`Governing guidance metadata (bodies are not yet read): ${guidanceIndex}\nUse core__knowledge_read with an exact id to read a body when relevant.`,
					]
				: []),
		].join("\n\n"),
		...(opts.disableCheckpointer
			? { checkpointer: false }
			: opts.checkpointer
				? { checkpointer: opts.checkpointer }
				: {}),
		...(opts.store ? { store: opts.store } : {}),
		backend,
		middleware: [
			modelRetryMiddleware({
				maxRetries: 2,
				retryOn: (error) => {
					// LangChain wraps errors at each middleware boundary.
					let current: unknown = error;
					while (MiddlewareError.isInstance(current) && "cause" in current)
						current = current.cause;
					return current instanceof InvalidCompletionError;
				},
				initialDelayMs: 0,
				onFailure: "error",
			}),
			createMiddleware({
				name: "CogniSourceContext",
				beforeAgent: () => {
					if (
						opts.program &&
						(!opts.sourceContext?.nodeId ||
							!opts.sourceContext.origin ||
							!opts.sourceContext.mission?.content.trim())
					) {
						throw new Error("node_source_identity_unavailable");
					}
				},
			}),
			...(opts.program
				? [
						createMiddleware({
							name: "CogniHostClock",
							wrapModelCall: (request, handler) =>
								handler({
									...request,
									systemMessage: request.systemMessage.concat(
										new SystemMessage({
											content: `Host-owned current UTC time: ${new Date().toISOString()}`,
										}),
									),
								}),
						}),
					]
				: []),
			toolCallLimitMiddleware({
				toolName: "task",
				runLimit: Math.min(4, opts.profile?.limits.maxTaskCalls ?? 4),
				exitBehavior: "error",
			}),
			createMiddleware({
				name: "CogniChildOutputLimit",
				wrapToolCall: async (request, handler) => {
					const result = await handler(request);
					if (request.toolCall.name === "task") {
						const update =
							result instanceof Command ? result.update : undefined;
						const messages =
							update && !Array.isArray(update) ? update.messages : undefined;
						const outputs =
							result instanceof ToolMessage
								? [result]
								: Array.isArray(messages)
									? messages
									: [];
						if (
							outputs.some(
								(message) =>
									message instanceof ToolMessage &&
									new TextEncoder().encode(JSON.stringify(message.content))
										.length > 16_384,
							)
						)
							throw new Error("cogni_child_output_exceeds_limit");
					}
					return result;
				},
			}),
			todoListMiddleware(),
			createSummarizationMiddleware({
				model,
				backend,
				trigger: { type: "tokens", value: 24_000 },
				keep: { type: "messages", value: 12 },
			}),
			opts.children?.length
				? createSubAgentMiddleware({
						defaultModel: model,
						defaultTools: [],
						generalPurposeAgent: false,
						subagents: opts.children,
					})
				: createMiddleware({ name: "subAgentMiddleware" }),
		],
	});
}
