// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs`
 * Purpose: Barrel export for graph factories and shared types.
 * Scope: Graph creation functions and type definitions. Does NOT include runners (those live in src/).
 * Invariants:
 *   - Graphs are pure factories — no side effects, no env reads
 *   - All LangChain graph creation code lives here
 *   - Shared types prevent per-graph interface duplication
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants, https://node-template.cognidao.org/knowledge/agent-development
 * @public
 */

// Cogni coordinator harness
export {
	type AgentProfile,
	cogniProfile,
	createCogniGraph,
	createCogniProgram,
} from "./cogni/graph";
export { COGNI_TOOL_IDS } from "./cogni/tools";
// Shared graph types
export type {
	CreateReactAgentGraphOptions,
	GraphInvokeOptions,
	InvokableGraph,
	MessageGraphInput,
	MessageGraphOutput,
} from "./types";
// Work Prioritizer (every node, shared harness on the work-prioritizer slot, story.5108 / story.5101)
export {
	createWorkPrioritizerGraph,
	cycleTelemetry,
	type MissionLoopTelemetry,
	WORK_PRIORITIZER_GRAPH_NAME,
} from "./work-prioritizer/graph";
// Work Closeout (shared harness; closes items whose merged pull request is live, story.0035)
export {
	createWorkCloseoutGraph,
	WORK_CLOSEOUT_GRAPH_NAME,
} from "./work-closeout/graph";
