// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Node-local replacement controller. Failed pages keep geometry; stale intent cannot commit. */
"use client";
import type { KnowledgeSummary } from "@cogni/node-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CitationLinksResponse,
  fetchCitationLinks,
} from "../../_api/fetchCitationLinks";

type FocusState = CitationLinksResponse & {
  id: string | null;
  pending: boolean;
  error: boolean;
  retryCursor?: string | undefined;
};
const empty = (id: string | null): FocusState => ({
  id,
  links: [],
  nextCursor: null,
  pending: false,
  error: false,
});
export function useGraphFocus(id: string | null) {
  const [state, setState] = useState<FocusState>(() => empty(id));
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
    void fetchCitationLinks(selected, cursor, controller.signal)
      .then((page) => {
        if (sequence === request.current.sequence && !controller.signal.aborted)
          setState({ id: selected, ...page, pending: false, error: false });
      })
      .catch(() => {
        if (sequence === request.current.sequence && !controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            pending: false,
            error: true,
          }));
      });
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
  return {
    ...(state.id === id ? state : empty(id)),
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

/** Reconstruct fresh objects: force-graph mutates coordinates and link endpoints. */
export function focusGeometry(
  overview: KnowledgeSummary[],
  selected: KnowledgeSummary | null,
  focus: Pick<CitationLinksResponse, "links">
) {
  const nodes = new Map(
    overview.slice(0, 20).map((node) => [node.id, { ...node, isHub: false }])
  );
  if (selected) nodes.set(selected.id, { ...selected, isHub: false });
  const links = [];
  for (const link of focus.links.slice(0, 5)) {
    for (const endpoint of [link.source, link.target]) {
      if (endpoint.kind === "knowledge" && !nodes.has(endpoint.id))
        nodes.set(endpoint.id, {
          id: endpoint.id,
          title: endpoint.title ?? endpoint.id,
          domain: "",
          entityId: null,
          entryType: "",
          sourceType: "",
          confidencePct: null,
          createdAt: null,
          isHub: false,
        });
    }
    if (link.source.kind === "knowledge" && link.target.kind === "knowledge")
      links.push({
        id: link.id,
        source: link.source.id,
        target: link.target.id,
        kind: "cite" as const,
        citationType: link.citationType,
        direction: link.direction,
      });
  }
  return { nodes: [...nodes.values()], links };
}
