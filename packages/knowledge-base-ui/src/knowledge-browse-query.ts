// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-browse-query`
 * Purpose: The bounded knowledge read contract the Browse and Graph hooks share: request encoding, cache keys, budgets and the injected fetcher shapes (task.0059).
 * Scope: Pure functions and types over `@cogni/knowledge-store/contracts` (≥ 0.12.0), which owns the query schemas and the 20-row page. No I/O.
 * Invariants:
 *   - ONE_CODEC: every request is the store schema's parse of the query, encoded with repeated keys for the exact-value arrays (`domains=a&domains=b`), so the node's route parses it back with the same schema. Nodes never hand-build these parameters.
 *   - KEY_IS_QUERY_IDENTITY: the cache key is `[...prefix, "browse" | "search" | "overview", parsedQuery]`, cursor included, so each window is its own cache entry and a new filter, sort or search is a new key.
 *   - BUDGETS_FROM_STORE: window size (20), filter values (50 × 500 chars) and search length (2000) are read from the store schemas when the module loads, never re-declared; the graph shows ≤ 20 overview atoms, ≤ 5 focus links and ≤ 26 nodes.
 * Side-effects: none
 * Links: task.0059, packages/knowledge-store/src/contracts.ts
 * @public
 */

import {
  type KnowledgeBrowsePage,
  KnowledgeBrowsePageSchema,
  type KnowledgeBrowseQuery,
  KnowledgeBrowseQuerySchema,
  type KnowledgeOverviewQuery,
  KnowledgeOverviewQuerySchema,
} from "@cogni/knowledge-store/contracts";

/** A numeric bound the store schema declares, read through zod's public JSON Schema projection. */
function declared(
  schema: { toJSONSchema: () => Record<string, unknown> },
  pick: (json: Record<string, unknown>) => unknown,
): number {
  const value = pick(schema.toJSONSchema());
  if (typeof value !== "number")
    throw new Error("@cogni/knowledge-store contract declares no such bound");
  return value;
}
const exactValues = KnowledgeBrowseQuerySchema.shape.domains.in.unwrap();

/** Rows in one Browse or overview window (the store page's `items` maximum). */
export const KNOWLEDGE_WINDOW_MAX = declared(
  KnowledgeBrowsePageSchema.shape.items,
  (json) => json.maxItems,
);
/** Overview atoms the graph draws from one window. */
export const KNOWLEDGE_GRAPH_OVERVIEW_MAX = KNOWLEDGE_WINDOW_MAX;
/**
 * Citation links one focus page contributes to the graph. A node's citations
 * route returns at most this many links per page (node-template's
 * `/api/v1/citations/:id` schema caps `links` at 5); geometry draws only the
 * first five of a larger page.
 */
export const KNOWLEDGE_GRAPH_FOCUS_LINKS_MAX = 5;
/** Graph nodes: the overview, the selected atom and one endpoint per focus link. */
export const KNOWLEDGE_GRAPH_NODES_MAX =
  KNOWLEDGE_GRAPH_OVERVIEW_MAX + 1 + KNOWLEDGE_GRAPH_FOCUS_LINKS_MAX;
/** Exact values one header filter may hold (the store schema's array maximum). */
export const KNOWLEDGE_FILTER_VALUES_MAX = declared(
  exactValues,
  (json) => json.maxItems,
);
/** Longest exact filter value (the store schema's value maximum). */
export const KNOWLEDGE_FILTER_VALUE_LENGTH_MAX = declared(
  exactValues,
  (json) => (json.items as { maxLength?: unknown } | undefined)?.maxLength,
);
/** Longest body search (the store schema's search maximum). */
export const KNOWLEDGE_SEARCH_LENGTH_MAX = declared(
  KnowledgeBrowseQuerySchema.shape.search.unwrap(),
  (json) => json.maxLength,
);

/** Default cache key prefix. Node mutations that invalidate it raise the revision prompt. */
export const KNOWLEDGE_QUERY_PREFIX: readonly unknown[] = ["knowledge"];

/**
 * One Browse or overview window. `params` is `knowledgeQueryToSearchParams`'s
 * encoding. Reject with an error carrying the HTTP `status`.
 */
export type KnowledgeWindowFetcher = (
  params: URLSearchParams,
  signal: AbortSignal,
) => Promise<KnowledgeBrowsePage>;

export type KnowledgeReadOperation = "browse" | "overview";

/** The parsed query: defaults applied, exact values de-duplicated and sorted. */
export function parseKnowledgeQuery(
  query: KnowledgeBrowseQuery | KnowledgeOverviewQuery,
  operation: KnowledgeReadOperation = "browse",
): Record<string, string | readonly string[] | undefined> {
  return operation === "browse"
    ? KnowledgeBrowseQuerySchema.parse(query)
    : KnowledgeOverviewQuerySchema.parse(query);
}

/** Encode a query for `/knowledge/browse` or `/knowledge/overview`. */
export function knowledgeQueryToSearchParams(
  query: KnowledgeBrowseQuery | KnowledgeOverviewQuery,
  operation: KnowledgeReadOperation = "browse",
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(
    parseKnowledgeQuery(query, operation),
  )) {
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
    else if (typeof value === "string") params.set(key, value);
  }
  return params;
}

/** Cache key of one Browse (or body search) window. */
export function knowledgeBrowseKey(
  query: KnowledgeBrowseQuery = {},
  prefix: readonly unknown[] = KNOWLEDGE_QUERY_PREFIX,
): readonly unknown[] {
  return [
    ...prefix,
    query.search ? "search" : "browse",
    parseKnowledgeQuery(query, "browse"),
  ];
}

/** Cache key of one overview window. */
export function knowledgeOverviewKey(
  query: KnowledgeOverviewQuery = {},
  prefix: readonly unknown[] = KNOWLEDGE_QUERY_PREFIX,
): readonly unknown[] {
  return [...prefix, "overview", parseKnowledgeQuery(query, "overview")];
}
