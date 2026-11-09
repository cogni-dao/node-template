// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-browse-query`
 * Purpose: The bounded knowledge read contract the Browse and Graph hooks share: request encoding, input validation, cache keys and the injected fetcher shapes (task.0059).
 * Scope: Pure functions and types over `@cogni/knowledge-store/contracts` (≥ 0.12.0), which owns the query schemas, their limits and the page size. No I/O.
 * Invariants:
 *   - ONE_CODEC: every request is the store schema's parse of the query, encoded with repeated keys for the exact-value arrays (`domains=a&domains=b`), so the node's route parses it back with the same schema. Nodes never hand-build these parameters.
 *   - KEY_IS_QUERY_IDENTITY: the cache key is `[...prefix, "browse" | "search" | "overview", parsedQuery]`, cursor included, so each window is its own cache entry and a new filter, sort or search is a new key.
 *   - NO_COPIED_LIMITS: the package declares no numeric budgets. Page sizes are whatever the store's page schema admits and the server returns; user input (filter values, search) is validated by parsing it with `KnowledgeBrowseQuerySchema` and surfacing the schema's own issue (`knowledgeQueryIssue`).
 * Side-effects: none
 * Links: task.0059, packages/knowledge-store/src/contracts.ts
 * @public
 */

import {
  type KnowledgeBrowsePage,
  type KnowledgeBrowseQuery,
  KnowledgeBrowseQuerySchema,
  type KnowledgeOverviewQuery,
  KnowledgeOverviewQuerySchema,
} from "@cogni/knowledge-store/contracts";

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

/**
 * The store schema's first issue for a candidate query, or `null` when it
 * parses. Input limits (values per filter, value length, search length) come
 * only from `KnowledgeBrowseQuerySchema`; the package copies none of them.
 */
export function knowledgeQueryIssue(
  query: KnowledgeBrowseQuery,
): string | null {
  const parsed = KnowledgeBrowseQuerySchema.safeParse(query);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "Invalid knowledge query";
}
