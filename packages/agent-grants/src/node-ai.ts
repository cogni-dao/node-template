// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/node-ai`
 * Purpose: The table's rows: Who · Can do · Until · On. One row = one grant row, in three blocks:
 *   asks waiting (pending), this node's AI, and outside agents. `buildNodeAiView` builds the admin table (node rows);
 *   `buildAccountAiView` builds the profile table (account rows on the viewer's own account).
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

import type { NodeAiPermissionView, PendingAskView, RoleRow } from "./types";

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
      resource: "node",
      rowId: row.rowId,
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
            resource: "node" as const,
            rowId: input.rows.find((r) => r.principalUserId === ai.userId && r.scope === scope && r.state === "granted")?.rowId ?? null,
          },
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    out.push(...rows);
  }

  // 3. Outside agents: live rows for anyone who is not one of this node's AI.
  for (const row of input.rows.filter((r) => r.state === "granted" && !r.internal)) {
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
      resource: "node",
      rowId: row.rowId,
    });
  }
  return out;
}

/**
 * One waiting ask found by its one-time link token, as a table row (section `pending`, Off, `viaLink`). The page highlights it and sends the
 * token back to decide it. Null when the scope has no declaration (never shown raw).
 */
export function buildAskView(
  ask: PendingAskView,
  declarations: Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>
): NodeAiPermissionView | null {
  const d = declarations[ask.scope];
  if (!d?.label || !d.description) return null;
  return {
    section: "pending",
    principalUserId: ask.principalUserId,
    who: ask.name ?? NEUTRAL_WHO,
    outside: !ask.internal,
    hint: ask.hint,
    scope: ask.scope,
    label: d.label,
    description: d.description,
    on: false,
    until: null,
    resource: ask.resource,
    rowId: null,
    viaLink: true,
  };
}

/**
 * The profile table: the same shape and the same three blocks, for ONE person's account. `rows` are the live account rows on the viewer's own
 * account (this node's AI and outside agents alike); `scopesByPrincipal` is the account-kind scopes each of this node's AI may use (so each
 * shows Off until the person turns it On, no ask); `ask` is a pending outside ask the person opened with its one-time link.
 * Invariants: PROFILE_NEVER_SHOWS_NODE_ROWS and ADMIN_NEVER_SHOWS_ACCOUNT_ROWS: this builder takes account rows only and the admin builder node rows only.
 */
export function buildAccountAiView(input: {
  readonly declarations: Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>;
  readonly scopesByPrincipal: Readonly<Record<string, readonly string[]>>;
  readonly internal: ReadonlyArray<{ userId: string; slug: string }>;
  /** Live account rows on the viewer's account. */
  readonly rows: readonly RoleRow[];
  /** A pending account ask found by link token, or null. */
  readonly ask: PendingAskView | null;
}): NodeAiPermissionView[] {
  const named = (scope: string) => {
    const d = input.declarations[scope];
    return d?.label && d.description ? { label: d.label, description: d.description } : null;
  };
  const out: NodeAiPermissionView[] = [];
  const live = input.rows.filter((r) => r.resource === "account" && r.state === "granted");

  if (input.ask && input.ask.resource === "account") {
    const view = buildAskView(input.ask, input.declarations);
    if (view) out.push(view);
  }

  for (const slug of Object.keys(input.scopesByPrincipal).sort()) {
    const ai = input.internal.find((p) => p.slug === slug);
    if (!ai) continue;
    const scopes = [...new Set(input.scopesByPrincipal[slug] ?? [])];
    const rows = scopes
      .flatMap((scope) => {
        const n = named(scope);
        if (!n) return [];
        const row = live.find((r) => r.principalUserId === ai.userId && r.scope === scope);
        return [
          {
            section: "node" as const,
            principalUserId: ai.userId,
            who: ai.slug, // NAMES_ARE_IDENTIFIERS: the slug is the name
            outside: false,
            hint: null,
            scope,
            ...n,
            on: row !== undefined,
            until: row?.expiresAt ?? null,
            resource: "account" as const,
            rowId: row?.rowId ?? null,
          },
        ];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    out.push(...rows);
  }

  for (const row of live.filter((r) => !r.internal)) {
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
      until: row.expiresAt,
      resource: "account",
      rowId: row.rowId,
    });
  }
  return out;
}
