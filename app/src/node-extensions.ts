// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@/node-extensions`
 * Purpose: The one node composition root. A node declares what it adds here and nowhere else: its own tools and its own route twins and route-only
 *   scopes. `bootstrap/container.ts` reads it and hands each field to the package that owns the extension point. Beside `node-config.ts`.
 * Scope: Declarations only, through `defineNodeExtensions`. The shape is template-owned (`bootstrap/ai/node-extensions-host.ts`), so a new extension point
 *   reaches a node without rewriting this file. Node-template declares nothing: the baseline runs unchanged. A node's own copy is never overwritten by a sync.
 * Invariants:
 *   - NODE_ADDS_ONLY: a duplicate tool id, a route key the package already holds, or a scope declared twice with different fields throws at construction.
 *   - NODE_OWNS_ITS_PREFIX: every tool id starts with the node's own `<node>__`; `core__` is rejected.
 *   - ONE_COMPOSED_BUNDLE: `tools` joins the bundle the tool source, the graph executor and the permission catalog all read (`container.toolBundle`).
 *   - A tool is a factory over the host's services: `tools: (host) => [...]`, so a wallet or client needs no `container.ts` edit.
 *   - A write tool declared here must record its acting principal (activity-attribution), and needs a route twin or an exemption in `routes`.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-plugin-architecture, https://node-template.cognidao.org/knowledge/add-a-node-permission
 * @public
 */

import { defineNodeExtensions } from "@/bootstrap/ai/node-extensions-host";

export const nodeExtensions = defineNodeExtensions({});
