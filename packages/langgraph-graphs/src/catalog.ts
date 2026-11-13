// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/catalog`
 * Purpose: Single source of truth for LangGraph graph definitions.
 * Scope: Exports the node-runtime catalog (LANGGRAPH_CATALOG): `cogni`, `work-prioritizer` and `work-closeout`. Does NOT import from src/.
 * Invariants:
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: Graph definitions live here, not in bootstrap
 *   - PACKAGES_NO_SRC_IMPORTS: No imports from src/**
 *   - Adding a graph = add entry here, not touch bootstrap
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @public
 */

import {
  COGNI_DECIDE_PROMPT,
  COGNI_DECIDE_TOOL_IDS,
} from "./graphs/mission/cogni-decide";
import { createMissionGraph } from "./graphs/mission/graph";
import {
  createNodeOperatorGraph,
  NODE_OPERATOR_TOOL_IDS,
} from "./graphs/node-operator/graph";
import { nodeOperatorCatalogPrompt } from "./graphs/node-operator/prompts";
import {
  createWorkCloseoutGraph,
  WORK_CLOSEOUT_GRAPH_NAME,
} from "./graphs/work-closeout/graph";
import { WORK_CLOSEOUT_SYSTEM_PROMPT } from "./graphs/work-closeout/prompts";
import {
  VCS_COMMIT_CONTAINS,
  VCS_PR_READ,
} from "./graphs/work-closeout/receipts";
import { WORK_PRIORITIZER_GRAPH_NAME } from "./graphs/work-prioritizer/graph";
import type { WorkflowGuidance } from "./graphs/node-operator/guidance";
import type { CreateReactAgentGraphOptions } from "./graphs/types";
import type { CreateGraphFn } from "./inproc/types";

/** Internal agent principal slugs seeded by the node migration (`agent_principals.slug`). */
export const NODE_AI_PRINCIPAL = "node-ai" as const;
export const PRIORITIZER_PRINCIPAL = "prioritizer" as const;

/**
 * Catalog entry shape.
 *
 * Per TOOL_CATALOG_IS_CANONICAL: graphs reference tools by ID, not by BoundTool.
 * Providers resolve tools from TOOL_CATALOG using these IDs.
 */
export interface CatalogEntry {
  /** Canonical full graph card, required before the coordinator schedules this workflow. */
  readonly guidanceId?: string;
  /** Trusted catalog program assignment; routes mission-engine graphs to the cogni engine. */
  readonly program?: "cogni" | "work-review" | "work-closeout";
  /**
   * Recurring duty this workflow can own. The node operator reads it to decide, from goals and evidence,
   * which jobs to keep: no duty is named in the operator prompt. `purpose` is the stable job purpose.
   */
  readonly duty?: {
    readonly purpose: string;
    readonly serves: string;
    readonly neededWhen: string;
  };
  readonly displayName: string;
  readonly description: string;
  /**
   * Internal agent principal slug this graph acts as (an `agent_principals` row). A graph with no
   * principal gets no scoped tool; a slug with no seed row denies the run before any tool runs.
   */
  readonly principal?: string;
  /** Native tool IDs this graph may use. Providers resolve from TOOL_CATALOG. */
  readonly toolIds: readonly string[];
  /** MCP server names whose tools this graph may use. Empty = no MCP tools. */
  readonly mcpServerIds?: readonly string[];
  readonly graphFactory: CreateGraphFn;
  /** Optional system prompt for mission-engine graphs (catalog-driven, not hardcoded). */
  readonly systemPrompt?: string;
  /**
   * Graph-owned run report (PURE_GRAPH_FACTORY): the graph returns `structuredResponse.telemetry` (flat,
   * safe to log). The provider logs it as `event` (a registered event name) and echoes it onto the run
   * stream as one GRAPH_REPORT_OPEN…GRAPH_REPORT_CLOSE text delta.
   */
  readonly report?: GraphReportDecl;
}

/** CatalogEntry.report: the registered event name for the graph's telemetry. */
export interface GraphReportDecl {
  readonly event: string;
}

/** Delimiters of a catalog-declared run report on the run stream (CatalogEntry.report). */
export const GRAPH_REPORT_OPEN = "<graph_report>";
export const GRAPH_REPORT_CLOSE = "</graph_report>";

/**
 * Log lines for a catalog-declared report: one `report.event` from `structuredOutput.telemetry`. Empty when
 * the output carries none.
 * Pure: the provider owns the logger and only calls this (CATALOG_REPORT_SEAM).
 */
export function graphReportLogFields(
  report: GraphReportDecl,
  runId: string,
  structuredOutput: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? [{ event: report.event, runId, ...telemetry }]
    : [];
}

/** The stream echo of a catalog-declared report (`<graph_report>{telemetry}</graph_report>`), or null. */
export function graphReportDelta(
  structuredOutput: Record<string, unknown> | undefined,
): string | null {
  const telemetry = structuredOutput?.telemetry;
  return telemetry && typeof telemetry === "object"
    ? `\n${GRAPH_REPORT_OPEN}${JSON.stringify(telemetry)}${GRAPH_REPORT_CLOSE}\n`
    : null;
}

export type LangGraphCatalog = Readonly<Record<string, CatalogEntry>>;

/** Bind guidance from the trusted registry; return the native compiled graph directly. */
function createCatalogCogniGraph(opts: CreateReactAgentGraphOptions) {
  return createNodeOperatorGraph({ ...opts, workflowGuidance: catalogWorkflowGuidance() });
}
function catalogWorkflowGuidance(): WorkflowGuidance[] {
  return Object.entries(NODE_LANGGRAPH_CATALOG).flatMap(([id, entry]: [string, CatalogEntry]) =>
    entry.guidanceId ? [{ graphId: `langgraph:${id}`, guidanceId: entry.guidanceId }] : [],
  );
}
createCatalogCogniGraph.createRunHooks = createNodeOperatorGraph.createRunHooks;

/**
 * Node runtime LangGraph catalog — the graphs every sovereign node runs: `cogni` (the node
 * operator) and `work-prioritizer` (the scheduled scoring program).
 *
 * To add a new graph:
 * 1. Create graph factory in graphs/<name>/graph.ts
 * 2. Add entry here with boundTools and graphFactory
 * 3. Bootstrap automatically picks it up (no changes needed there)
 *
 * Per CATALOG_SINGLE_SOURCE_OF_TRUTH: graphs are defined here, not in bootstrap.
 * Operator lifecycle graphs (PR review and management) are operator services, not node graphs.
 */
export const NODE_LANGGRAPH_CATALOG = {
  /**
   * Work Prioritizer (story.5108 / story.5116) — every node runs it: a node schedules
   * `langgraph:work-prioritizer` in its own repo-spec, and a node with no approved goals changes
   * nothing. Its program identity is "work-review"; it uses the shared triage profile
   * and must not file a reflexive EDO.
   */
  [WORK_PRIORITIZER_GRAPH_NAME]: {
    guidanceId: "graph-work-prioritizer",
    displayName: "Work Prioritizer",
    description: "Triages open work: scores, goal links, status routes and cancels, or changes nothing",
    principal: PRIORITIZER_PRINCIPAL,
    toolIds: COGNI_DECIDE_TOOL_IDS,
    graphFactory: createMissionGraph,
    systemPrompt: COGNI_DECIDE_PROMPT,
    program: "work-review",
    duty: {
      purpose: "node-work-triage",
      serves: "Prioritize: every active goal's open work stays scored, goal-linked and routed",
      neededWhen: "open work is unscored, untriaged or scored before a goal or KPI changed",
    },
    report: { event: "ai.work_prioritizer.cycle" },
  },
  /**
   * Work Closeout (story.0035) closes items whose merged pull request is live in the running build, marking them
   * done and deployVerified with the pull request as evidence. It acts as the `prioritizer` principal: the node's
   * work-ledger steward, which already holds `work_item:transition`.
   */
  [WORK_CLOSEOUT_GRAPH_NAME]: {
    displayName: "Work Closeout",
    description:
      "Closes items whose merged pull request is live in this build: done and deployVerified, or changes nothing",
    principal: PRIORITIZER_PRINCIPAL,
    toolIds: [
      "core__work_item_query",
      "core__work_item_read",
      VCS_PR_READ,
      VCS_COMMIT_CONTAINS,
      "core__work_item_update",
      "core__get_current_time",
    ],
    graphFactory: createWorkCloseoutGraph,
    systemPrompt: WORK_CLOSEOUT_SYSTEM_PROMPT,
    program: "work-closeout",
    duty: {
      purpose: "node-work-closeout",
      serves: "goal-ai-work-converges: shipped work is counted as validated",
      neededWhen: "items in needs_closeout or needs_merge have a merged pull request",
    },
    report: { event: "ai.work_closeout.cycle" },
  },
  cogni: {
    guidanceId: "graph-cogni",
    displayName: "Cogni",
    principal: NODE_AI_PRINCIPAL,
    description:
      "Node operator: reads goals and work, manages authorized recurring jobs, and verifies effects",
    toolIds: NODE_OPERATOR_TOOL_IDS,
    graphFactory: createCatalogCogniGraph,
    get systemPrompt(): string {
      return nodeOperatorCatalogPrompt(
        Object.entries(NODE_LANGGRAPH_CATALOG).map(([id, entry]) => ({
          id: `langgraph:${id}`,
          description: entry.description,
          toolIds: entry.toolIds,
          mcpServerIds: (entry as CatalogEntry).mcpServerIds ?? [],
          duty: (entry as CatalogEntry).duty ?? null,
        })),
      );
    },
    program: "cogni",
  },
} as const;

/**
 * Node-runtime catalog.
 */
export const LANGGRAPH_CATALOG: LangGraphCatalog = NODE_LANGGRAPH_CATALOG;

/**
 * Type helper for catalog entry lookup (short names).
 */
export type LangGraphCatalogKeys = keyof typeof NODE_LANGGRAPH_CATALOG;

/**
 * LangGraph provider ID for namespacing.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Fully-qualified graph IDs satisfying GraphId from @cogni/ai-core.
 * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
 */
export const NODE_LANGGRAPH_GRAPH_IDS = {
  cogni: `${LANGGRAPH_PROVIDER_ID}:cogni`,
  "work-prioritizer": `${LANGGRAPH_PROVIDER_ID}:${WORK_PRIORITIZER_GRAPH_NAME}`,
  "work-closeout": `${LANGGRAPH_PROVIDER_ID}:${WORK_CLOSEOUT_GRAPH_NAME}`,
} as const;

/**
 * Node-runtime graph IDs.
 */
export const LANGGRAPH_GRAPH_IDS = NODE_LANGGRAPH_GRAPH_IDS;

/**
 * Union type of all valid LangGraph graph IDs.
 */
export type LangGraphGraphId =
  (typeof LANGGRAPH_GRAPH_IDS)[keyof typeof LANGGRAPH_GRAPH_IDS];

/**
 * Default graph ID.
 */
export const DEFAULT_LANGGRAPH_GRAPH_ID = LANGGRAPH_GRAPH_IDS.cogni;
