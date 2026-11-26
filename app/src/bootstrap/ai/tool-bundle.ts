// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/tool-bundle`
 * Purpose: The one composed tool bundle: the shared core tools, this node's local tools and the tools the node declares in `@/node-extensions`.
 *   The container builds it once; the tool source, the graph executor and the permission catalog all read it, so a node tool's `requires` reaches the catalog.
 * Scope: Composition only. Does not bind implementations to a source (`tool-source.factory.ts`).
 * Invariants: ONE_COMPOSED_BUNDLE; NODE_ADDS_ONLY (a duplicate tool id throws, naming both sources); NODE_OWNS_ITS_PREFIX.
 * Side-effects: calls the node's tool factory once
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @internal
 */

import { addOnly, assertOwnedToolIds, type Contribution } from "@cogni/extension-kit";
import { CORE_TOOL_BUNDLE, type CatalogBoundTool } from "@cogni/ai-tools";

import type { NodeExtensions, ToolHost } from "./node-extensions-host";
import { NODE_LOCAL_TOOL_BUNDLE } from "./secret-probe";
import type { ToolBindings } from "./tool-bindings";

/** One contribution per tool, so two tools with one id in a single list also collide. */
const sourcesOf = (source: string, tools: readonly CatalogBoundTool[]): Contribution<CatalogBoundTool>[] =>
  tools.map((tool) => ({ source, entries: { [tool.contract.name]: tool } }));

/**
 * The composition: core, then node-local, then the tools the node's factory returns for `host`. Throws on a repeated id, a `core__` id or a mixed prefix.
 * `extensionBindings` are the declared tools' own implementations, for the tool source's bindings.
 */
export function composeToolBundle(
  extensions: NodeExtensions,
  host: ToolHost
): { readonly bundle: readonly CatalogBoundTool[]; readonly extensionBindings: ToolBindings } {
  const declared = extensions.tools?.(host) ?? [];
  const nodePrefix = assertOwnedToolIds(declared) ?? "node";
  const merged = addOnly(
    { what: "tool", code: "TOOL_ID_DUPLICATE" },
    ...sourcesOf("core", CORE_TOOL_BUNDLE),
    ...sourcesOf("node-template", NODE_LOCAL_TOOL_BUNDLE),
    ...sourcesOf(nodePrefix, declared)
  );
  return {
    bundle: Object.values(merged),
    extensionBindings: Object.fromEntries(declared.map((tool) => [tool.contract.name, tool.implementation])),
  };
}
