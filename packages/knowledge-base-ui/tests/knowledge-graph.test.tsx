// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph.test`
 * Purpose: Proves the Graph draws the whole corpus with exact counts from one read per revision, highlights neighbors from memory without fetching, narrows client-side over the full set, keeps the renderer's data stable across selection and same-revision revalidation, and escapes labels (task.0059).
 * Scope: Package exports only (`KnowledgeGraph`, `useKnowledgeGraph`, `narrowKnowledgeGraph`, `knowledgeGraphNeighbors`) with an injected stub renderer and a fixture fetcher. No node app code or WebGL.
 * Side-effects: DOM rendering in jsdom
 * Links: task.0059, ../src/knowledge-graph.tsx, ../src/use-knowledge-graph.ts
 */

// @vitest-environment jsdom

import type { KnowledgeGraphResponse } from "@cogni/knowledge-store/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type KnowledgeGraphFetcher,
  KnowledgeGraph,
  type KnowledgeGraphRendererProps,
  knowledgeGraphNeighbors,
  narrowKnowledgeGraph,
} from "../src/knowledge.js";

afterEach(() => cleanup());

/** A corpus well past any old "20 atoms" window: every node must be drawn. */
function corpus(nodes: number, revision = "rev-a"): KnowledgeGraphResponse {
  return {
    revision,
    domains: ["meta", "strategy"],
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: `k-${i}`,
      domain: i % 2 ? "strategy" : "meta",
      title: i === 1 ? "<img src=x onerror=alert(1)>" : `Entry ${i}`,
      entryType: i % 3 ? "guide" : "decision",
      confidencePct: i % 100,
      sourceType: "agent",
    })),
    edges: Array.from({ length: nodes * 2 }, (_, e) => ({
      id: `c-${e}`,
      source: `k-${e % nodes}`,
      target: `k-${((e % nodes) + (e < nodes ? 1 : 7)) % nodes}`,
      citationType: e % 2 ? "supports" : "extends",
    })),
  };
}

const renders: KnowledgeGraphRendererProps[] = [];
function StubRenderer(props: KnowledgeGraphRendererProps) {
  renders.push(props);
  const { graphData, onNodeClick, nodeColor, nodeLabel } = props;
  return (
    <div
      data-testid="renderer"
      data-nodes={graphData.nodes.length}
      data-links={graphData.links.length}
    >
      {graphData.nodes.slice(0, 12).map((node) => (
        <button
          key={node.id}
          type="button"
          data-color={nodeColor(node)}
          title={nodeLabel(node)}
          onClick={() => onNodeClick(node)}
        >
          Node {node.id}
        </button>
      ))}
    </div>
  );
}

function Harness({ fetchGraph }: { readonly fetchGraph: KnowledgeGraphFetcher }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <KnowledgeGraph
      fetchGraph={fetchGraph}
      renderer={StubRenderer}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  );
}

function mount(fetchGraph: KnowledgeGraphFetcher) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness fetchGraph={fetchGraph} />
    </QueryClientProvider>,
  );
  return client;
}

describe("KnowledgeGraph", () => {
  it("draws every entry and citation from one read and states exact counts", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(5046));
    mount(fetchGraph);
    await screen.findByText(/5,046 entries · 10,092 citations/);
    const renderer = screen.getByTestId("renderer");
    expect(renderer.dataset.nodes).toBe("5046");
    expect(renderer.dataset.links).toBe("10092");
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });

  it("selecting highlights neighbors from memory, dims the rest, keeps graph data, and never fetches", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(50));
    mount(fetchGraph);
    await screen.findByText(/50 entries · 100 citations/);
    const before = renders.at(-1)?.graphData;
    fireEvent.click(screen.getByRole("button", { name: "Node k-3" }));
    await screen.findByText(/Selected: Entry 3 · /);
    const neighbors = knowledgeGraphNeighbors(corpus(50)).get("k-3");
    expect(neighbors?.has("k-4")).toBe(true);
    expect(screen.getByText(new RegExp(`${neighbors?.size} connected entries`))).toBeTruthy();
    const color = (id: string) =>
      screen.getByRole("button", { name: `Node ${id}` }).getAttribute("data-color");
    expect(color("k-3")).not.toMatch(/^rgba\(100,116,139/);
    expect(color("k-4")).not.toMatch(/^rgba\(100,116,139/);
    expect(color("k-11")).toMatch(/^rgba\(100,116,139/);
    expect(renders.at(-1)?.graphData).toBe(before);
    expect(fetchGraph).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(color("k-11")).not.toMatch(/^rgba\(100,116,139/);
  });

  it("narrows the visible set client-side over the full corpus and says so", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(5046));
    mount(fetchGraph);
    await screen.findByText(/5,046 entries/);
    fireEvent.change(screen.getByRole("combobox", { name: "Graph domain" }), {
      target: { value: "meta" },
    });
    const expected = narrowKnowledgeGraph(corpus(5046), { text: "", domain: "meta" });
    await screen.findByText(
      `Showing 2,523 of 5,046 entries · ${expected.links.length.toLocaleString("en-US")} of 10,092 citations · revision rev-a`,
    );
    expect(screen.getByTestId("renderer").dataset.nodes).toBe("2523");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter graph" }), {
      target: { value: "Entry 504" },
    });
    fireEvent.submit(screen.getByRole("textbox", { name: "Filter graph" }).closest("form") as HTMLFormElement);
    // "Entry 504", "Entry 5040".."Entry 5045" in meta (even ids only).
    await waitFor(() =>
      expect(screen.getByTestId("renderer").dataset.nodes).toBe(
        String(
          corpus(5046).nodes.filter(
            (n) => n.domain === "meta" && n.title.toLowerCase().includes("entry 504"),
          ).length,
        ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await screen.findByText(/^5,046 entries · 10,092 citations/);
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });

  it("a same-revision revalidation keeps the graph object; a new revision replaces it", async () => {
    let revision = "rev-a";
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(30, revision));
    const client = mount(fetchGraph);
    await screen.findByText(/30 entries/);
    const first = renders.at(-1)?.graphData;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["knowledge", "graph"] });
    });
    expect(fetchGraph).toHaveBeenCalledTimes(2);
    expect(renders.at(-1)?.graphData).toBe(first);
    revision = "rev-b";
    await act(async () => {
      await client.refetchQueries({ queryKey: ["knowledge", "graph"] });
    });
    await screen.findByText(/revision rev-b/);
    expect(renders.at(-1)?.graphData).not.toBe(first);
  });

  it("revalidates with the cached revision; a 304 (null) keeps the parsed graph without a download", async () => {
    const seen: (string | undefined)[] = [];
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async (_signal, ifNoneMatch) => {
      seen.push(ifNoneMatch);
      return ifNoneMatch ? null : corpus(40);
    });
    const client = mount(fetchGraph);
    await screen.findByText(/40 entries/);
    const first = renders.at(-1)?.graphData;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["knowledge", "graph"] });
    });
    expect(seen).toEqual([undefined, '"rev-a"']);
    expect(renders.at(-1)?.graphData).toBe(first);
    expect(screen.getByText(/40 entries · 80 citations/)).toBeTruthy();
  });

  it("escapes agent-authored labels and offers retry on failure", async () => {
    let fail = true;
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => {
      if (fail) throw Object.assign(new Error("busy"), { status: 503 });
      return corpus(3);
    });
    mount(fetchGraph);
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry graph" }));
    const label = (await screen.findByRole("button", { name: "Node k-1" })).getAttribute("title");
    expect(label).toContain("&lt;img");
    expect(label).not.toContain("<img");
  });
});

describe("narrowKnowledgeGraph", () => {
  it("returns fresh objects and only edges between visible entries", () => {
    const graph = corpus(10);
    const all = narrowKnowledgeGraph(graph, { text: "", domain: "" });
    expect(all.nodes).toHaveLength(10);
    expect(all.links).toHaveLength(20);
    expect(all.nodes[0]).not.toBe(graph.nodes[0]);
    const meta = narrowKnowledgeGraph(graph, { text: "", domain: "meta" });
    const visible = new Set(meta.nodes.map((n) => n.id));
    expect(
      meta.links.every(
        (l) => visible.has(String(l.source)) && visible.has(String(l.target)),
      ),
    ).toBe(true);
  });
});
