// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { goalListContract } from "@cogni/ai-tools";
import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
/** Public runner control: poet must expose the same planning and delegation loop. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	graphReportDelta,
	graphReportLogFields,
	NODE_LANGGRAPH_CATALOG,
} from "../../../src/catalog";
import {
	cogniProfile,
	createCogniProgram,
} from "../../../src/graphs/mission/cogni";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { RunReceipts } from "../../../src/graphs/mission/receipts";
import { createScoresGuard } from "../../../src/graphs/mission/score-guard";
import { createPoetGraph } from "../../../src/graphs/poet/graph";
import { projectMissionCycleReport } from "../../../src/graphs/work-prioritizer/graph";
import { createMemoryPersistence } from "../../../src/inproc/postgres-persistence";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn } from "../../../src/inproc/types";
import { fromBaseMessage } from "../../../src/runtime/core/message-converters";

describe("shared cogni harness", () => {
	it("passes the SDK system instructions and fresh host clock to the billed completion", async () => {
		const seen: string[] = [];
		const completionFn: CompletionFn = (request) => {
			seen.push(
				...request.messages
					.filter((message) => message.role === "system")
					.map((message) => message.content),
			);
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true as const, content: "Done" }),
			};
		};
		const run = createInProcGraphRunner({
			program: "work-review",
			sourceContext: {
				nodeId: "node",
				origin: "https://node.example",
				mission: {
					content: "Mission clock control",
					sourceRef: "mission",
					buildSha: null,
				},
			},
			createGraph: createMissionGraph,
			completionFn,
			createToolExecFn: () => async () => ({ ok: true, value: {} }),
			toolContracts: [],
			request: {
				runId: "clock-control",
				messages: [{ role: "user", content: "Hello" }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(true);
		expect(seen.join("\n")).toContain("Mission clock control");
		expect(seen.join("\n")).toContain("Host-owned current UTC time");
		expect(seen.join("\n")).toContain(new Date().getUTCFullYear().toString());
	});

	it("returns scheduled cycle reports from child reads without streaming child text", async () => {
		for (const [alias, program] of [
			["work-prioritizer", "work-review"],
			["cogni-decide", "cogni-decide"],
		] as const) {
			let turn = 0;
			const completionFn: CompletionFn = () => {
				const current = turn++;
				const tool =
					current === 0
						? {
								id: "task",
								name: "task",
								args: {
									subagent_type: "ledger-reader",
									description: "Read goals",
								},
							}
						: current === 1
							? { id: "goals", name: "core__goal_list", args: {} }
							: undefined;
				const reply = tool
					? {
							toolCalls: [
								{
									id: tool.id,
									type: "function" as const,
									function: {
										name: tool.name,
										arguments: JSON.stringify(tool.args),
									},
								},
							],
						}
					: { content: current === 2 ? "PRIVATE CHILD" : "Parent report" };
				return {
					stream: (async function* () {
						yield {
							type: "text_delta" as const,
							delta: current === 2 ? "PRIVATE CHILD" : "model draft",
						};
					})(),
					final: Promise.resolve({ ok: true as const, ...reply }),
				};
			};
			const run = createInProcGraphRunner({
				program,
				requestIntent: "decide",
				createGraph: createMissionGraph,
				completionFn,
				sourceContext: {
					nodeId: "node",
					origin: "https://node.example",
					mission: { content: "Mission", sourceRef: "mission", buildSha: null },
				},
				createToolExecFn: () => async () => ({
					ok: true,
					value: {
						goals: [
							{
								id: "goal-one",
								title: "Goal",
								content: "Goal content",
								evaluateAt: null,
							},
						],
					},
				}),
				toolContracts: [goalListContract],
				request: {
					runId: alias,
					messages: [{ role: "user", content: "Read goals" }],
					configurable: { model: "test-model", toolIds: ["core__goal_list"] },
				},
			});
			const deltas: string[] = [];
			for await (const event of run.stream)
				if (event.type === "text_delta") deltas.push(event.delta);
			const result = await run.final;
			expect(result.ok).toBe(true);
			expect(deltas.join("")).toBe(result.content);
			expect(deltas.join("")).not.toContain("PRIVATE CHILD");
			expect(result.structuredOutput?.telemetry).toMatchObject({
				goalIds: ["goal-one"],
				changeCount: 0,
				decisionFiled: false,
			});
			const declaration = NODE_LANGGRAPH_CATALOG[alias].report;
			expect(
				graphReportLogFields(declaration, alias, result.structuredOutput)[0]
					?.event,
			).toBe(declaration.event);
			expect(graphReportDelta(result.structuredOutput)).toContain('"goal-one"');
		}
	});

	it("reports only successful observed score patches and returned rank scores", () => {
		const receipts = new RunReceipts("https://node.example");
		receipts.recordTool(
			"core__work_item_query",
			{},
			{ items: [{ id: "task.1", scores: { goal: { v: 1 } } }] },
		);
		receipts.recordTool(
			"core__work_item_transition",
			{ action: "patch", id: "task.1", scores: { goal: { v: 3 } } },
			{ success: true, id: "task.1", rankScore: 4.5 },
		);
		receipts.recordTool(
			"core__work_item_transition",
			{ action: "patch", id: "task.2" },
			{ success: false, id: "task.2", code: "revision_conflict" },
		);
		expect(
			projectMissionCycleReport("work-review", receipts, "done")?.telemetry,
		).toMatchObject({
			changedItemIds: ["task.1"],
			changeCount: 1,
			rankScores: [{ id: "task.1", rankScore: 4.5 }],
			decisionFiled: false,
		});
	});

	it("preserves textual blocks across all supported message roles", () => {
		const content = [
			{ type: "text" as const, text: "first " },
			{ type: "text" as const, text: "second" },
		];
		const messages = [
			new HumanMessage({ content }),
			new SystemMessage({ content }),
			new AIMessage({ content }),
			new ToolMessage({ content, tool_call_id: "result" }),
		];
		expect(messages.map((message) => fromBaseMessage(message).content)).toEqual(
			["first second", "first second", "first second", "first second"],
		);
		expect(
			fromBaseMessage(new ToolMessage({ content, tool_call_id: "result" }))
				.toolCallId,
		).toBe("result");
	});

	it("delivers a lazy SDK skill body through the billed adapter on the next model call", async () => {
		const requests: Parameters<CompletionFn>[0][] = [];
		let reads = 0;
		const completionFn: CompletionFn = (request) => {
			requests.push(request);
			const reply =
				requests.length === 1
					? {
							toolCalls: [
								{
									id: "skill-read",
									type: "function" as const,
									function: {
										name: "read_file",
										arguments: JSON.stringify({
											file_path: "/skills/test-skill/SKILL.md",
										}),
									},
								},
							],
						}
					: { content: "Read the skill." };
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true as const, ...reply }),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			trustedProgramId: "poet",
			sourceContext: {
				nodeId: "node",
				origin: "https://node.example",
				governingIndex: [
					{
						id: "test-skill",
						domain: "build-agents",
						entryType: "skill",
						useWhen: "when testing",
					},
				],
			},
			completionFn,
			createToolExecFn: () => async (name) => {
				reads++;
				if (name !== "core__knowledge_read") throw new Error("unexpected tool");
				return {
					ok: true,
					value: {
						mode: "get",
						entries: [
							{
								id: "test-skill",
								content: "Unique skill body reaches the model.",
							},
						],
					},
				};
			},
			toolContracts: [],
			request: {
				runId: "skill-body",
				messages: [{ role: "user", content: "Read the skill" }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(true);
		expect(reads).toBe(1);
		expect(requests).toHaveLength(2);
		const next = requests[1];
		expect(
			next?.messages.find((message) => message.role === "system")?.content,
		).toContain("Governing guidance metadata");
		expect(
			next?.messages.find(
				(message) =>
					message.role === "tool" && message.toolCallId === "skill-read",
			)?.content,
		).toContain("Unique skill body reaches the model.");
	});

	it("retries malformed provider tool arguments before executing a valid SDK tool", async () => {
		let calls = 0;
		const completionFn: CompletionFn = () => {
			const turn = calls++;
			const reply =
				turn < 2
					? {
							toolCalls: [
								{
									id: "list",
									type: "function" as const,
									function: {
										name: "ls",
										arguments: turn === 0 ? '{"path":"/","}' : '{"path":"/"}',
									},
								},
							],
						}
					: { content: "Finished." };
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true as const, ...reply }),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			trustedProgramId: "poet",
			completionFn,
			createToolExecFn: () => async () => {
				throw new Error("unexpected external tool");
			},
			toolContracts: [],
			request: {
				runId: "retry-json",
				messages: [{ role: "user", content: "List files" }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		const final = await run.final;
		expect(final.ok).toBe(true);
		expect(final.content).toBe("Finished.");
		expect(calls).toBe(3);
	});

	it("rejects scores after a partial SDK skill read", async () => {
		let calls = 0,
			writes = 0;
		const writer = new DynamicStructuredTool({
			name: "writer",
			description: "test",
			schema: z.object({}).passthrough(),
			func: async () => {
				writes++;
				return JSON.stringify({ success: true });
			},
		});
		const completionFn: CompletionFn = (request) => {
			const turn = calls++;
			if (turn === 1)
				expect(
					request.messages.find((m) => m.role === "tool")?.content,
				).toContain("skill_requires_complete_read");
			if (turn === 2)
				expect(
					request.messages.find((m) => m.toolCallId === "write")?.content,
				).toContain("incomplete_guidance_or_read");
			const tool =
				turn === 0
					? {
							name: "read_file",
							args: { file_path: "/skills/test-skill/SKILL.md", limit: 2 },
							id: "read",
						}
					: turn === 1
						? {
								name: "work_item_scores_write",
								args: {
									id: "task.1",
									expectedRevision: 1,
									scores: { goal: { v: 3 } },
								},
								id: "write",
							}
						: undefined;
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({
					ok: true as const,
					...(tool
						? {
								toolCalls: [
									{
										id: tool.id,
										type: "function" as const,
										function: {
											name: tool.name,
											arguments: JSON.stringify(tool.args),
										},
									},
								],
							}
						: { content: "done" }),
				}),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: (opts) => {
				if (!opts.receipts) throw new Error("missing receipts");
				opts.receipts.observe(
					"core__goal_list",
					{},
					{ goals: [{ id: "goal-one", content: "Goal" }] },
				);
				opts.receipts.observe(
					"core__work_item_read",
					{},
					{
						item: {
							id: "task.1",
							type: "task",
							status: "needs_implement",
							revision: 1,
							labels: ["goal:one"],
							createdAt: "2026-10-01T00:00:00Z",
							scores: { goal: { v: 1 } },
						},
					},
				);
				return createCogniProgram({
					...opts,
					guardedTools: [createScoresGuard(opts.receipts, writer, [])],
				});
			},
			sourceContext: {
				nodeId: "node",
				origin: "https://node.example",
				governingIndex: [
					{
						id: "test-skill",
						domain: "build-agents",
						entryType: "skill",
						useWhen: "test",
					},
				],
			},
			completionFn,
			createToolExecFn: () => async () => ({
				ok: true,
				value: {
					mode: "get",
					entries: [{ id: "test-skill", content: "full skill body" }],
				},
			}),
			toolContracts: [],
			request: {
				runId: "partial-skill",
				messages: [{ role: "user", content: "Read skill and score" }],
				configurable: { model: "test", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(true);
		expect(calls).toBe(3);
		expect(writes).toBe(0);
	});
	it("shares working store but allocates a fresh memory saver per invocation", async () => {
		const first = await createMemoryPersistence();
		const second = await createMemoryPersistence(first.store);
		expect(second.checkpointer).not.toBe(first.checkpointer);
		await first.store.put(["test"], "key", { value: "shared" });
		expect((await second.store.get(["test"], "key"))?.value).toEqual({
			value: "shared",
		});
	});

	it("uses the SDK task limit before a fifth delegated child", async () => {
		let turn = 0;
		let children = 0;
		const completionFn: CompletionFn = () => {
			const current = turn++;
			if (current % 2 !== 0) children++;
			const reply =
				current % 2 === 0
					? {
							toolCalls: [
								{
									id: `task-${current}`,
									type: "function" as const,
									function: {
										name: "task",
										arguments: JSON.stringify({
											subagent_type: "general-purpose",
											description: "Read",
										}),
									},
								},
							],
						}
					: { content: "Child finished" };
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true, ...reply }),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			completionFn,
			createToolExecFn: () => async () => ({
				ok: false,
				errorCode: "unavailable",
				safeMessage: "unavailable",
			}),
			toolContracts: [],
			request: {
				runId: "limit",
				messages: [{ role: "user", content: "delegate" }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(false);
		expect(children).toBe(4);
	});
	it("reuses one compiled core for concurrent independent runs", async () => {
		const model = new FakeListChatModel({ responses: ["first", "second"] });
		const graph = createCogniProgram({ llm: model, tools: [] });
		const results = await Promise.all([
			graph.invoke({ messages: [{ role: "user", content: "one" }] }),
			graph.invoke({ messages: [{ role: "user", content: "two" }] }),
		]);
		expect(results.every((result) => result.messages.at(-1)?.content)).toBe(
			true,
		);
	});

	it("allows an authorized custom read tool through a reviewed profile", async () => {
		let calls = 0;
		const completionFn: CompletionFn = () => ({
			stream: (async function* () {})(),
			final: Promise.resolve(
				calls++ === 0
					? {
							ok: true,
							toolCalls: [
								{
									id: "lookup",
									type: "function",
									function: { name: "core__review_lookup", arguments: "{}" },
								},
							],
						}
					: { ok: true, content: "found" },
			),
		});
		const reads: string[] = [];
		const run = createInProcGraphRunner({
			createGraph: (opts) =>
				createCogniProgram({
					...opts,
					profile: cogniProfile({
						id: "review",
						instructions: "Review",
						modelTier: "main",
						toolIds: ["core__review_lookup"],
						allowedChildProfiles: [],
						outputPolicy: "answer",
					}),
				}),
			completionFn,
			createToolExecFn: () => async (name) => {
				reads.push(name);
				return { ok: true, value: { answer: "observed" } };
			},
			toolContracts: [
				{
					name: "core__review_lookup",
					description: "lookup",
					effect: "read_only",
					inputSchema: z.object({}),
					outputSchema: z.object({ answer: z.string() }),
					redact: (value) => value,
					allowlist: ["answer"],
				},
			],
			request: {
				runId: "custom",
				messages: [{ role: "user", content: "review" }],
				configurable: { model: "test-model", toolIds: ["core__review_lookup"] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).content).toBe("found");
		expect(reads).toEqual(["core__review_lookup"]);
	});

	it("denies a hallucinated domain writer in a delegated child", async () => {
		let turn = 0;
		let writes = 0;
		const completionFn: CompletionFn = () => {
			const tool = (id: string, name: string, args: object) => ({
				id,
				type: "function" as const,
				function: { name, arguments: JSON.stringify(args) },
			});
			const replies = [
				{
					toolCalls: [
						tool("delegate", "task", {
							subagent_type: "general-purpose",
							description: "Try writer",
						}),
					],
				},
				{ toolCalls: [tool("bad", "core__domain_writer", {})] },
				{ content: "Writer unavailable." },
				{ content: "Writer unavailable." },
			];
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({
					ok: true,
					...(replies[turn++] ?? { content: "done" }),
				}),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			completionFn,
			createToolExecFn: () => async () => {
				writes++;
				return { ok: true, value: {} };
			},
			toolContracts: [
				{
					name: "core__domain_writer",
					description: "writer",
					effect: "state_change",
					inputSchema: z.object({}),
					outputSchema: z.object({}),
					redact: (value) => value,
					allowlist: [],
				},
			],
			request: {
				runId: "denied-child",
				messages: [{ role: "user", content: "delegate" }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(true);
		expect(writes).toBe(0);
	});
	it("fails closed on a repeated checkpointed run before model work", async () => {
		const checkpointer = new MemorySaver();
		const store = new InMemoryStore();
		let calls = 0;
		const completionFn: CompletionFn = () => {
			calls++;
			return {
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true, content: "A line." }),
			};
		};
		const invoke = async (runId: string) => {
			const run = createInProcGraphRunner({
				createGraph: createPoetGraph,
				completionFn,
				createToolExecFn: () => async () => ({
					ok: false,
					errorCode: "unavailable",
					safeMessage: "unavailable",
				}),
				toolContracts: [],
				trustedActorId: "actor-1",
				trustedProgramId: "poet",
				sourceContext: { nodeId: "node-1", origin: "https://node.example" },
				persistence: {
					checkpointer,
					store,
				},
				request: {
					runId,
					messages: [{ role: "user", content: "Write a line." }],
					configurable: { model: "test-model", toolIds: [] },
				},
			});
			for await (const _event of run.stream) {
				/* drain */
			}
			return run.final;
		};
		expect((await invoke("run-1")).ok).toBe(true);
		expect((await invoke("run-1")).ok).toBe(false);
		expect(calls).toBe(1);
		expect((await invoke("run-2")).ok).toBe(true);
		expect(calls).toBe(2);
	});
	it("requires read evidence before a scores-only compare-and-set", async () => {
		const receipts = new RunReceipts("https://node.example");
		const url = "https://node.example/knowledge/goal-one";
		receipts.observe(
			"core__goal_list",
			{},
			{ goals: [{ id: "goal-one", content: "Target", sourceUrl: url }] },
		);
		receipts.observe(
			"core__work_item_read",
			{ id: "task.0018" },
			{
				item: {
					id: "task.0018",
					type: "task",
					status: "needs_implement",
					revision: 9,
					labels: ["goal:one"],
					createdAt: "2026-10-01T00:00:00Z",
					summary: "Work toward the goal",
					scores: { goal: { v: 1 } },
				},
			},
		);
		const writes: unknown[] = [];
		const writer = new DynamicStructuredTool({
			name: "writer",
			description: "test",
			schema: z.object({}).passthrough(),
			func: async (input) => {
				writes.push(input);
				return JSON.stringify({ success: true });
			},
		});
		const guard = createScoresGuard(receipts, writer, [
			"dao-goals-design",
			"program-behavior-mode",
			"work-item-scores-design",
			"mission-loop-expert",
		]);
		const input = {
			id: "task.0018",
			expectedRevision: 9,
			scores: { goal: { v: 4, ev: url } },
		};
		expect(await guard.invoke(input)).toContain("incomplete_guidance");
		expect(writes).toHaveLength(0);
		for (const id of [
			"node-template-mission",
			"dao-goals-design",
			"program-behavior-mode",
			"work-item-scores-design",
			"mission-loop-expert",
		])
			receipts.observe(
				"core__knowledge_read",
				{ id },
				{ mode: "get", entries: [{ id, content: "Policy" }] },
			);
		expect(
			await guard.invoke({
				...input,
				scores: { goal: { v: 4, ev: "https://fabricated.example" } },
			}),
		).toContain("unobserved_or_unlinked");
		expect(writes).toHaveLength(0);
		expect(await guard.invoke(input)).toBe('{"success":true}');
		expect(await guard.invoke(input)).toContain("item_or_revision");
		expect(writes).toEqual([
			{
				action: "patch",
				id: "task.0018",
				expectedRevision: 9,
				scores: { goal: { v: 4, ev: url } },
			},
		]);
	});
	it("denies score writes after a failed or incomplete lazy skill read", async () => {
		for (const failure of ["denied", "incomplete"]) {
			let writes = 0;
			let result = "";
			const run = createInProcGraphRunner({
				createGraph: (opts) => ({
					invoke: async () => {
						if (!opts.receipts || !opts.readSkill)
							throw new Error("missing host dependencies");
						opts.receipts.observe(
							"core__goal_list",
							{},
							{ goals: [{ id: "goal-one", content: "Goal" }] },
						);
						opts.receipts.observe(
							"core__work_item_read",
							{},
							{
								item: {
									id: "task.1",
									type: "task",
									status: "needs_implement",
									revision: 1,
									labels: ["goal:one"],
									createdAt: "2026-10-01T00:00:00Z",
									scores: { goal: { v: 1 } },
								},
							},
						);
						try {
							await opts.readSkill("optional-skill");
						} catch {
							/* agent can continue after a backend error */
						}
						const writer = new DynamicStructuredTool({
							name: "writer",
							description: "test",
							schema: z.object({}).passthrough(),
							func: async () => {
								writes++;
								return JSON.stringify({ success: true });
							},
						});
						result = await createScoresGuard(opts.receipts, writer, []).invoke({
							id: "task.1",
							expectedRevision: 1,
							scores: { goal: { v: 3 } },
						});
						return { messages: [new AIMessage("done")] };
					},
				}),
				completionFn: () => {
					throw new Error("unexpected model call");
				},
				createToolExecFn: () => async () =>
					failure === "denied"
						? { ok: false, errorCode: "unavailable", safeMessage: "denied" }
						: { ok: true, value: { mode: "get", entries: [] } },
				toolContracts: [],
				request: {
					runId: `skill-${failure}`,
					messages: [{ role: "user", content: "read" }],
					configurable: { model: "test", toolIds: [] },
				},
			});
			for await (const _event of run.stream) {
				/* drain */
			}
			expect((await run.final).ok).toBe(true);
			expect(result).toContain("incomplete_guidance_or_read");
			expect(writes).toBe(0);
		}
	});

	it("requires a fresh item read after a conflicted or uncertain write", async () => {
		const receipts = new RunReceipts("https://node.example");
		receipts.observe(
			"core__goal_list",
			{},
			{ goals: [{ id: "goal-one", content: "Goal" }] },
		);
		const item = {
			id: "task.1",
			type: "task",
			status: "needs_implement",
			revision: 1,
			labels: ["goal:one"],
			createdAt: "2026-10-01T00:00:00Z",
			scores: { goal: { v: 1 } },
		};
		const read = () =>
			receipts.observe("core__work_item_read", { id: item.id }, { item });
		read();
		let calls = 0;
		const writer = new DynamicStructuredTool({
			name: "writer",
			description: "test",
			schema: z.object({}).passthrough(),
			func: async () => {
				calls++;
				if (calls === 1)
					return JSON.stringify({ success: false, code: "revision_conflict" });
				if (calls === 2) throw new Error("lost reply");
				return JSON.stringify({ success: true });
			},
		});
		const guard = createScoresGuard(receipts, writer, []);
		const input = {
			id: item.id,
			expectedRevision: 1,
			scores: { goal: { v: 3 } },
		};
		expect(await guard.invoke(input)).toContain("revision_conflict");
		expect(await guard.invoke(input)).toContain("item_or_revision");
		read();
		expect(await guard.invoke(input)).toContain("write_result_uncertain");
		expect(await guard.invoke(input)).toContain("item_or_revision");
		read();
		expect(await guard.invoke(input)).toContain('"success":true');
		expect(await guard.invoke(input)).toContain("item_or_revision");
		expect(calls).toBe(3);
	});

	it("revises a real plan after a delegated task in poet", async () => {
		const offered: string[] = [];
		const models: string[] = [];
		const childTools: string[] = [];
		let turn = 0;
		const completionFn: CompletionFn = (request) => {
			models.push(request.model);
			for (const tool of request.tools ?? []) {
				if (typeof tool === "object" && tool !== null && "function" in tool) {
					const fn = tool.function;
					if (
						typeof fn === "object" &&
						fn !== null &&
						"name" in fn &&
						typeof fn.name === "string"
					) {
						offered.push(fn.name);
						if (request.model === "deepseek-v4-flash") childTools.push(fn.name);
					}
				}
			}
			const toolCall = (id: string, name: string, args: object) => ({
				id,
				type: "function" as const,
				function: { name, arguments: JSON.stringify(args) },
			});
			const replies = [
				{
					toolCalls: [
						toolCall("plan", "write_todos", {
							todos: [{ content: "Delegate a line", status: "in_progress" }],
						}),
					],
				},
				{
					toolCalls: [
						toolCall("delegate", "task", {
							description: "Compose one line about dawn",
							subagent_type: "general-purpose",
						}),
					],
				},
				{ content: "PRIVATE CHILD DRAFT" },
				{
					toolCalls: [
						toolCall("revise", "write_todos", {
							todos: [
								{ content: "Delegate a line", status: "completed" },
								{ content: "Answer", status: "in_progress" },
							],
						}),
					],
				},
				{ content: "Dawn warms the quiet hills." },
			];
			const reply = replies[turn++] ?? {
				content: "Dawn warms the quiet hills.",
			};
			return {
				stream: (async function* () {
					yield {
						type: "text_delta" as const,
						delta: reply.content ?? "internal planning",
					};
				})(),
				final: Promise.resolve({ ok: true, ...reply }),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			trustedProgramId: "poet",
			completionFn,
			createToolExecFn: () => async () => ({ ok: false, error: "not_found" }),
			toolContracts: [],
			request: {
				runId: "poet-control",
				messages: [{ role: "user", content: "Write a verse." }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		const deltas: string[] = [];
		for await (const event of run.stream) {
			if (event.type === "text_delta") deltas.push(event.delta);
		}
		const result = await run.final;
		expect(deltas.join("")).toBe(result.content);
		expect(deltas.join("")).not.toContain("PRIVATE CHILD DRAFT");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Dawn warms");
		expect(offered).toEqual(expect.arrayContaining(["write_todos", "task"]));
		expect(turn).toBe(5);
		expect(models).toContain("deepseek-v4-flash");
		expect(childTools).toContain("write_todos");
		expect(childTools).not.toContain("task");
	});
});
