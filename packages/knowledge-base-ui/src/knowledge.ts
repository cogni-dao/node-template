// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge`
 * Purpose: Subpath entry for the bounded knowledge Browse and Graph capability (task.0059).
 * Scope: Re-exports only. Kept off the root entry so work-board-only adopters never need the optional `@cogni/knowledge-store` peer; everything here imports `@cogni/knowledge-store/contracts` (>= 0.12.0). The WebGL renderer lives on `./graph-3d`.
 * Invariants: Requires the host's `QueryClientProvider` (react-query 5).
 * Side-effects: none
 * Links: task.0059
 * @public
 */

export {
  KNOWLEDGE_FILTER_VALUE_LENGTH_MAX,
  KNOWLEDGE_FILTER_VALUES_MAX,
  KNOWLEDGE_GRAPH_FOCUS_LINKS_MAX,
  KNOWLEDGE_GRAPH_NODES_MAX,
  KNOWLEDGE_GRAPH_OVERVIEW_MAX,
  KNOWLEDGE_QUERY_PREFIX,
  KNOWLEDGE_SEARCH_LENGTH_MAX,
  KNOWLEDGE_WINDOW_MAX,
  type KnowledgeReadOperation,
  type KnowledgeWindowFetcher,
  knowledgeBrowseKey,
  knowledgeOverviewKey,
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
} from "./knowledge-browse.js";
export {
  KNOWLEDGE_CITATION_COLORS,
  KnowledgeGraph,
  type KnowledgeGraphColorMode,
  type KnowledgeGraphProps,
  type KnowledgeGraphRendererProps,
  knowledgeConfidenceColor,
  knowledgeDomainColor,
} from "./knowledge-graph.js";
export {
  type UseKnowledgeRevisionResult,
  useKnowledgeRevision,
} from "./use-knowledge-revision.js";
export {
  type UseKnowledgeBrowseOptions,
  type UseKnowledgeOverviewOptions,
  type UseKnowledgeWindowsResult,
  useKnowledgeBrowse,
  useKnowledgeOverview,
} from "./use-knowledge-windows.js";
export {
  type KnowledgeCitationEndpoint,
  type KnowledgeCitationFetcher,
  type KnowledgeCitationLink,
  type KnowledgeCitationPage,
  type KnowledgeGraphGeometry,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  knowledgeFocusGeometry,
  type UseGraphFocusOptions,
  type UseGraphFocusResult,
  useGraphFocus,
} from "./use-graph-focus.js";
