// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/tool-bundle`
 * Purpose: The one composed tool bundle: the shared core tools, this node's local tools and the tools the node declares in `@/node-extensions`.
 *   The tool source, the graph executor and the permission catalog all read this, so a node tool's `requires` reaches the catalog.
 * Scope: Composition only. Does not bind implementations to a source (`tool-source.factory.ts`).
 * Invariants: ONE_COMPOSED_BUNDLE; a duplicate tool id throws at import (a node adds, it never replaces).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @internal
 */

import { CORE_TOOL_BUNDLE, type CatalogBoundTool } from "@cogni/ai-tools";

import { nodeExtensions } from "@/node-extensions";

import type { NodeExtensions } from "./node-extensions.types";

import { NODE_LOCAL_TOOL_BUNDLE } from "./secret-probe";
import type { ToolBindingDeps, ToolBindings } from "./tool-bindings";

/** The composition: core, then node-local, then the node's declared tools. Throws on a repeated tool id. */
export function composeToolBundle(extensions: NodeExtensions): readonly CatalogBoundTool[] {
  const bundle = [...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE, ...(extensions.tools ?? [])];
  const seen = new Set<string>();
  for (const tool of bundle) {
    const id = tool.contract.name;
    if (seen.has(id)) throw new Error(`TOOL_ID_DUPLICATE: tool "${id}" is declared twice; a node adds tools, it never replaces one`);
    seen.add(id);
  }
  return bundle;
}

/** Each declared tool's implementation, as the tool source reads it: its static one, replaced by the factory's for the ids the factory returns. */
export function extensionToolBindings(extensions: NodeExtensions, deps: ToolBindingDeps): ToolBindings {
  const declared = new Set((extensions.tools ?? []).map((tool) => tool.contract.name));
  const bindings: Record<string, ToolBindings[string]> = Object.fromEntries(
    (extensions.tools ?? []).map((tool) => [tool.contract.name, tool.implementation])
  );
  for (const [id, implementation] of Object.entries(extensions.toolBindings?.(deps) ?? {})) {
    if (!declared.has(id)) throw new Error(`TOOL_BINDING_UNDECLARED: binding for "${id}", which is not a tool in node-extensions tools`);
    bindings[id] = implementation;
  }
  return bindings;
}

/** The one bundle this node runs with. */
export const NODE_TOOL_BUNDLE: readonly CatalogBoundTool[] = composeToolBundle(nodeExtensions);

/** `{ id, requires }` records of the bundle, the shape the permission catalog and the authority read. */
export const NODE_TOOL_REQUIRES_RECORDS: ReadonlyArray<{ id: string; requires: CatalogBoundTool["contract"]["requires"] }> =
  NODE_TOOL_BUNDLE.map((tool) => ({ id: tool.contract.name, requires: tool.contract.requires }));
