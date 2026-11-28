// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/node-catalog`
 * Purpose: One explicit way for a node to register its graphs on the package catalog.
 * Scope: Pure catalog composition. Builds no graph, reads no env, imports nothing from a node.
 * Invariants:
 *   - EXPLICIT_COMPOSITION: `add`, `narrow` and `omit` are the only ways a node changes the catalog; no merge order decides
 *     which entry wins. `add` never replaces a package graph, `narrow` never adds a tool, a principal or a factory.
 *   - COGNI_FOLLOWS_THE_CATALOG: `cogni` is rebuilt from the composed set, so its prompt and its workflow guidance list
 *     exactly the graphs the provider can run and discovery advertises (`listed: false` entries excepted). `cogni`
 *     itself can be narrowed but never added over or omitted.
 *   - FAIL_LOUD: an unknown id in `narrow` or `omit`, a package id in `add`, or `omit: ["cogni"]` throws at construction.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @public
 */

import {
  type CatalogEntry,
  cogniSystemPromptOf,
  createCogniGraphFactoryFor,
  type LangGraphCatalog,
} from "../catalog";

export interface NodeCatalogChanges {
  /** Graphs the node owns. An id that the base catalog already has throws. */
  readonly add?: Readonly<Record<string, CatalogEntry>>;
  /** Remove tools from a graph and append prompt text. It never adds a tool. */
  readonly narrow?: Readonly<
    Record<
      string,
      { readonly removeToolIds?: readonly string[]; readonly appendPrompt?: string }
    >
  >;
  /** Package graphs the node does not run (for example `work-closeout`). `cogni` cannot be omitted. */
  readonly omit?: readonly string[];
}

const COGNI = "cogni";

/** The node's catalog: the package catalog plus `add`, minus `omit`, with `narrow` applied, and `cogni` rebuilt over the result. */
export function createNodeCatalog(
  base: LangGraphCatalog,
  node: NodeCatalogChanges = {},
): LangGraphCatalog {
  const { add = {}, narrow = {}, omit = [] } = node;
  const baseCogni = base[COGNI];
  if (!baseCogni) throw new Error("node_catalog_base_has_no_cogni");

  for (const id of Object.keys(add)) {
    if (id in base) throw new Error(`node_catalog_add_overrides_package_graph:${id}`);
  }
  for (const id of omit) {
    if (id === COGNI) throw new Error("node_catalog_cannot_omit_cogni");
    if (!(id in base)) throw new Error(`node_catalog_omit_unknown_graph:${id}`);
  }
  const omitted = new Set(omit);
  const known = new Set(Object.keys({ ...base, ...add }).filter((id) => !omitted.has(id)));
  for (const id of Object.keys(narrow)) {
    if (!known.has(id)) throw new Error(`node_catalog_narrow_unknown_graph:${id}`);
  }

  const composed: Record<string, CatalogEntry> = {};
  const appended = new Map<string, string>();
  for (const [id, entry] of Object.entries({ ...base, ...add })) {
    if (omitted.has(id)) continue;
    const change = narrow[id];
    if (!change) {
      composed[id] = entry;
      continue;
    }
    const removed = new Set(change.removeToolIds ?? []);
    if (change.appendPrompt) appended.set(id, change.appendPrompt);
    // `cogni` carries a computed prompt; it is rebuilt below, so only its tools are narrowed here.
    const { systemPrompt, ...rest } = entry;
    composed[id] = {
      ...rest,
      toolIds: entry.toolIds.filter((tool) => !removed.has(tool)),
      ...(id !== COGNI &&
        (systemPrompt !== undefined || change.appendPrompt) && {
          systemPrompt: [systemPrompt, change.appendPrompt].filter(Boolean).join("\n\n"),
        }),
    };
  }

  const cogniShape = composed[COGNI] as CatalogEntry;
  const cogniAppend = appended.get(COGNI);
  const { systemPrompt: _computed, ...cogniRest } = cogniShape;
  const result: Record<string, CatalogEntry> = { ...composed };
  result[COGNI] = {
    ...cogniRest,
    graphFactory: createCogniGraphFactoryFor(() => result),
    get systemPrompt(): string {
      const prompt = cogniSystemPromptOf(result);
      return cogniAppend ? `${prompt}\n\n${cogniAppend}` : prompt;
    },
  };
  return result;
}
