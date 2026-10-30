// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { DynamicStructuredTool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
/** Public runner control: poet must expose the same planning and delegation loop. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	cogniProfile,
	createCogniProgram,
} from "../../../src/graphs/mission/cogni";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { RunReceipts } from "../../../src/graphs/mission/receipts";
import { createScoresGuard } from "../../../src/graphs/mission/score-guard";
import { createPoetGraph } from "../../../src/graphs/poet/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn } from "../../../src/inproc/types";

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
				{ content: "Dawn warms the quiet hills." },
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
				stream: (async function* () {})(),
				final: Promise.resolve({ ok: true, ...reply }),
			};
		};
		const run = createInProcGraphRunner({
			createGraph: createPoetGraph,
			completionFn,
			createToolExecFn: () => async () => ({ ok: false, error: "not_found" }),
			toolContracts: [],
			request: {
				runId: "poet-control",
				messages: [{ role: "user", content: "Write a verse." }],
				configurable: { model: "test-model", toolIds: [] },
			},
		});
		for await (const _event of run.stream) {
			/* consume billing stream */
		}
		const result = await run.final;
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Dawn warms");
		expect(offered).toEqual(expect.arrayContaining(["write_todos", "task"]));
		expect(turn).toBe(5);
		expect(models).toContain("deepseek-v4-flash");
		expect(childTools).toContain("write_todos");
		expect(childTools).not.toContain("task");
	});
});
