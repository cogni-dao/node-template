// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc`
 * Purpose: Barrel export for InProc graph execution.
 * Scope: Re-exports runner and types. Does NOT import from src/.
 * Invariants: PACKAGES_NO_SRC_IMPORTS
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @public
 */

export { createMemoryPersistence } from "./memory-persistence";
// Node catalog composition and the in-process provider (task.0204)
export { createNodeCatalog, type NodeCatalogChanges } from "./node-catalog";
export { INPROC_EVENTS } from "./provider/events";
export {
  createLangGraphInProcProvider,
  LANGGRAPH_INPROC_PROVIDER_ID,
} from "./provider/provider";
export { requiresInProcess } from "./provider/routing";
export { resolveNodeSourceContext } from "./provider/source-context";
export type {
  AgentAuthorityPort,
  CodingCallerPolicy,
  CompletionUnitFinal,
  CompletionUnitParams,
  CompletionUnitPort,
  InProcProviderDeps,
  Persistence,
  ProviderLogger,
  RunScope,
  RunScopePort,
  SourceContext,
} from "./provider/types";
// Runner
export { createInProcGraphRunner } from "./runner";

// Types
export type {
  CompiledGraph,
  CompletionFn,
  CompletionResult,
  CreateGraphFn,
  CreateGraphOptions,
  GraphResult,
  InProcGraphRequest,
  InProcRunnerOptions,
  Message,
  ToolExecFn,
  ToolExecResult,
} from "./types";
