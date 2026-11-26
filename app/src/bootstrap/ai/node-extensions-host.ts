// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/node-extensions-host`
 * Purpose: This host's instance of the node declaration type. Template-owned: node-template adds a field in `@cogni-dao/extension-kit` when a package ships a new
 *   extension point, and a node's own `@/node-extensions` (which only calls `defineNodeExtensions`) is never rewritten to receive it.
 * Scope: Types and one re-bound function. `ToolHost` is what a node's tool factory receives: the capabilities core tools get.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @beta
 */

import { defineNodeExtensions as define, type NodeExtensions as KitNodeExtensions } from "@cogni/extension-kit";

import type { ToolBindingDeps } from "./tool-bindings";

/** The services a node's tool factory receives. */
export type ToolHost = ToolBindingDeps;

export type NodeExtensions = KitNodeExtensions<ToolHost>;

export const defineNodeExtensions: (declaration: NodeExtensions) => Readonly<NodeExtensions> = define<ToolHost>;
