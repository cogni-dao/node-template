// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-graph-focus`
 * Purpose: The knowledge graph's focus controller and bounded geometry: one replacement page of direct citation links for the selected atom, merged with one overview window into at most 26 nodes (task.0059).
 * Scope: Client hook over a node-supplied citation fetcher, plus a pure geometry function. The node owns its endpoint, auth and the renderer.
 * Invariants:
 *   - REPLACEMENT_FOCUS: More / Retry / Restart each request one page that REPLACES the current links; nothing accumulates or walks cursors.
 *   - FAILED_PAGE_KEEPS_GEOMETRY: a failed page keeps the previous links and remembers its cursor for `retry()`.
 *   - STALE_INTENT_IGNORED: a new selection, a newer page or unmount aborts the in-flight request, and a late response never commits.
 *   - BOUNDED_GEOMETRY: ≤ 20 overview atoms + the selected atom + ≤ 5 focus links, ≤ 26 nodes; only knowledge→knowledge links become typed edges; work endpoints stay links in the focus list.
 *   - FRESH_OBJECTS: geometry is rebuilt as new objects on every call, because force renderers mutate node coordinates and link endpoints.
 * Side-effects: IO (through the injected fetcher)
 * Links: task.0059
 * @public
 */

"use client";

import type { KnowledgeSummary } from "@cogni/knowledge-store/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DirectRelationPage } from "./direct-relation-links.js";
import {
  KNOWLEDGE_GRAPH_FOCUS_LINKS_MAX,
  KNOWLEDGE_GRAPH_NODES_MAX,
  KNOWLEDGE_GRAPH_OVERVIEW_MAX,
} from "./knowledge-browse-query.js";

/** One end of a direct citation link, as the node's citations route returns it. */
export interface KnowledgeCitationEndpoint {
  readonly id: string;
  readonly kind: "knowledge" | "work";
  readonly title: string | null;
  readonly href: string;
}

/** One direct citation link of the focused atom. */
export interface KnowledgeCitationLink {
  readonly id: string;
  readonly direction: "out" | "in";
  readonly citationType: string;
  readonly source: KnowledgeCitationEndpoint;
  readonly target: KnowledgeCitationEndpoint;
  readonly context: string | null;
}

export type KnowledgeCitationPage = DirectRelationPage<KnowledgeCitationLink>;

/** One page of an atom's direct citation links. Reject with an error carrying `status`. */
export type KnowledgeCitationFetcher = (
  id: string,
  cursor: string | undefined,
  signal: AbortSignal,
) => Promise<KnowledgeCitationPage>;

export interface UseGraphFocusOptions {
  /** The selected atom, or `null` for no focus. */
  readonly id: string | null;
  readonly fetchCitationLinks: KnowledgeCitationFetcher;
}

export interface UseGraphFocusResult {
  readonly id: string | null;
  readonly links: readonly KnowledgeCitationLink[];
  readonly nextCursor: string | null;
  readonly pending: boolean;
  readonly error: boolean;
  /** Replace the links with the next page. */
  readonly more: () => void;
  /** Re-request the page that failed. */
  readonly retry: () => void;
  /** Replace the links with the first page. */
  readonly restart: () => void;
}

interface FocusState {
  readonly id: string | null;
  readonly links: readonly KnowledgeCitationLink[];
  readonly nextCursor: string | null;
  readonly pending: boolean;
  readonly error: boolean;
  readonly retryCursor?: string | undefined;
}

const empty = (id: string | null): FocusState => ({
  id,
  links: [],
  nextCursor: null,
  pending: false,
  error: false,
});

export function useGraphFocus({
  id,
  fetchCitationLinks,
}: UseGraphFocusOptions): UseGraphFocusResult {
  const [state, setState] = useState<FocusState>(() => empty(id));
  const fetcher = useRef(fetchCitationLinks);
  useEffect(() => {
    fetcher.current = fetchCitationLinks;
  });
  const request = useRef<{ sequence: number; controller?: AbortController }>({
    sequence: 0,
  });
  const load = useCallback((selected: string, cursor?: string) => {
    request.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++request.current.sequence;
    request.current.controller = controller;
    setState((previous) => ({
      ...(previous.id === selected ? previous : empty(selected)),
      pending: true,
      error: false,
      retryCursor: cursor,
    }));
    const live = () =>
      sequence === request.current.sequence && !controller.signal.aborted;
    fetcher.current(selected, cursor, controller.signal).then(
      (page) => {
        if (live())
          setState({
            id: selected,
            links: page.links,
            nextCursor: page.nextCursor,
            pending: false,
            error: false,
          });
      },
      () => {
        if (live())
          setState((previous) => ({ ...previous, pending: false, error: true }));
      },
    );
  }, []);
  useEffect(() => {
    if (id) load(id);
    else {
      request.current.controller?.abort();
      ++request.current.sequence;
      setState(empty(null));
    }
    return () => {
      request.current.controller?.abort();
      ++request.current.sequence;
    };
  }, [id, load]);
  const visible = state.id === id ? state : empty(id);
  return {
    id,
    links: visible.links,
    nextCursor: visible.nextCursor,
    pending: visible.pending,
    error: visible.error,
    more: () => {
      if (id && state.nextCursor && !state.pending) load(id, state.nextCursor);
    },
    retry: () => {
      if (id && !state.pending) load(id, state.retryCursor);
    },
    restart: () => {
      if (id) load(id);
    },
  };
}

/** A drawn atom. Endpoints known only from a link carry their id and title. */
export interface KnowledgeGraphNode {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly entryType: string;
  readonly sourceType: string;
  readonly confidencePct: number | null;
}

/** A drawn typed citation edge between two atoms. */
export interface KnowledgeGraphLink {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly citationType: string;
  readonly direction: "out" | "in";
}

export interface KnowledgeGraphGeometry {
  readonly nodes: KnowledgeGraphNode[];
  readonly links: KnowledgeGraphLink[];
}

function toNode(entry: KnowledgeSummary): KnowledgeGraphNode {
  return {
    id: entry.id,
    title: entry.title,
    domain: entry.domain,
    entryType: entry.entryType,
    sourceType: entry.sourceType,
    confidencePct: entry.confidencePct,
  };
}

/** Merge one overview window, the selected atom and one focus page into bounded fresh geometry. */
export function knowledgeFocusGeometry(
  overview: readonly KnowledgeSummary[],
  selected: KnowledgeSummary | null,
  focus: { readonly links: readonly KnowledgeCitationLink[] },
): KnowledgeGraphGeometry {
  const nodes = new Map<string, KnowledgeGraphNode>(
    overview
      .slice(0, KNOWLEDGE_GRAPH_OVERVIEW_MAX)
      .map((entry) => [entry.id, toNode(entry)]),
  );
  if (selected) nodes.set(selected.id, toNode(selected));
  const links: KnowledgeGraphLink[] = [];
  for (const link of focus.links.slice(0, KNOWLEDGE_GRAPH_FOCUS_LINKS_MAX)) {
    const added = [link.source, link.target].filter(
      (endpoint) => endpoint.kind === "knowledge" && !nodes.has(endpoint.id),
    );
    const unique = [...new Map(added.map((e) => [e.id, e])).values()];
    if (nodes.size + unique.length > KNOWLEDGE_GRAPH_NODES_MAX) continue;
    for (const endpoint of unique)
      nodes.set(endpoint.id, {
        id: endpoint.id,
        title: endpoint.title ?? endpoint.id,
        domain: "",
        entryType: "",
        sourceType: "",
        confidencePct: null,
      });
    if (link.source.kind === "knowledge" && link.target.kind === "knowledge")
      links.push({
        id: link.id,
        source: link.source.id,
        target: link.target.id,
        citationType: link.citationType,
        direction: link.direction,
      });
  }
  return { nodes: [...nodes.values()], links };
}
