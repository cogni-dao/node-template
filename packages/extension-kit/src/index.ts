// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/extension-kit`
 * Purpose: The host's side of the node plugin contract. A node declares what it adds through `defineNodeExtensions`; the host merges declarations
 *   with `addOnly`. `NodeExtensions` is the one aggregate of the extension points the owning packages export.
 * Scope: Types from the owning packages (type-only imports) and two small functions over plain records. No runtime dependency, no node import.
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
 * One source of entries: its name (shown in every error) and the entries by key.
 * @beta
 */
export interface Contribution<T> {
  readonly source: string;
  readonly entries: Readonly<Record<string, T>> | undefined;
}

/**
 * The add-only merge. Throws when a key is declared by two sources, naming the key and both sources (sorted, so the message never depends on source order).
 * `same` lets an equal repeat count as one declaration; without it any repeat throws.
 * @beta
 */
export function addOnly<T>(
  options: { readonly what: string; readonly code?: string | undefined; readonly same?: ((a: T, b: T) => boolean) | undefined },
  ...sources: ReadonlyArray<Contribution<T>>
): Record<string, T> {
  const merged: Record<string, T> = {};
  const owner: Record<string, string> = {};
  for (const { source, entries } of sources)
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        if (options.same?.(merged[key] as T, value)) continue;
        const [a, b] = [owner[key] as string, source].sort();
        throw new Error(`${options.code ?? "EXTENSION_CONFLICT"}: ${options.what} "${key}" is declared by "${a}" and again by "${b}"; a node adds, it never replaces`);
      }
      merged[key] = value;
      owner[key] = source;
    }
  return merged;
}
