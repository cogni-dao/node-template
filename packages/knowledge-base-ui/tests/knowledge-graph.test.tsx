// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph.test`
 * Purpose: Proves the graph's bounded data path against fixture fetchers: focus pages replace geometry (≤ 26 nodes, ≤ 5 typed edges, work endpoints stay links), failed pages keep geometry and retry their cursor, stale selections cannot commit, and the overview pages and restarts explicitly with its revision prompt (task.0059).
 * Scope: Package exports only (`KnowledgeGraph`, `useGraphFocus`, `knowledgeFocusGeometry`) with an injected stub renderer. No node app code or WebGL.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0059, ../src/use-graph-focus.ts, ../src/knowledge-graph.tsx
 */

// @vitest-environment jsdom

import type {
  KnowledgeBrowsePage,
  KnowledgeSummary,
} from "@cogni/knowledge-store/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_GRAPH_NODES_MAX,
  type KnowledgeCitationFetcher,
  type KnowledgeCitationLink,
  KnowledgeGraph,
  type KnowledgeGraphRendererProps,
  type KnowledgeWindowFetcher,
  knowledgeFocusGeometry,
  useGraphFocus,
} from "../src/index.js";

afterEach(() => cleanup());

const selected: KnowledgeSummary = {
  id: "node-template-selected-decision",
  domain: "meta",
  entityId: null,
  title: "node-template selected decision",
  useWhen: null,
  entryType: "decision",
  confidencePct: 80,
  sourceType: "human",
  createdAt: null,
};

function relation(index: number): KnowledgeCitationLink {
  return {
    id: `direct-${index}`,
    direction: "out",
    citationType: "supports",
    source: {
      id: selected.id,
      kind: "knowledge",
      title: selected.title,
      href: `/knowledge/${selected.id}`,
    },
    target: {
      id: `neighbor-${index}`,
      kind: "knowledge",
      title: `Direct relation ${index}`,
      href: `/knowledge/neighbor-${index}`,
    },
    context: null,
  };
}

const overview = Array.from({ length: 20 }, (_, i) => ({
  ...selected,
  id: `overview-${i}`,
  title: `Overview ${i}`,
}));

describe("useGraphFocus + knowledgeFocusGeometry", () => {
  it("focus pages replace geometry, stay bounded, keep typed edges and work links, and retry failed pages", async () => {
    let fail = true;
    const fetchCitationLinks = vi.fn<KnowledgeCitationFetcher>(
      async (_id, cursor) => {
        if (cursor === "next-1") {
          if (fail) {
            fail = false;
            throw Object.assign(new Error("busy"), { status: 503 });
          }
          return {
            links: Array.from({ length: 5 }, (_, i) => relation(i + 5)),
            nextCursor: "next-2",
          };
        }
        if (cursor === "next-2")
          return {
            links: [
              {
                ...relation(10),
                direction: "in",
                source: relation(10).target,
                target: relation(10).source,
              },
              {
                ...relation(11),
                target: {
                  ...relation(11).target,
                  kind: "work",
                  href: "/work/items/task.1234",
                },
              },
            ],
            nextCursor: null,
          };
        return {
          links: Array.from({ length: 5 }, (_, i) => relation(i)),
          nextCursor: "next-1",
        };
      },
    );
    const { result } = renderHook(() =>
      useGraphFocus({ id: selected.id, fetchCitationLinks }),
    );
    await waitFor(() => expect(result.current.links).toHaveLength(5));
    expect(knowledgeFocusGeometry(overview, selected, result.current).nodes).toHaveLength(26);
    act(() => result.current.more());
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.links[0]?.id).toBe("direct-0");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.links[0]?.id).toBe("direct-5"));
    const replaced = knowledgeFocusGeometry(overview, selected, result.current);
    expect(replaced.links).toHaveLength(5);
    expect(replaced.nodes.some((node) => node.id === "neighbor-0")).toBe(false);
    act(() => result.current.more());
    await waitFor(() => expect(result.current.links).toHaveLength(2));
    const geometry = knowledgeFocusGeometry(overview, selected, result.current);
    expect(geometry.links).toEqual([
      {
        id: "direct-10",
        source: "neighbor-10",
        target: selected.id,
        direction: "in",
        citationType: "supports",
      },
    ]);
    expect(geometry.nodes.length).toBeLessThanOrEqual(KNOWLEDGE_GRAPH_NODES_MAX);
    expect(geometry.nodes.some((node) => node.id === "neighbor-11")).toBe(false);
    expect(result.current.links[1]?.target.href).toBe("/work/items/task.1234");
    expect(fetchCitationLinks.mock.calls.map(([, cursor]) => cursor)).toEqual([
      undefined,
      "next-1",
      "next-1",
      "next-2",
    ]);
  });

  it("geometry never exceeds 26 nodes or 5 edges, even when links name foreign endpoints", () => {
    const foreign = Array.from({ length: 9 }, (_, i) => ({
      ...relation(i),
      source: { ...relation(i).target, id: `foreign-${i}` },
    }));
    const geometry = knowledgeFocusGeometry(
      [...overview, ...overview.map((o) => ({ ...o, id: `${o.id}-extra` }))],
      selected,
      { links: foreign },
    );
    expect(geometry.nodes.length).toBeLessThanOrEqual(KNOWLEDGE_GRAPH_NODES_MAX);
    expect(geometry.links.length).toBeLessThanOrEqual(5);
    // Fresh objects every call: renderers mutate them.
    const again = knowledgeFocusGeometry(overview, selected, { links: [] });
    expect(again.nodes[0]).not.toBe(
      knowledgeFocusGeometry(overview, selected, { links: [] }).nodes[0],
    );
  });

  it("a newer selection aborts the older request and its late response never commits", async () => {
    const delayed = new Map<string, (links: KnowledgeCitationLink[]) => void>();
    const signals: AbortSignal[] = [];
    const fetchCitationLinks: KnowledgeCitationFetcher = (id, _cursor, signal) => {
      signals.push(signal);
      return new Promise((resolve) =>
        delayed.set(id, (links) => resolve({ links, nextCursor: null })),
      );
    };
    const focus = renderHook(
      ({ id }) => useGraphFocus({ id, fetchCitationLinks }),
      { initialProps: { id: "old" as string | null } },
    );
    focus.rerender({ id: "new" });
    await act(async () => delayed.get("new")?.([relation(8)]));
    await act(async () => delayed.get("old")?.([relation(0)]));
    expect(focus.result.current.links[0]?.id).toBe("direct-8");
    expect(signals[0]?.aborted).toBe(true);
    focus.rerender({ id: null });
    expect(focus.result.current.links).toEqual([]);
    expect(signals[1]?.aborted).toBe(true);
  });
});

describe("KnowledgeGraph", () => {
  function StubRenderer({ graphData, onNodeClick, nodeLabel }: KnowledgeGraphRendererProps) {
    return (
      <div data-testid="renderer" data-nodes={graphData.nodes.length} data-links={graphData.links.length}>
        {graphData.nodes.map((node) => (
          <button key={node.id} type="button" title={nodeLabel(node)} onClick={() => onNodeClick(node)}>
            Select graph {node.title}
          </button>
        ))}
      </div>
    );
  }

  function Harness({
    fetchOverview,
    fetchCitationLinks,
    initialData,
  }: {
    readonly fetchOverview: KnowledgeWindowFetcher;
    readonly fetchCitationLinks: KnowledgeCitationFetcher;
    readonly initialData?: KnowledgeBrowsePage;
  }) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    return (
      <KnowledgeGraph
        fetchOverview={fetchOverview}
        fetchCitationLinks={fetchCitationLinks}
        renderer={StubRenderer}
        initialData={initialData}
        selectedId={selectedId}
        onSelect={setSelectedId}
        selected={selectedId === selected.id ? selected : null}
      />
    );
  }

  function mount(props: Parameters<typeof Harness>[0]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <Harness {...props} />
      </QueryClientProvider>,
    );
  }

  it("draws the seeded overview with no read, then one focus page per selection, bounded", async () => {
    const fetchOverview = vi.fn<KnowledgeWindowFetcher>(async () => {
      throw new Error("Hidden overview read");
    });
    const fetchCitationLinks = vi.fn<KnowledgeCitationFetcher>(async () => ({
      links: Array.from({ length: 5 }, (_, i) => relation(i)),
      nextCursor: "next",
    }));
    mount({
      fetchOverview,
      fetchCitationLinks,
      initialData: {
        items: [selected, ...overview.slice(0, 19)],
        nextCursor: null,
        revision: "rev-a",
        scannedRows: 20,
      },
    });
    expect(screen.getByTestId("renderer").dataset.nodes).toBe("20");
    expect(fetchOverview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Select graph ${selected.title}` }));
    await waitFor(() => expect(screen.getByTestId("renderer").dataset.links).toBe("5"));
    expect(screen.getByTestId("renderer").dataset.nodes).toBe("25");
    expect(fetchCitationLinks).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Direct relation 4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
    expect(screen.getByTestId("renderer").dataset.links).toBe("0");
  });

  it("escapes agent-authored labels", () => {
    mount({
      fetchOverview: vi.fn<KnowledgeWindowFetcher>(),
      fetchCitationLinks: vi.fn<KnowledgeCitationFetcher>(),
      initialData: {
        items: [{ ...selected, title: "<img src=x onerror=alert(1)>" }],
        nextCursor: null,
        revision: "rev-a",
        scannedRows: 1,
      },
    });
    const label = screen.getByRole("button", { name: /Select graph/ }).getAttribute("title");
    expect(label).toContain("&lt;img");
    expect(label).not.toContain("<img");
  });

  it("pages the overview explicitly, signals revision transitions and restarts", async () => {
    const reads: URLSearchParams[] = [];
    const fetchOverview = vi.fn<KnowledgeWindowFetcher>(async (params) => {
      reads.push(params);
      return { items: [selected], nextCursor: null, revision: "rev-b", scannedRows: 1 };
    });
    mount({
      fetchOverview,
      fetchCitationLinks: vi.fn<KnowledgeCitationFetcher>(),
      initialData: { items: [selected], nextCursor: "graph-next", revision: "rev-a", scannedRows: 1 },
    });
    expect(screen.getByText(/Observed revision: rev-a/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More overview" }));
    const prompt = "Knowledge changed. Restart overview to begin a new live traversal.";
    await screen.findByText(prompt);
    expect(reads[0]?.get("cursor")).toBe("graph-next");
    expect(reads[0]?.has("search")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Restart overview" }));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]?.get("cursor")).toBeNull();
    await waitFor(() => expect(screen.queryByText(prompt)).toBeNull());
  });
});
