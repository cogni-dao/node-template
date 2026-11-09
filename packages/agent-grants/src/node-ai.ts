// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/node-ai`
 * Purpose: The admin table's rows for "This node's AI": one row per AI and permission, with the live Allow state.
 *   Pure; the node supplies the catalog-derived permissions and the live role list.
 * Scope: Name table (defaults a node may override) and the row builder. No I/O, no routes.
 * Invariants:
 *   - TOKENLESS_COPY: names and labels hold no token, id, key, scope string or API path.
 *   - Permissions come from the tool contracts (`requires.label`); a scope with no label is skipped, never shown raw.
 *   - An AI with no name entry gets a neutral name; the slug is never shown as the name.
 *   - PLAIN_NAMES: a grant gives a permission. No other noun.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import type { NodeAiPermissionView, ToolRequires } from "./types";

export interface NodeAiCopy {
  readonly name: string;
}

/** Default names for the seeded node AI. A node may pass its own table. */
export const NODE_AI_COPY: Readonly<Record<string, NodeAiCopy>> = {
  "node-ai": { name: "General assistant" },
  prioritizer: { name: "Priority scorer" },
};

const FALLBACK_COPY: NodeAiCopy = { name: "Node assistant" };

export function buildNodeAiView(input: {
  /** principal slug -> the `requires` of every tool its graphs list (duplicates allowed). */
  readonly permissionsByPrincipal: Readonly<Record<string, readonly ToolRequires[]>>;
  /** Live role rows: principal slug and scope. */
  readonly liveRoles: ReadonlyArray<{ principalSlug: string; scope: string }>;
  readonly copy?: Readonly<Record<string, NodeAiCopy>>;
}): NodeAiPermissionView[] {
  const copy = input.copy ?? NODE_AI_COPY;
  const live = new Set(input.liveRoles.map((r) => `${r.principalSlug}\u0000${r.scope}`));
  const rows: NodeAiPermissionView[] = [];
  for (const slug of Object.keys(input.permissionsByPrincipal).sort()) {
    const byScope = new Map<string, ToolRequires>();
    for (const requires of input.permissionsByPrincipal[slug] ?? []) {
      if (requires.label && !byScope.has(requires.scope))
        byScope.set(requires.scope, requires);
    }
    const ai = (copy[slug] ?? FALLBACK_COPY).name;
    const perms = [...byScope.values()]
      .map((r) => ({
        principal: slug,
        ai,
        scope: r.scope,
        permission: r.label as string,
        allowed: live.has(`${slug}\u0000${r.scope}`),
      }))
      .sort((a, b) => a.permission.localeCompare(b.permission));
    rows.push(...perms);
  }
  return rows;
}
