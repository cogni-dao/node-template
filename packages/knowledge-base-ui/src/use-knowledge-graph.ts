// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-knowledge-graph`
 * Purpose: The knowledge Graph's data path: the whole projected corpus (every entry and every citation) in one read per store revision, plus the in-memory indexes the view needs (task.0059).
 * Scope: Client hook over a node-supplied fetcher. The node owns its endpoint, auth and HTTP revalidation (ETag = revision, so an unchanged graph is a 304); this hook owns the cache key, revision identity and adjacency.
 * Invariants:
 *   - WHOLE_CORPUS: the graph is never truncated or paged; counts are the exact lengths of what the store returned.
 *   - ONE_READ_PER_REVISION: one cache entry under `[...prefix, "graph"]`; a refetch that returns the same `revision` keeps the previous object (and its indexes), so renderers keep their layout.
 *   - NEIGHBORS_IN_MEMORY: neighbors of any entry come from the loaded edge set; selecting never fetches.
 *   - HOST_QUERY_CLIENT: rendered under the host's `QueryClientProvider`.
 * Side-effects: IO (through the injected fetcher)
 * Links: task.0059
 * @public
 */

"use client";

import type { KnowledgeGraphResponse } from "@cogni/knowledge-store/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { KNOWLEDGE_QUERY_PREFIX } from "./knowledge-browse-query.js";

/** The whole graph at one revision. Reject with an error carrying the HTTP `status`. */
export type KnowledgeGraphFetcher = (
  signal: AbortSignal,
) => Promise<KnowledgeGraphResponse>;

export interface UseKnowledgeGraphOptions {
  readonly fetchGraph: KnowledgeGraphFetcher;
  /** Default 30s; refetches revalidate cheaply (304) when nothing changed. */
  readonly staleTime?: number;
  /** Default `["knowledge"]`. */
  readonly queryKeyPrefix?: readonly unknown[];
}

export interface UseKnowledgeGraphResult {
  readonly graph: KnowledgeGraphResponse | undefined;
  /** Entry id → ids of entries it cites or is cited by. */
  readonly neighbors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly retry: () => void;
}

const NO_NEIGHBORS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** Adjacency over the loaded edge set, built once per revision. */
export function knowledgeGraphNeighbors(
  graph: Pick<KnowledgeGraphResponse, "edges">,
): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let set = neighbors.get(from);
    if (!set) neighbors.set(from, (set = new Set()));
    set.add(to);
  };
  for (const edge of graph.edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }
  return neighbors;
}

export function useKnowledgeGraph({
  fetchGraph,
  staleTime = 30_000,
  queryKeyPrefix = KNOWLEDGE_QUERY_PREFIX,
}: UseKnowledgeGraphOptions): UseKnowledgeGraphResult {
  const result = useQuery({
    queryKey: [...queryKeyPrefix, "graph"],
    queryFn: ({ signal }) => fetchGraph(signal),
    staleTime,
    retry: false,
    // Same revision ⇒ same graph: keep the previous object instead of diffing
    // thousands of nodes, so the layout and indexes survive a revalidation.
    structuralSharing: (previous, next) =>
      (previous as KnowledgeGraphResponse | undefined)?.revision ===
      (next as KnowledgeGraphResponse).revision
        ? previous
        : next,
  });
  const graph = result.data;
  const neighbors = useMemo(
    () => (graph ? knowledgeGraphNeighbors(graph) : NO_NEIGHBORS),
    [graph],
  );
  return {
    graph,
    neighbors,
    isLoading: result.isLoading,
    error: result.error,
    retry: () => void result.refetch(),
  };
}
