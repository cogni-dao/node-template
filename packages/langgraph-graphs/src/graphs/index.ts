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
 * Links: LANGGRAPH_AI.md, AGENT_DEVELOPMENT_GUIDE.md
 * @public
 */

// Cogni node-operator harness
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
