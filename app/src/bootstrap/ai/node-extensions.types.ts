// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/node-extensions.types`
 * Purpose: The shape of a node's declarations. Template-owned: node-template adds a field here when a package ships a new extension point, and a node's own
 *   `@/node-extensions` (which only imports this type) is never rewritten to receive it.
 * Scope: Types only. Each field has the type its owning package exports.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture
 * @internal
 */

import type { AgentRoutes } from "@cogni/agent-grants";
import type { CatalogBoundTool } from "@cogni/ai-tools";

import type { ToolBindingDeps, ToolBindings } from "./tool-bindings";

export interface NodeExtensions {
  /** Tools this node adds to the shared bundle (`@cogni/ai-tools`). Each carries its contract (with `requires`) and a static implementation. */
  readonly tools?: readonly CatalogBoundTool[];
  /**
   * Implementations that need an injected capability (a wallet, a client). Called once by the container with the capabilities it built; returns an
   * implementation for any tool id in `tools`, which replaces that tool's static one. An id that is not in `tools` throws.
   */
  readonly toolBindings?: (deps: ToolBindingDeps) => ToolBindings;
  /** Route twins for those tools, and route-only scopes (`@cogni/agent-grants`). */
  readonly routes?: AgentRoutes;
}
