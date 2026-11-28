// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc.provider`
 * Purpose: This node's adapter over the shared in-process LangGraph provider (`@cogni/langgraph-graphs/inproc`).
 * Scope: Binds the node's ports (billed completion adapter, execution scope, logger, trace id, model allow-list) to the package provider. Holds no guard, audience, denial or catalog logic; a test fails if it grows any.
 * Invariants:
 *   - NO_LOCAL_PROVIDER_LOGIC: the tool guard, principal lock, audience filter, terminal denial, MCP resolution and secret mask live in the package; this file only wires
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - NO_LANGCHAIN_IN_SRC: no @langchain imports
 * Side-effects: none at import
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @internal
 */

import type { ToolSourcePort } from "@cogni/ai-core";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG, type LangGraphCatalog } from "@cogni/langgraph-graphs";
import {
  type AgentAuthorityPort,
  type CodingCallerPolicy,
  type CompletionUnitPort,
  createLangGraphInProcProvider,
  createNodeCatalog,
  type Persistence,
  type ProviderLogger,
  type RunScopePort,
  type SourceContext,
} from "@cogni/langgraph-graphs/inproc";
import { trace } from "@opentelemetry/api";
import { getExecutionScope, runInScope } from "@/adapters/server/ai/execution-scope";
import type { ExecutionContext, GraphExecutorPort, GraphRunRequest, GraphRunResult, LlmToolDefinition } from "@/ports";
import { isModelAllowed } from "@/shared/ai/model-catalog.server";
import { makeLogger } from "@/shared/observability";

export { resolveNodeSourceContext } from "@cogni/langgraph-graphs/inproc";

export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/** The node's billed completion adapter (`InProcCompletionUnitAdapter`), seen as the package port. */
export type CompletionUnitAdapter = CompletionUnitPort<LlmToolDefinition>;

/** The node's tool-authority wiring (bootstrap/agent-authority.ts), seen structurally. */
export type ProviderAgentAuthority = AgentAuthorityPort;

const nodeRunScope: RunScopePort = {
  current() {
    const scope = getExecutionScope();
    return {
      subjectUserId: scope.subjectUserId,
      accountId: scope.billing.billingAccountId,
      abortSignal: scope.abortSignal,
      runAs: (identity, fn) =>
        runInScope(
          {
            ...scope,
            runId: identity.runId,
            ...(identity.principalId ? { principalId: identity.principalId } : {}),
            ...(identity.subjectUserId ? { subjectUserId: identity.subjectUserId } : {}),
          },
          fn,
        ),
    };
  },
};

export class LangGraphInProcProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly provider: GraphExecutorPort;

  constructor(
    adapter: CompletionUnitAdapter,
    toolSource: ToolSourcePort,
    getMcpToolSource: () => Promise<ToolSourcePort | null> = () => Promise.resolve(null),
    nodeBundle: readonly CatalogBoundTool[] = [],
    sourceContext?: (required: boolean) => Promise<SourceContext>,
    getPersistence?: () => Promise<Persistence>,
    authority?: ProviderAgentAuthority,
    /** Graphs this node adds to the package catalog (an id the package owns throws). */
    nodeCatalog: LangGraphCatalog = {},
    coding?: CodingCallerPolicy,
    log: ProviderLogger = makeLogger({ component: "LangGraphInProcProvider" }),
  ) {
    this.provider = createLangGraphInProcProvider<LlmToolDefinition>({
      catalog: createNodeCatalog(LANGGRAPH_CATALOG, { add: nodeCatalog }),
      completion: adapter,
      tools: toolSource,
      toolBundle: nodeBundle,
      scope: nodeRunScope,
      log,
      mcpTools: getMcpToolSource,
      isChildModelAllowed: isModelAllowed,
      traceId: () => trace.getActiveSpan()?.spanContext().traceId,
      ...(sourceContext && { sourceContext }),
      ...(getPersistence && { persistence: getPersistence }),
      ...(authority && { authority }),
      ...(coding && { coding }),
    });
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    return this.provider.runGraph(req, ctx);
  }
}
