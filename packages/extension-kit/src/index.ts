// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/extension-kit`
 * Purpose: The host's side of the node plugin contract. A node declares what it adds through `defineNodeExtensions`; the host merges declarations
 *   with `addOnly`. `NodeExtensions` is the one aggregate of the extension points the owning packages export.
 * Scope: Types from the owning packages, one re-export of agent-grants' `addOnly`, and two small functions over plain records. No node import.
 * Invariants:
 *   - NODE_ADDS_ONLY: a key declared twice throws, naming the key and both sources. The result never depends on the order of the sources.
 *   - NODE_OWNS_ITS_PREFIX: a node's tool ids all start with the same `<node>__`; `core__` belongs to the shared bundle and is rejected.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @beta
 */

import type { AgentRoutes } from "@cogni/agent-grants";
import type { CatalogBoundTool } from "@cogni/ai-tools";

/**
 * What a node declares. `Host` is the services the host hands a tool factory (the capabilities core tools get); the host instantiates it once.
 * @beta
 */
export interface NodeExtensions<Host> {
  /** Tools this node adds to the shared bundle. Called once by the host with its services; a tool binds its wallet or client from `host`. Ids start with `<node>__`. */
  readonly tools?: (host: Host) => readonly CatalogBoundTool[];
  /** Route twins for those tools, and route-only scopes. */
  readonly routes?: AgentRoutes;
}

/**
 * The one entry point a node's `node-extensions.ts` calls: types the declaration and freezes it.
 * @beta
 */
export function defineNodeExtensions<Host>(declaration: NodeExtensions<Host>): Readonly<NodeExtensions<Host>> {
  return Object.freeze({ ...declaration });
}

/**
 * The `<node>__` prefix shared by a node's tool ids. Throws on a `core__` id, an id with no prefix, or two different prefixes.
 * @beta
 */
export function assertOwnedToolIds(tools: ReadonlyArray<{ readonly contract: { readonly name: string } }>): string | undefined {
  let prefix: string | undefined;
  for (const { contract } of tools) {
    const id = contract.name;
    const own = /^([a-z][a-z0-9]*)__/.exec(id)?.[1];
    if (own === undefined) throw new Error(`EXTENSION_ID_PREFIX: tool "${id}" must start with "<node>__" (lower-case letters and digits)`);
    if (own === "core") throw new Error(`EXTENSION_ID_RESERVED: tool "${id}" uses core__, which belongs to the shared bundle`);
    if (prefix !== undefined && prefix !== own)
      throw new Error(`EXTENSION_ID_PREFIX: tool "${id}" starts with "${own}__" but this node's other tools start with "${prefix}__"`);
    prefix = own;
  }
  return prefix;
}

/**
 * The add-only merge and its source type: the one implementation, in `@cogni-dao/agent-grants`, re-exported so a node and the host use the same function.
 * @beta
 */
export { addOnly, type Contribution } from "@cogni/agent-grants";
