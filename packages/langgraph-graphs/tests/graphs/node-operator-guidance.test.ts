// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import type { AiEvent } from "@cogni/ai-core";
import { CORE_TOOL_BUNDLE, ScheduleManageInputSchema } from "@cogni/ai-tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { LANGGRAPH_CATALOG } from "../../src/catalog";
import {
	createNodeScheduleGuard,
	NodeOperatorReceipts,
} from "../../src/graphs/node-operator/guidance";
import { createInProcGraphRunner } from "../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../src/inproc/types";
import { OPEN_STATUSES } from "../../src/graphs/work-prioritizer/tools";

const names = [
	"core__knowledge_read",
	"core__schedule_list",
	"core__schedule_manage",
	"core__goal_list",
	"core__goal_progress",
	"core__work_item_query",
];
const contextResult = (
	name: string,
): Awaited<ReturnType<ToolExecFn>> | undefined => {
	if (name === "core__goal_list") return { ok: true, value: { goals: [] } };
	if (name === "core__goal_progress")
		return {
			ok: true,
			value: { goals: [], asOf: "2026-11-12T00:00:00Z", environment: "test" },
		};
	if (name === "core__work_item_query")
		return { ok: true, value: { items: [], count: 0 } };
};
const contracts = CORE_TOOL_BUNDLE.filter((tool) =>
	names.includes(tool.contract.name),
).map((tool) => tool.contract);
const create = {
	action: "create",
	purpose: "test-duty",
	graphId: "langgraph:work-prioritizer",
	instruction: "Triage",
	cron: "0 * * * *",
	timezone: "UTC",
};
const workflow = [
	{ graphId: create.graphId, guidanceId: "graph-work-prioritizer" },
];
const result = (content: string, call?: { name: string; args: object }) => ({
	stream: (async function* (): AsyncIterable<AiEvent> {})(),
	final: Promise.resolve({
		ok: true as const,
		content,
		finishReason: call ? "tool_calls" : "stop",
		...(call
			? {
					toolCalls: [
						{
							id: call.name,
							type: "function" as const,
							function: {
								name: call.name,
								arguments: JSON.stringify(call.args),
							},
						},
					],
				}
			: {}),
	}),
});

async function run(completionFn: CompletionFn, exec: ToolExecFn) {
	const runner = createInProcGraphRunner({
		program: "cogni",
		createGraph: LANGGRAPH_CATALOG.cogni.graphFactory,
		completionFn,
		sourceContext: {
			nodeId: "test",
			origin: "https://node.example",
			mission: {
				content: "Test mission",
				sourceRef: "fixture",
				buildSha: null,
			},
		},
		toolContracts: contracts,
		createToolExecFn: () => exec,
		request: {
			runId: "native-coordinator",
			messages: [{ role: "user", content: "Arrange the duty" }],
			configurable: { model: "test", toolIds: names },
		},
	});
	for await (const _ of runner.stream) {
		/* drain */
	}
	return runner.final;
}

describe("native coordinator workflow guidance", () => {
	it("does not read cards for an ordinary answer", async () => {
		const calls: string[] = [];
		const final = await run(
			() => result("Hello"),
			async (name) => {
				calls.push(name);
				return { ok: true, value: {} };
			},
		);
		expect(final.ok).toBe(true);
		expect(calls).toEqual([]);
	});
	it("reads catalog cards through the host before deciding after a purpose lookup", async () => {
		const reads: string[] = [];
		let model = 0;
		let writes = 0;
		const final = await run(
			(request) => {
				model++;
				if (model === 1)
					return result("", {
						name: "core__schedule_list",
						args: { purpose: create.purpose },
					});
				expect(reads).toContain("graph-work-prioritizer");
				expect(
					request.messages.filter((message) => message.role === "tool").length,
				).toBeGreaterThanOrEqual(6);
				return model === 2
					? result("", { name: "core__schedule_manage", args: create })
					: result("Created");
			},
			async (name, args) => {
				const context = contextResult(name);
				if (context) return context;
				if (name === "core__knowledge_read") {
					const id = (args as { id: string }).id;
					reads.push(id);
					return {
						ok: true,
						value: {
							mode: "get",
							entries: [{ id, content: "Full current card" }],
						},
					};
				}
				if (name === "core__schedule_list")
					return { ok: true, value: { schedules: [] } };
				writes++;
				return { ok: true, value: { success: true, scheduleId: "fixture" } };
			},
		);
		expect(final.ok).toBe(true);
		expect(writes).toBe(1);
		expect(new Set(reads).size).toBe(reads.length);
	});
	it("keeps a missing selected card visible, refuses creation, and does not auto-retry forever", async () => {
		let model = 0;
		let writes = 0;
		const reads: string[] = [];
		await run(
			(request) => {
				model++;
				if (model === 1)
					return result("", {
						name: "core__schedule_list",
						args: { purpose: create.purpose },
					});
				if (model === 2)
					return result("", { name: "core__schedule_manage", args: create });
				expect(JSON.stringify(request.messages)).toContain("guard_rejected");
				return result("Required guidance unavailable");
			},
			async (name, args) => {
				const context = contextResult(name);
				if (context) return context;
				if (name === "core__knowledge_read") {
					const id = (args as { id: string }).id;
					reads.push(id);
					return { ok: true, value: { mode: "get", entries: [] } };
				}
				if (name === "core__schedule_list")
					return { ok: true, value: { schedules: [] } };
				writes++;
				return { ok: true, value: {} };
			},
		);
		expect(writes).toBe(0);
		expect(new Set(reads).size).toBe(reads.length);
		expect(model).toBe(3);
	});
});

describe("program schedule creation guard", () => {
	it("requires exact host lookup and successful complete selected-card receipts", async () => {
		const receipts = new NodeOperatorReceipts();
		let writes = 0;
		const writer = new DynamicStructuredTool({
			name: "core__schedule_manage",
			description: "Host writer",
			schema: ScheduleManageInputSchema,
			func: async () => {
				writes++;
				return "created";
			},
		});
		const guard = createNodeScheduleGuard(receipts, writer, workflow);
		expect(await guard.invoke(create)).toContain("guard_rejected");
		for (const name of [
			"core__goal_list",
			"core__goal_progress",
			"core__work_item_query",
		]) {
			const result = contextResult(name);
			if (result)
				receipts.observe(
					name,
					name === "core__work_item_query"
						? { statuses: [...OPEN_STATUSES] }
						: {},
					result,
				);
		}
		receipts.observe(
			"core__schedule_list",
			{ purpose: "different" },
			{ ok: true, value: { schedules: [] } },
		);
		expect(await guard.invoke(create)).toContain("guard_rejected");
		receipts.observe(
			"core__schedule_list",
			{ purpose: create.purpose },
			{ ok: true, value: { schedules: [] } },
		);
		receipts.observe(
			"core__knowledge_read",
			{ id: workflow[0]?.guidanceId },
			{
				ok: true,
				value: {
					mode: "get",
					entries: [{ id: "different", content: "Not the selected card" }],
				},
			},
		);
		expect(await guard.invoke(create)).toContain("guard_rejected");
		expect(writes).toBe(0);
		receipts.observe(
			"core__knowledge_read",
			{ id: workflow[0]?.guidanceId },
			{
				ok: true,
				value: {
					mode: "get",
					truncated: true,
					entries: [{ id: workflow[0]?.guidanceId, content: "Only a preview" }],
				},
			},
		);
		expect(await guard.invoke(create)).toContain("guard_rejected");
		expect(writes).toBe(0);
		receipts.observe(
			"core__knowledge_read",
			{ id: workflow[0]?.guidanceId },
			{
				ok: true,
				value: {
					mode: "get",
					entries: [
						{ id: workflow[0]?.guidanceId, content: "Current full card" },
					],
				},
			},
		);
		expect(await guard.invoke(create)).toBe("created");
		expect(writes).toBe(1);
		expect(
			await guard.invoke({ ...create, graphId: "langgraph:missing" }),
		).toContain("guard_rejected");
		expect(writes).toBe(1);
	});
});
