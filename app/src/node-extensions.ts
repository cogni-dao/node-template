// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/node-extensions`
 * Purpose: The one node composition root. A node declares what it adds here and nowhere else: its own tools and its own route twins and
 *   route-only scopes. `bootstrap/container.ts` reads it and hands each field to the package that owns the extension point. Beside `node-config.ts`.
 * Scope: Declarations only. Each field has the type its owning package exports. Node-template declares nothing: this object is empty, and the
 *   baseline runs unchanged. A node's own copy of this file is never overwritten by a node-template sync.
 * Invariants:
 *   - NODE_ADDS_ONLY: a duplicate tool id, a route key the package already holds, or a scope declared twice with different fields throws at construction.
 *   - ONE_COMPOSED_BUNDLE: `tools` joins the bundle that the tool source, the graph executor and the permission catalog all read (`bootstrap/ai/tool-bundle.ts`).
 *   - A tool with `requires` and no entry in `routes` fails the node's parity test (`tests/unit/bootstrap/node-tool-bundle.test.ts`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture, https://node-template.cognidao.org/knowledge/add-a-node-permission
 * @public
 */

import type { AgentRoutes } from "@cogni/agent-grants";
import type { CatalogBoundTool } from "@cogni/ai-tools";

export interface NodeExtensions {
  /** Tools this node adds to the shared bundle (`@cogni/ai-tools`). Each carries its contract (with `requires`) and its implementation. */
  readonly tools?: readonly CatalogBoundTool[];
  /** Route twins for those tools, and route-only scopes (`@cogni/agent-grants`). */
  readonly routes?: AgentRoutes;
}

export const nodeExtensions: NodeExtensions = {};
