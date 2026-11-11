// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph.test`
 * Purpose: Proves the Graph's final header (Confidence | Domain toggle, "Domain hubs", Domain and Type dropdowns, no free-text inputs), whole-corpus drawing with exact counts reported to the page, instant client-side narrowing, synthetic hubs on top of complete data, in-memory neighbour highlighting without fetching, same-revision/304 stability and escaped labels (task.0059).
 * Scope: Package exports only (`KnowledgeGraph`, `knowledgeGraphRenderData`, `knowledgeGraphNeighbors`) with an injected stub renderer and a fixture fetcher. No node app code or WebGL.
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
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type KnowledgeGraphEntriesSummary,
  type KnowledgeGraphFetcher,
  KnowledgeGraph,
  type KnowledgeGraphRendererProps,
  knowledgeGraphNeighbors,
  knowledgeGraphRenderData,
} from "../src/knowledge.js";

// Radix Select needs these browser APIs, which jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});
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
  const entries = graphData.nodes.filter((node) => !node.isHub);
  return (
    <div
      data-testid="renderer"
      data-entries={entries.length}
      data-hubs={graphData.nodes.length - entries.length}
      data-citations={graphData.links.filter((l) => l.kind === "cite").length}
    >
      {graphData.nodes.slice(0, 14).map((node) => (
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

const summaries: (KnowledgeGraphEntriesSummary | null)[] = [];
function Harness({ fetchGraph }: { readonly fetchGraph: KnowledgeGraphFetcher }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <>
      <KnowledgeGraph
        fetchGraph={fetchGraph}
        renderer={StubRenderer}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onEntriesChange={(summary) => summaries.push(summary)}
      />
      <p>Selected: {selectedId ?? "none"}</p>
    </>
  );
}

function mount(fetchGraph: KnowledgeGraphFetcher) {
  summaries.length = 0;
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

const dimmed = (id: string) =>
  /^rgba\(100,116,139/.test(
    screen.getByRole("button", { name: `Node ${id}` }).getAttribute("data-color") ?? "",
  );

describe("KnowledgeGraph", () => {
  it("renders the final header: Confidence | Domain, Domain hubs, Domain and Type dropdowns, no text inputs", async () => {
    mount(vi.fn<KnowledgeGraphFetcher>(async () => corpus(30)));
    await waitFor(() => expect(screen.getByTestId("renderer")).toBeTruthy());
    const group = screen.getByRole("group", { name: "Graph color mode" });
    const modes = Array.from(group.querySelectorAll("button")).map((b) => [
      b.textContent,
      b.getAttribute("aria-pressed"),
    ]);
    expect(modes).toEqual([
      ["confidence", "true"],
      ["domain", "false"],
    ]);
    expect(
      (screen.getByRole("checkbox", { name: "Domain hubs" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByRole("combobox", { name: "Domain" }).textContent).toContain(
      "All domains",
    );
    expect(screen.getByRole("combobox", { name: "Type" }).textContent).toContain("All types");
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Filter|Open entry|Show all/ })).toBeNull();
  });

  it("draws every entry and citation from one read, with hubs on top, and reports exact counts", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(5046));
    mount(fetchGraph);
    await waitFor(() =>
      expect(screen.getByTestId("renderer").dataset.entries).toBe("5046"),
    );
    const renderer = screen.getByTestId("renderer");
    expect(renderer.dataset.citations).toBe("10092");
    expect(renderer.dataset.hubs).toBe("2");
    expect(summaries.at(-1)).toEqual({ shown: 5046, total: 5046, narrowed: false });
    expect(screen.getByText("10092 citations · 2 domains")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Domain hubs" }));
    expect(screen.getByTestId("renderer").dataset.hubs).toBe("0");
    expect(screen.getByTestId("renderer").dataset.entries).toBe("5046");
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });

  it("the Domain and Type dropdowns list exact counts and narrow instantly without fetching", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(5046));
    mount(fetchGraph);
    const user = userEvent.setup();
    await waitFor(() => expect(summaries.at(-1)).toEqual({ shown: 5046, total: 5046, narrowed: false }));
    await user.click(screen.getByRole("combobox", { name: "Domain" }));
    expect(
      (await screen.findAllByRole("option")).map((option) => option.textContent),
    ).toEqual(["All domains", "meta · 2,523", "strategy · 2,523"]);
    await user.click(screen.getByRole("option", { name: "meta · 2,523" }));
    await waitFor(() => expect(summaries.at(-1)).toEqual({ shown: 2523, total: 5046, narrowed: true }));
    expect(screen.getByTestId("renderer").dataset.entries).toBe("2523");
    expect(screen.getByTestId("renderer").dataset.hubs).toBe("1");
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: /^decision · / }));
    const expected = knowledgeGraphRenderData(corpus(5046), {
      hubs: false,
      domain: "meta",
      entryType: "decision",
    });
    await waitFor(() =>
      expect(summaries.at(-1)).toEqual({ shown: expected.nodes.length, total: 5046, narrowed: true }),
    );
    await user.click(screen.getByRole("combobox", { name: "Domain" }));
    await user.click(await screen.findByRole("option", { name: "All domains" }));
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "All types" }));
    await waitFor(() => expect(summaries.at(-1)).toEqual({ shown: 5046, total: 5046, narrowed: false }));
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });

  it("hides the Type dropdown when the data carries no entry types", async () => {
    const bare = corpus(6);
    for (const node of bare.nodes) node.entryType = "";
    mount(vi.fn<KnowledgeGraphFetcher>(async () => bare));
    await waitFor(() => expect(screen.getByTestId("renderer")).toBeTruthy());
    expect(screen.getByRole("combobox", { name: "Domain" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Type" })).toBeNull();
  });

  it("clicking an entry selects it and highlights neighbours from memory; hubs are not selectable", async () => {
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async () => corpus(50));
    mount(fetchGraph);
    await waitFor(() => expect(screen.getByTestId("renderer").dataset.entries).toBe("50"));
    const before = renders.at(-1)?.graphData;
    fireEvent.click(screen.getByRole("button", { name: "Node domain:meta" }));
    expect(screen.getByText("Selected: none")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Node k-3" }));
    expect(screen.getByText("Selected: k-3")).toBeTruthy();
    expect(knowledgeGraphNeighbors(corpus(50)).get("k-3")?.has("k-4")).toBe(true);
    expect(dimmed("k-3")).toBe(false);
    expect(dimmed("k-4")).toBe(false);
    // k-3 is in "strategy": its hub stays lit, the other hub dims.
    expect(dimmed("domain:strategy")).toBe(false);
    expect(dimmed("domain:meta")).toBe(true);
    expect(dimmed("k-11")).toBe(true);
    expect(renders.at(-1)?.graphData).toBe(before);
    expect(fetchGraph).toHaveBeenCalledTimes(1);
  });

  it("a same-revision revalidation keeps the graph object; a 304 (null) too; a new revision replaces it", async () => {
    let revision = "rev-a";
    const seen: (string | undefined)[] = [];
    let notModified = false;
    const fetchGraph = vi.fn<KnowledgeGraphFetcher>(async (_signal, ifNoneMatch) => {
      seen.push(ifNoneMatch);
      return notModified ? null : corpus(30, revision);
    });
    const client = mount(fetchGraph);
    await waitFor(() => expect(screen.getByTestId("renderer").dataset.entries).toBe("30"));
    const first = renders.at(-1)?.graphData;
    const refetch = () =>
      act(async () => {
        await client.refetchQueries({ queryKey: ["knowledge", "graph"] });
      });
    await refetch();
    expect(renders.at(-1)?.graphData).toBe(first);
    notModified = true;
    await refetch();
    expect(renders.at(-1)?.graphData).toBe(first);
    expect(seen).toEqual([undefined, '"rev-a"', '"rev-a"']);
    notModified = false;
    revision = "rev-b";
    await refetch();
    await waitFor(() => expect(renders.at(-1)?.graphData).not.toBe(first));
  });

  it("escapes agent-authored labels and states a load failure plainly", async () => {
    mount(vi.fn<KnowledgeGraphFetcher>(async () => corpus(3)));
    const label = (await screen.findByRole("button", { name: "Node k-1" })).getAttribute(
      "title",
    );
    expect(label).toContain("&lt;img");
    expect(label).not.toContain("<img");
    expect(
      screen.getByRole("button", { name: "Node domain:meta" }).getAttribute("title"),
    ).toBe("<b>meta</b> · 2 entries");
    cleanup();
    mount(
      vi.fn<KnowledgeGraphFetcher>(async () => {
        throw Object.assign(new Error("busy"), { status: 503 });
      }),
    );
    await screen.findByText("Failed to load knowledge graph.");
  });
});

describe("knowledgeGraphRenderData", () => {
  it("keeps every entry and citation, adds one hub per domain with exact counts, and narrows edges and hubs together", () => {
    const graph = corpus(10);
    const plain = knowledgeGraphRenderData(graph, { hubs: false });
    expect(plain.nodes).toHaveLength(10);
    expect(plain.links).toHaveLength(20);
    expect(plain.nodes[0]).not.toBe(graph.nodes[0]);
    const hubbed = knowledgeGraphRenderData(graph, { hubs: true });
    expect(hubbed.nodes.filter((n) => n.isHub).map((n) => [n.id, n.entryCount])).toEqual([
      ["domain:meta", 5],
      ["domain:strategy", 5],
    ]);
    expect(hubbed.links.filter((l) => l.kind === "cite")).toHaveLength(20);
    expect(hubbed.links.filter((l) => l.kind === "member")).toHaveLength(10);
    const meta = knowledgeGraphRenderData(graph, { hubs: true, domain: "meta" });
    const visible = new Set(meta.nodes.filter((n) => !n.isHub).map((n) => n.id));
    expect(visible.size).toBe(5);
    expect(meta.nodes.filter((n) => n.isHub).map((n) => n.id)).toEqual(["domain:meta"]);
    expect(
      meta.links
        .filter((l) => l.kind === "cite")
        .every((l) => visible.has(String(l.source)) && visible.has(String(l.target))),
    ).toBe(true);
  });
});
