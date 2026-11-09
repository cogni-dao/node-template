// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge`
 * Purpose: Subpath entry for the knowledge Browse (bounded windows with exact totals) and whole-corpus Graph capability (task.0059).
 * Scope: Re-exports only. Kept off the root entry so work-board-only adopters never need the `@cogni/knowledge-store` peer; everything here imports `@cogni/knowledge-store/contracts` (>= 0.13.0). The WebGL renderer lives on `./graph-3d`.
 * Invariants: Requires the host's `QueryClientProvider` (react-query 5).
 * Side-effects: none
 * Links: task.0059
 * @public
 */

export {
  KNOWLEDGE_QUERY_PREFIX,
  type KnowledgeReadOperation,
  type KnowledgeWindowFetcher,
  knowledgeBrowseKey,
  knowledgeOverviewKey,
  knowledgeQueryIssue,
  knowledgeQueryToSearchParams,
  parseKnowledgeQuery,
} from "./knowledge-browse-query.js";
export {
  createKnowledgeBrowseColumns,
  DEFAULT_KNOWLEDGE_SORT,
  KNOWLEDGE_BROWSE_SORTS,
  type KnowledgeBrowseColumnDef,
  type KnowledgeBrowseColumnsOptions,
  type KnowledgeBrowseTableMeta,
  knowledgeBrowseTableStateToQuery,
} from "./knowledge-browse-columns.js";
export {
  KnowledgeBrowse,
  type KnowledgeBrowseProps,
  knowledgeWindowSummary,
} from "./knowledge-browse.js";
export {
  KNOWLEDGE_CITATION_COLORS,
  KnowledgeGraph,
  type KnowledgeGraphColorMode,
  type KnowledgeGraphEntriesSummary,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  type KnowledgeGraphProps,
  type KnowledgeGraphRenderOptions,
  type KnowledgeGraphRendererProps,
  knowledgeConfidenceColor,
  knowledgeDomainColor,
  knowledgeGraphRenderData,
} from "./knowledge-graph.js";
export {
  type KnowledgeGraphFetcher,
  knowledgeGraphNeighbors,
  type UseKnowledgeGraphOptions,
  type UseKnowledgeGraphResult,
  useKnowledgeGraph,
} from "./use-knowledge-graph.js";
export {
  type UseKnowledgeRevisionResult,
  useKnowledgeRevision,
} from "./use-knowledge-revision.js";
export {
  type UseKnowledgeBrowseOptions,
  type UseKnowledgeWindowsResult,
  useKnowledgeBrowse,
} from "./use-knowledge-windows.js";
