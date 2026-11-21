import type { AiEvent } from "@cogni/ai-core";
import {
	goalListContract,
	knowledgeReadContract,
	webSearchContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
	graphReportDelta,
	graphReportLogFields,
	LANGGRAPH_CATALOG,
} from "../../../src/catalog";
import { createMissionResearchGraph } from "../../../src/graphs/mission-research/graph";
import { ResearchReceipts } from "../../../src/graphs/mission-research/receipts";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

describe("mission research public boundary", () => {
	it("rejects a missing trusted mission before making a model call", async () => {
		let calls = 0;
		const completionFn: CompletionFn = () => {
			calls++;
			return {
				stream: (async function* (): AsyncIterable<AiEvent> {})(),
				final: Promise.resolve({
					ok: true as const,
					content: "done",
					finishReason: "stop" as const,
				}),
			};
		};
		const entry = LANGGRAPH_CATALOG["mission-research"];
		expect(entry).toBeDefined();
		if (!entry) return;
		const run = createInProcGraphRunner({
			program: "mission-research",
			sourceContext: { nodeId: "test", origin: "https://example.org" },
			createGraph: entry.graphFactory,
			completionFn,
			createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
			toolContracts: [],
			request: {
				runId: "identity",
				messages: [{ role: "user", content: "research" }],
				configurable: { model: "test", toolIds: [] },
			},
		});
		for await (const _ of run.stream) {
			/* drain */
		}
		expect((await run.final).ok).toBe(false);
		expect(calls).toBe(0);
	});
});

describe("report and direct factory boundaries", () => {
	it("keeps default report echoes and makes the research packet log-only", () => {
		const output = { telemetry: { status: "incomplete", toolCalls: 2 } };
		const report = LANGGRAPH_CATALOG["mission-research"]?.report;
		expect(report).toBeDefined();
		if (!report) throw new Error("missing report");
		expect(graphReportDelta(output, report)).toBeNull();
		expect(graphReportDelta(output)).toContain("<graph_report>");
		expect(
			graphReportDelta(output, { event: report.event, echoToStream: true }),
		).toBe(graphReportDelta(output));
		expect(graphReportLogFields(report, "run", output)).toEqual([
			{ event: "ai.mission_research.cycle", runId: "run", ...output.telemetry },
		]);
	});
	it.each([
		{ nodeId: "test", origin: "https://example.org" },
		{
			nodeId: "test",
			mission: { content: "mission", sourceRef: "test", buildSha: null },
		},
	])(
		"rejects direct factory runs with missing mission or origin",
		async (sourceContext) => {
			let calls = 0;
			const completionFn: CompletionFn = () => {
				calls++;
				throw new Error("unexpected model call");
			};
			const run = createInProcGraphRunner({
				sourceContext,
				createGraph: createMissionResearchGraph,
				completionFn,
				createToolExecFn: (): ToolExecFn => async () => ({
					ok: true,
					value: {},
				}),
				toolContracts: [],
				request: {
					runId: "direct",
					messages: [{ role: "user", content: "research" }],
					configurable: { model: "test", toolIds: [] },
				},
			});
			for await (const _ of run.stream) {
				/* drain */
			}
			expect((await run.final).ok).toBe(false);
			expect(calls).toBe(0);
		},
	);
});

describe("native task limiter", () => {
	it("returns an incomplete handoff when five task calls are attempted together", async () => {
		let turn = 0;
		const completionFn: CompletionFn = () => {
			turn++;
			const toolCalls =
				turn === 1
					? Array.from({ length: 5 }, (_, i) => ({
							id: `task-${i}`,
							type: "function" as const,
							function: {
								name: "task",
								arguments: JSON.stringify({
									subagent_type: "critic",
									description: "{}",
								}),
							},
						}))
					: undefined;
			return {
				stream: (async function* (): AsyncIterable<AiEvent> {})(),
				final: Promise.resolve({
					ok: true as const,
					content: toolCalls ? "" : "{}",
					...(toolCalls ? { toolCalls } : {}),
					finishReason: toolCalls ? ("tool_calls" as const) : ("stop" as const),
				}),
			};
		};
		const entry = LANGGRAPH_CATALOG["mission-research"];
		if (!entry) throw new Error("missing graph");
		const run = createInProcGraphRunner({
			program: "mission-research",
			sourceContext: {
				nodeId: "test",
				origin: "https://example.org",
				mission: { content: "A mission", sourceRef: "test", buildSha: null },
			},
			createGraph: entry.graphFactory,
			completionFn,
			createToolExecFn: (): ToolExecFn => async () => ({ ok: true, value: {} }),
			toolContracts: [],
			request: {
				runId: "excess",
				messages: [{ role: "user", content: "research" }],
				configurable: { model: "test", toolIds: [] },
			},
		});
		const events: AiEvent[] = [];
		for await (const event of run.stream) events.push(event);
		const result = await run.final;
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.content ?? "{}").status).toBe("incomplete");
		expect(JSON.parse(result.content ?? "{}").reasons).toContain(
			"excess_task_attempt",
		);
		expect(
			events.filter((event) => event.type === "assistant_final"),
		).toHaveLength(1);
	});
});

describe("native child isolation", () => {
	it("keeps root scratch out of the critic and critic writes out of root", async () => {
		let turn = 0;
		let childInput = "";
		let rootAfterRead = "";
		let fingerprint = "";
		const url = "https://evidence.example/source";
		const draft = {
			missionScope: "mission",
			decision: "decision",
			sources: [{ url }],
			atoms: [
				{
					id: "a",
					action: "create",
					domain: "strategy",
					title: "t",
					useWhen: "use",
					content: "claim",
					relationships: [],
					ownerId: null,
					sourceUrls: [url],
				},
			],
			principles: [{ id: "p", content: "claim", sourceUrls: [url] }],
			contradictions: [],
			unknowns: [],
			critiqueResolutions: [],
			kpiHypotheses: [
				{
					outcome: "outcome",
					metric: "metric",
					rationale: "rationale",
					source: "source",
					window: "7d",
					guardrails: ["safety"],
					gamingRisk: "risk",
					measurementGap: "gap",
				},
			],
		};
		const completionFn: CompletionFn = (req) => {
			turn++;
			const call = (id: string, name: string, args: unknown) => ({
				id,
				type: "function" as const,
				function: { name, arguments: JSON.stringify(args) },
			});
			let calls: ReturnType<typeof call>[] | undefined;
			let content = "";
			if (turn === 1)
				calls = [
					call("goals", "core__goal_list", {}),
					call("g1", "core__knowledge_read", {
						id: "knowledge-syntropy-expert",
					}),
					call("g2", "core__knowledge_read", { id: "mission-loop-expert" }),
					call("w1", "core__web_search", {
						query: "q",
						maxResults: 3,
						includeRawContent: true,
					}),
				];
			else if (turn === 2)
				calls = [
					call("scratch", "write_file", {
						file_path: "/root-canary.txt",
						content: `ROOT_PRIVATE_CANARY${"x".repeat(128 * 1024)}`,
					}),
				];
			else if (turn === 3)
				calls = [
					call("critic", "task", {
						subagent_type: "critic",
						description: JSON.stringify(draft),
					}),
				];
			else if (turn === 4) {
				childInput = JSON.stringify(req.messages);
				fingerprint = childInput.match(/[a-f0-9]{64}/)?.[0] ?? "";
				calls = [
					call("child-write", "write_file", {
						file_path: "/child-canary.txt",
						content: "CHILD_PRIVATE_CANARY",
					}),
				];
			} else if (turn === 5)
				content = JSON.stringify({
					fingerprint,
					explanation: "The evidence and constraints were reviewed carefully.",
					findings: [],
				});
			else if (turn === 6)
				calls = [
					call("root-read", "read_file", { file_path: "/child-canary.txt" }),
				];
			else {
				rootAfterRead = JSON.stringify(req.messages);
				content = JSON.stringify(draft);
			}
			return {
				stream: (async function* (): AsyncIterable<AiEvent> {})(),
				final: Promise.resolve({
					ok: true as const,
					content,
					...(calls ? { toolCalls: calls } : {}),
					finishReason: calls ? ("tool_calls" as const) : ("stop" as const),
				}),
			};
		};
		const entry = LANGGRAPH_CATALOG["mission-research"];
		if (!entry) throw new Error("missing graph");
		const exec: ToolExecFn = async (name, args) =>
			name === "core__goal_list"
				? { ok: true, value: { goals: [] } }
				: name === "core__knowledge_read"
					? {
							ok: true,
							value: {
								mode: "get",
								entries: [
									{
										id: (args as { id: string }).id,
										domain: "meta",
										content: "guidance",
									},
								],
							},
						}
					: {
							ok: true,
							value: {
								query: "q",
								partial: false,
								results: [
									{
										url,
										title: "source",
										content: "snippet",
										rawContent: "actual passage",
										rawContentState: "available",
									},
								],
							},
						};
		const run = createInProcGraphRunner({
			program: "mission-research",
			sourceContext: {
				nodeId: "test",
				origin: "https://node.example",
				mission: { content: "A mission", sourceRef: "test", buildSha: null },
				governingIndex: [
					{
						id: "strategy-owner",
						domain: "strategy",
						entryType: "reference",
						useWhen: "research",
					},
				],
			},
			createGraph: entry.graphFactory,
			completionFn,
			createToolExecFn: () => exec,
			toolContracts: [
				goalListContract,
				knowledgeReadContract,
				webSearchContract,
			],
			request: {
				runId: "isolation",
				messages: [{ role: "user", content: "research" }],
				configurable: { model: "test", toolIds: [...entry.toolIds] },
			},
		});
		for await (const _ of run.stream) {
			/* drain */
		}
		const result = await run.final;
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.content ?? "{}").status).toBe("complete");
		expect(result.structuredOutput).toEqual(JSON.parse(result.content ?? "{}"));
		expect(fingerprint).toHaveLength(64);
		expect(childInput).not.toContain("ROOT_PRIVATE_CANARY");
		expect(rootAfterRead).not.toContain("CHILD_PRIVATE_CANARY");
	});
});

describe("host evidence and critique binding", () => {
	it("rejects invented source references and unchanged critical revisions", () => {
		const receipts = new ResearchReceipts("https://node.example");
		receipts.observe("core__goal_list", {}, { goals: [] });
		for (const id of ["knowledge-syntropy-expert", "mission-loop-expert"])
			receipts.observe(
				"core__knowledge_read",
				{ id },
				{ mode: "get", entries: [{ id, domain: "meta", content: "guidance" }] },
			);
		receipts.domains.add("strategy");
		const url = "https://evidence.example/doc";
		receipts.observe(
			"core__web_search",
			{},
			{
				results: [
					{ url, rawContent: "actual passage", rawContentState: "available" },
				],
			},
		);
		const draft = {
			missionScope: "mission",
			decision: "decision",
			sources: [{ url }],
			atoms: [
				{
					id: "a",
					action: "create",
					domain: "strategy",
					title: "t",
					useWhen: "use",
					content: "original",
					relationships: [],
					ownerId: null,
					sourceUrls: [url],
				},
			],
			principles: [{ id: "p", content: "original", sourceUrls: [url] }],
			contradictions: [],
			unknowns: [],
			critiqueResolutions: [],
			kpiHypotheses: [
				{
					outcome: "outcome",
					metric: "metric",
					rationale: "rationale",
					source: "source",
					window: "7d",
					guardrails: ["safety"],
					gamingRisk: "risk",
					measurementGap: "gap",
				},
			],
		};
		for (const field of ["source", "window", "guardrails"] as const) {
			const incomplete = structuredClone(draft);
			delete (
				incomplete.kpiHypotheses[0] as Partial<
					(typeof draft.kpiHypotheses)[number]
				>
			)[field];
			const separate = new ResearchReceipts("https://node.example");
			separate.domains.add("strategy");
			separate.observe(
				"core__web_search",
				{},
				{
					results: [
						{ url, rawContent: "actual passage", rawContentState: "available" },
					],
				},
			);
			expect(
				separate.prepare(JSON.stringify(incomplete), "task-missing"),
			).toBeUndefined();
		}
		const assignment = receipts.prepare(JSON.stringify(draft), "task-1");
		expect(assignment).toBeDefined();
		const fingerprint = JSON.parse(assignment ?? "{}").fingerprint;
		receipts.complete(
			JSON.stringify({
				fingerprint,
				explanation: "This critique identifies a material gap.",
				findings: [
					{
						id: "f1",
						claimIds: ["p"],
						severity: "critical",
						explanation: "unsupported",
					},
				],
			}),
		);
		const unchanged = {
			...draft,
			critiqueResolutions: [{ findingId: "f1", action: "revised" }],
		};
		expect(
			receipts.project(JSON.stringify(unchanged)).output.reasons,
		).toContain("invalid_resolution");
		const forged = {
			...draft,
			sources: [{ url: "https://invented.example/" }],
		};
		expect(receipts.project(JSON.stringify(forged)).output.reasons).toContain(
			"unverified_packet",
		);
	});
});

describe("critic and evidence failures", () => {
	const setup = () => {
		const r = new ResearchReceipts("https://node.example");
		r.domains.add("strategy");
		r.observe("core__goal_list", {}, { goals: [] });
		for (const id of ["knowledge-syntropy-expert", "mission-loop-expert"])
			r.observe(
				"core__knowledge_read",
				{ id },
				{ mode: "get", entries: [{ id, domain: "meta", content: "guidance" }] },
			);
		const url = "https://evidence.example/doc";
		r.observe(
			"core__web_search",
			{},
			{
				results: [
					{ url, rawContent: "actual passage", rawContentState: "available" },
				],
			},
		);
		const draft = {
			missionScope: "mission",
			decision: "decision",
			sources: [{ url }],
			atoms: [
				{
					id: "a",
					action: "create",
					domain: "strategy",
					title: "t",
					useWhen: "use",
					content: "claim",
					relationships: [],
					ownerId: null,
					sourceUrls: [url],
				},
			],
			principles: [{ id: "p", content: "claim", sourceUrls: [url] }],
			contradictions: [],
			unknowns: [],
			critiqueResolutions: [],
			kpiHypotheses: [
				{
					outcome: "outcome",
					metric: "metric",
					rationale: "rationale",
					source: "source",
					window: "7d",
					guardrails: ["safety"],
					gamingRisk: "risk",
					measurementGap: "gap",
				},
			],
		};
		const assignment = r.prepare(JSON.stringify(draft), "actual-call");
		return {
			r,
			draft,
			fingerprint: JSON.parse(assignment ?? "{}").fingerprint as string,
		};
	};
	it.each([
		"",
		"{}",
		JSON.stringify({
			fingerprint: "wrong",
			explanation: "A meaningful critical explanation.",
			findings: [],
		}),
		"x".repeat(9000),
	])(
		"does not accept a missing, malformed, mismatched or oversized critique",
		(critique) => {
			const { r, draft } = setup();
			r.complete(critique);
			expect(r.project(JSON.stringify(draft)).output.status).toBe("incomplete");
		},
	);
	it("refuses a refine operation for an owner not read this run", () => {
		const { r, draft } = setup();
		const forged = {
			...draft,
			atoms: [
				{ ...draft.atoms[0], action: "refine", ownerId: "fabricated-owner" },
			],
		};
		expect(r.prepare(JSON.stringify(forged), "task-2")).toBeUndefined();
		expect(r.reasons.has("unverified_draft")).toBe(true);
	});
	it("retains useful draft on step exhaustion", () => {
		const { r, draft } = setup();
		const handoff = r.project("", "step_budget").output;
		expect(handoff.status).toBe("incomplete");
		expect(handoff.reasons).toContain("step_budget");
		expect(handoff.packet).toEqual(draft);
	});
	it("does not accept oversized or unobserved evidence", () => {
		const { r, draft } = setup();
		r.observe(
			"core__web_search",
			{},
			{
				results: [
					{
						url: "https://large.example",
						rawContent: "x".repeat(50000),
						rawContentState: "available",
					},
				],
			},
		);
		const forged = { ...draft, sources: [{ url: "https://large.example" }] };
		expect(r.project(JSON.stringify(forged)).output.reasons).toContain(
			"unverified_packet",
		);
	});
});

describe("child recursion bound", () => {
	it("stops a nonterminating critic despite the parent's 100-step limit", async () => {
		let rootTurns = 0;
		let childTurns = 0;
		const url = "https://evidence.example/source";
		const draft = {
			missionScope: "mission",
			decision: "decision",
			sources: [{ url }],
			atoms: [
				{
					id: "a",
					action: "create",
					domain: "strategy",
					title: "t",
					useWhen: "use",
					content: "claim",
					relationships: [],
					ownerId: null,
					sourceUrls: [url],
				},
			],
			principles: [{ id: "p", content: "claim", sourceUrls: [url] }],
			contradictions: [],
			unknowns: [],
			critiqueResolutions: [],
			kpiHypotheses: [
				{
					outcome: "outcome",
					metric: "metric",
					rationale: "rationale",
					source: "source",
					window: "7d",
					guardrails: ["safety"],
					gamingRisk: "risk",
					measurementGap: "gap",
				},
			],
		};
		const call = (id: string, name: string, args: unknown) => ({
			id,
			type: "function" as const,
			function: { name, arguments: JSON.stringify(args) },
		});
		const completionFn: CompletionFn = (req) => {
			const names = (req.tools ?? []).map((tool) => {
				const t = tool as { name?: string; function?: { name?: string } };
				return t.function?.name ?? t.name;
			});
			const root = names.includes("task");
			let calls: ReturnType<typeof call>[] | undefined;
			if (root && ++rootTurns === 1)
				calls = [
					call("goals", "core__goal_list", {}),
					call("g1", "core__knowledge_read", {
						id: "knowledge-syntropy-expert",
					}),
					call("g2", "core__knowledge_read", { id: "mission-loop-expert" }),
					call("web", "core__web_search", {
						query: "q",
						includeRawContent: true,
					}),
				];
			else if (root && rootTurns === 2)
				calls = [
					call("task", "task", {
						subagent_type: "critic",
						description: JSON.stringify(draft),
					}),
				];
			else if (!root) {
				childTurns++;
				calls = [
					call(`loop-${childTurns}`, "write_file", {
						file_path: "/loop.txt",
						content: "loop",
					}),
				];
			}
			return {
				stream: (async function* (): AsyncIterable<AiEvent> {})(),
				final: Promise.resolve({
					ok: true as const,
					content: calls ? "" : JSON.stringify(draft),
					...(calls ? { toolCalls: calls } : {}),
					finishReason: calls ? ("tool_calls" as const) : ("stop" as const),
				}),
			};
		};
		const entry = LANGGRAPH_CATALOG["mission-research"];
		if (!entry) throw new Error("missing graph");
		const exec: ToolExecFn = async (name, args) =>
			name === "core__goal_list"
				? { ok: true, value: { goals: [] } }
				: name === "core__knowledge_read"
					? {
							ok: true,
							value: {
								mode: "get",
								entries: [
									{
										id: (args as { id: string }).id,
										domain: "meta",
										content: "guidance",
									},
								],
							},
						}
					: {
							ok: true,
							value: {
								results: [
									{ url, rawContent: "passage", rawContentState: "available" },
								],
							},
						};
		const run = createInProcGraphRunner({
			program: "mission-research",
			sourceContext: {
				nodeId: "test",
				origin: "https://node.example",
				mission: { content: "A mission", sourceRef: "test", buildSha: null },
				governingIndex: [
					{
						id: "owner",
						domain: "strategy",
						entryType: "reference",
						useWhen: "research",
					},
				],
			},
			createGraph: entry.graphFactory,
			completionFn,
			createToolExecFn: () => exec,
			toolContracts: [
				goalListContract,
				knowledgeReadContract,
				webSearchContract,
			],
			request: {
				runId: "bounded-child",
				messages: [{ role: "user", content: "research" }],
				configurable: { model: "test", toolIds: [...entry.toolIds] },
			},
		});
		for await (const _ of run.stream) {
			/* drain */
		}
		const result = await run.final;
		expect(result.ok).toBe(true);
		expect(childTurns).toBeGreaterThan(1);
		expect(childTurns).toBeLessThanOrEqual(30);
		expect(JSON.parse(result.content ?? "{}").status).toBe("incomplete");
	});
});
