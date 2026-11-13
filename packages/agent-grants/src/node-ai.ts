// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/node-ai`
 * Purpose: The admin table's rows: Who · Can do · Until · On. One row = one grant row, in three blocks:
 *   asks waiting (pending), this node's AI, outside agents, and owners' delegations (read-only apart from Off).
 * Scope: Pure row builder. No I/O, no routes, no copy table.
 * Invariants:
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: the permission's name and description come only from the declaration
 *     (`requires.label`, `requires.description`). A scope with no declaration is skipped, never shown raw.
 *   - NAMES_ARE_IDENTIFIERS: the Who is an identifier, never a vanity label: the slug for this node's AI, the registered name for
 *     an outside agent. All the human words are in the declaration (Can do). There is no copy table and no display name.
 *   - TOKENLESS_COPY: names, descriptions and hints hold no token, id, key, scope string or API path.
 *   - PLAIN_NAMES: a grant gives a permission. No other noun.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import type { NodeAiPermissionView, RoleRow } from "./types";

const NEUTRAL_WHO = "Unnamed agent";

export function buildNodeAiView(input: {
  /** scope -> the declaration (`requires`) that names it: every tool contract and every route-only capability. */
  readonly declarations: Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>;
  /** catalog principal slug -> the scopes its graphs may use (duplicates allowed). */
  readonly scopesByPrincipal: Readonly<Record<string, readonly string[]>>;
  /** Internal AI: user id and slug. */
  readonly internal: ReadonlyArray<{ userId: string; slug: string }>;
  /** Every pending and live row, any principal. */
  readonly rows: readonly RoleRow[];
}): NodeAiPermissionView[] {
  const named = (scope: string) => {
    const d = input.declarations[scope];
    return d?.label && d.description ? { label: d.label, description: d.description } : null;
  };
  const out: NodeAiPermissionView[] = [];

  // 1. Asks waiting: any principal with a pending row.
  for (const row of input.rows.filter((r) => r.state === "pending")) {
    const n = named(row.scope);
    if (!n) continue;
    out.push({
      section: "pending",
      principalUserId: row.principalUserId,
      who: row.name ?? NEUTRAL_WHO,
      outside: !row.internal,
      hint: row.hint,
      scope: row.scope,
      ...n,
      on: false,
      until: null,
    });
  }

  // 2. This node's AI: each catalog AI by each scope it may use, on when a live row exists.
  const live = new Set(input.rows.filter((r) => r.state === "granted").map((r) => `${r.principalUserId}\u0000${r.scope}`));
  const pending = new Set(input.rows.filter((r) => r.state === "pending").map((r) => `${r.principalUserId}\u0000${r.scope}`));
  for (const slug of Object.keys(input.scopesByPrincipal).sort()) {
    const ai = input.internal.find((p) => p.slug === slug);
    if (!ai) continue;
    const scopes = [...new Set(input.scopesByPrincipal[slug] ?? [])];
    const rows = scopes
      .flatMap((scope) => {
        const n = named(scope);
        // A pending ask for this scope is shown in the asks block, not twice.
        if (!n || pending.has(`${ai.userId}\u0000${scope}`)) return [];
        return [
          {
            section: "node" as const,
            principalUserId: ai.userId,
            who: ai.slug, // NAMES_ARE_IDENTIFIERS: the slug is the name
            outside: false,
            hint: null,
            scope,
            ...n,
            on: live.has(`${ai.userId}\u0000${scope}`),
            until: null,
          },
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    out.push(...rows);
  }

  // 3. Outside agents: live node rows for anyone who is not one of this node's AI.
  for (const row of input.rows.filter((r) => r.state === "granted" && !r.internal && !r.personal)) {
    const n = named(row.scope);
    if (!n) continue;
    out.push({
      section: "outside",
      principalUserId: row.principalUserId,
      who: row.name ?? NEUTRAL_WHO,
      outside: true,
      hint: row.hint,
      scope: row.scope,
      ...n,
      on: true,
      until: null,
    });
  }
  // 4. Owners' delegations: live personal rows. The admin cannot approve one (the owner did), but may turn it Off: the kill switch.
  for (const row of input.rows.filter((r) => r.state === "granted" && r.personal)) {
    const n = named(row.scope);
    if (!n) continue;
    out.push({
      section: "personal",
      principalUserId: row.principalUserId,
      who: row.name ?? NEUTRAL_WHO,
      outside: true,
      hint: row.hint,
      scope: row.scope,
      ...n,
      on: true,
      until: row.until ?? null,
    });
  }
  return out;
}
