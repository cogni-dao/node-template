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

import { type NodeExtensions, nodeExtensions } from "@/node-extensions";

import { NODE_LOCAL_TOOL_BUNDLE } from "./secret-probe";
import type { ToolBindings } from "./tool-bindings";

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

/** Each declared tool's own implementation, as the tool source reads it. */
export function extensionToolBindings(extensions: NodeExtensions): ToolBindings {
  return Object.fromEntries((extensions.tools ?? []).map((tool) => [tool.contract.name, tool.implementation]));
}

/** The one bundle this node runs with. */
export const NODE_TOOL_BUNDLE: readonly CatalogBoundTool[] = composeToolBundle(nodeExtensions);

/** Bindings for the tools in `nodeExtensions.tools`. */
export const NODE_EXTENSION_TOOL_BINDINGS: ToolBindings = extensionToolBindings(nodeExtensions);

/** `{ id, requires }` records of the bundle, the shape the permission catalog and the authority read. */
export const NODE_TOOL_REQUIRES_RECORDS: ReadonlyArray<{ id: string; requires: CatalogBoundTool["contract"]["requires"] }> =
  NODE_TOOL_BUNDLE.map((tool) => ({ id: tool.contract.name, requires: tool.contract.requires }));
