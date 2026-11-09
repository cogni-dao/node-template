// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-graph-focus`
 * Purpose: The knowledge graph's focus controller and geometry: one replacement page of direct citation links for the selected atom, merged with one overview page (task.0059).
 * Scope: Client hook over a node-supplied citation fetcher, plus a pure geometry function. The node owns its endpoint, auth and the renderer.
 * Invariants:
 *   - REPLACEMENT_FOCUS: More / Retry / Restart each request one page that REPLACES the current links; nothing accumulates or walks cursors.
 *   - FAILED_PAGE_KEEPS_GEOMETRY: a failed page keeps the previous links and remembers its cursor for `retry()`.
 *   - STALE_INTENT_IGNORED: a new selection, a newer page or unmount aborts the in-flight request, and a late response never commits.
 *   - GEOMETRY_IS_THE_DATA: nodes are exactly one overview page (bounded by the store's `KnowledgeOverviewPageSchema`) plus the selected atom plus the knowledge endpoints of one citations page (bounded by the node's citations route); edges are that page's knowledge→knowledge links. No caps or slices are re-declared here; work endpoints stay links in the focus list.
 *   - FRESH_OBJECTS: geometry is rebuilt as new objects on every call, because force renderers mutate node coordinates and link endpoints.
 * Side-effects: IO (through the injected fetcher)
 * Links: task.0059
 * @public
 */

"use client";

import type { KnowledgeSummary } from "@cogni/knowledge-store/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DirectRelationPage } from "./direct-relation-links.js";

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

/**
 * One page of an atom's direct citation links, with a cursor for the next.
 * The page size is the node route's contract (node-template's
 * `/api/v1/citations/:id` returns at most 5); the graph draws the page as
 * returned. Reject with an error carrying `status`.
 */
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
    // Read the visible (current-selection) state, never a previous selection's cursor.
    more: () => {
      if (id && visible.nextCursor && !visible.pending)
        load(id, visible.nextCursor);
    },
    retry: () => {
      if (id && visible.error && !visible.pending) load(id, visible.retryCursor);
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

/** Merge one overview page, the selected atom and one focus page into fresh geometry, exactly as returned. */
export function knowledgeFocusGeometry(
  overview: readonly KnowledgeSummary[],
  selected: KnowledgeSummary | null,
  focus: { readonly links: readonly KnowledgeCitationLink[] },
): KnowledgeGraphGeometry {
  const nodes = new Map<string, KnowledgeGraphNode>(
    overview.map((entry) => [entry.id, toNode(entry)]),
  );
  if (selected) nodes.set(selected.id, toNode(selected));
  const links: KnowledgeGraphLink[] = [];
  for (const link of focus.links) {
    for (const endpoint of [link.source, link.target])
      if (endpoint.kind === "knowledge" && !nodes.has(endpoint.id))
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
