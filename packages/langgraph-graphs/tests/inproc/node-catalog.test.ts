// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/node-catalog`
 * Purpose: createNodeCatalog rules and the discovery proof (task.0204).
 * Scope: Pure catalog composition over the package catalog. No provider, no LLM.
 * Invariants: EXPLICIT_COMPOSITION, COGNI_FOLLOWS_THE_CATALOG, FAIL_LOUD
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 */

import { describe, expect, it } from "vitest";
import { type CatalogEntry, LANGGRAPH_CATALOG } from "../../src/catalog";
import { createNodeCatalog } from "../../src/inproc/node-catalog";
import { requiresInProcess } from "../../src/inproc/provider/routing";

const plain: CatalogEntry = {
  displayName: "Plain",
  description: "a node graph",
  toolIds: ["core__get_current_time"],
  graphFactory: LANGGRAPH_CATALOG["work-prioritizer"]?.graphFactory as CatalogEntry["graphFactory"],
  systemPrompt: "plain prompt",
};

/** The graphs `cogni` advertises: the host-owned list at the end of its prompt. */
function advertised(catalog: Record<string, CatalogEntry>): string[] {
  const prompt = catalog.cogni?.systemPrompt ?? "";
  const json = prompt.slice(prompt.indexOf("Host-owned registered workflows:\n") + "Host-owned registered workflows:\n".length);
  return (JSON.parse(json.split("\n")[0] ?? "[]") as Array<{ id: string }>).map((w) => w.id.replace("langgraph:", ""));
}

describe("createNodeCatalog", () => {
  it("with no changes lists exactly the package graphs", () => {
    const catalog = createNodeCatalog(LANGGRAPH_CATALOG);
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(LANGGRAPH_CATALOG).sort());
    expect(advertised(catalog).sort()).toEqual(["cogni", "work-closeout", "work-prioritizer"]);
    expect(catalog.cogni?.systemPrompt).toBe(LANGGRAPH_CATALOG.cogni?.systemPrompt);
  });

  it("add: the node's graph runs and the cogni prompt lists it", () => {
    const catalog = createNodeCatalog(LANGGRAPH_CATALOG, { add: { "red-solver": plain } });
    expect(catalog["red-solver"]).toBe(plain);
    expect(advertised(catalog)).toContain("red-solver");
  });

  it("add: an unlisted graph runs but is not advertised", () => {
    const catalog = createNodeCatalog(LANGGRAPH_CATALOG, { add: { probe: { ...plain, listed: false } } });
    expect(catalog.probe).toBeDefined();
    expect(advertised(catalog)).not.toContain("probe");
  });

  it("add: a package graph id throws instead of overriding it", () => {
    expect(() => createNodeCatalog(LANGGRAPH_CATALOG, { add: { "work-prioritizer": plain } })).toThrow(
      "node_catalog_add_overrides_package_graph:work-prioritizer",
    );
  });

  it("omit: drops a package graph from the catalog and from the cogni prompt", () => {
    const catalog = createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["work-closeout"] });
    expect(catalog["work-closeout"]).toBeUndefined();
    expect(advertised(catalog).sort()).toEqual(["cogni", "work-prioritizer"]);
  });

  it("omit: cogni cannot be omitted and an unknown id throws", () => {
    expect(() => createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["cogni"] })).toThrow("node_catalog_cannot_omit_cogni");
    expect(() => createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["nope"] })).toThrow("node_catalog_omit_unknown_graph:nope");
  });

  it("narrow: removes tools and appends prompt text, never adds a tool; the cogni prompt shows the narrowed tools", () => {
    const base = LANGGRAPH_CATALOG["work-prioritizer"] as CatalogEntry;
    const catalog = createNodeCatalog(LANGGRAPH_CATALOG, {
      narrow: {
        "work-prioritizer": {
          removeToolIds: ["core__work_item_update", "core__work_item_artifact_record", "not-a-tool"],
          appendPrompt: "READ ONLY NOTE",
        },
      },
    });
    const narrowed = catalog["work-prioritizer"] as CatalogEntry;
    expect(narrowed.toolIds).toEqual(base.toolIds.filter((id) => id !== "core__work_item_update" && id !== "core__work_item_artifact_record"));
    expect(narrowed.toolIds.every((id) => base.toolIds.includes(id))).toBe(true);
    expect(narrowed.systemPrompt).toBe(`${base.systemPrompt}\n\nREAD ONLY NOTE`);
    expect(narrowed.principal).toBe(base.principal);
    expect(narrowed.graphFactory).toBe(base.graphFactory);
    const listed = JSON.parse(
      (catalog.cogni?.systemPrompt ?? "").split("Host-owned registered workflows:\n")[1]?.split("\n")[0] ?? "[]",
    ) as Array<{ id: string; toolIds: string[] }>;
    expect(listed.find((w) => w.id === "langgraph:work-prioritizer")?.toolIds).toEqual(narrowed.toolIds);
  });

  it("narrow: an unknown or omitted graph throws", () => {
    expect(() => createNodeCatalog(LANGGRAPH_CATALOG, { narrow: { nope: { removeToolIds: [] } } })).toThrow(
      "node_catalog_narrow_unknown_graph:nope",
    );
    expect(() =>
      createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["work-closeout"], narrow: { "work-closeout": {} } }),
    ).toThrow("node_catalog_narrow_unknown_graph:work-closeout");
  });

  it("discovery proof: the three node shapes list exactly their graphs", () => {
    const red = createNodeCatalog(LANGGRAPH_CATALOG, { omit: ["work-closeout"], add: { "red-solver": plain } });
    const poly = createNodeCatalog(LANGGRAPH_CATALOG, {
      omit: ["work-closeout"],
      add: { "poly-brain": plain, "poly-research": plain },
    });
    expect(advertised(red).sort()).toEqual(["cogni", "red-solver", "work-prioritizer"]);
    expect(advertised(poly).sort()).toEqual(["cogni", "poly-brain", "poly-research", "work-prioritizer"]);
    expect(Object.keys(poly).sort()).toEqual(["cogni", "poly-brain", "poly-research", "work-prioritizer"]);
  });
});

describe("requiresInProcess", () => {
  const bundle = [
    { contract: { name: "ro", effect: "read_only" } },
    { contract: { name: "rw", effect: "state_change" } },
    { contract: { name: "scoped", effect: "read_only", requires: { scope: "s", kind: "node", subject: "member" } } },
  ] as never;

  it("is true for a program, a principal, MCP tools, a write tool, a scoped tool or an unknown tool", () => {
    expect(requiresInProcess({ toolIds: ["ro"], program: "cogni" }, bundle)).toBe(true);
    expect(requiresInProcess({ toolIds: ["ro"], principal: "node-ai" }, bundle)).toBe(true);
    expect(requiresInProcess({ toolIds: ["ro"], mcpServerIds: ["m"] }, bundle)).toBe(true);
    expect(requiresInProcess({ toolIds: ["rw"] }, bundle)).toBe(true);
    expect(requiresInProcess({ toolIds: ["scoped"] }, bundle)).toBe(true);
    expect(requiresInProcess({ toolIds: ["missing"] }, bundle)).toBe(true);
  });

  it("is false only for a plain read-only graph", () => {
    expect(requiresInProcess({ toolIds: ["ro"] }, bundle)).toBe(false);
    expect(requiresInProcess({ toolIds: [] }, bundle)).toBe(false);
  });

  it("package catalog: cogni and work-prioritizer need the in-process provider", () => {
    expect(requiresInProcess(LANGGRAPH_CATALOG.cogni as CatalogEntry, [])).toBe(true);
    expect(requiresInProcess(LANGGRAPH_CATALOG["work-prioritizer"] as CatalogEntry, [])).toBe(true);
  });
});
