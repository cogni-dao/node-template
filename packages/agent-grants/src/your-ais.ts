// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/your-ais`
 * Purpose: The rows of the owner's "Your AIs" permission block: one row per personal grant row of an AI this person owns.
 * Scope: Pure row builder. No I/O, no routes, no copy table. Node rows never reach it (the store lists personal rows only).
 * Invariants:
 *   - DECLARED_ONCE_SHOWN_EVERYWHERE: the name and description of a permission come only from its declaration. A scope with no declaration is skipped.
 *   - NAMES_ARE_IDENTIFIERS: the Who is the AI's registered name. A nameless AI is shown as "Unnamed AI".
 *   - TOKENLESS_COPY: a row holds no token, key or API path. The ids are the opaque handles a click sends back.
 * Side-effects: none
 * @public
 */

import type { PersonalRow, YourAiPermissionView } from "./types";

const NEUTRAL_WHO = "Unnamed AI";

export function buildYourAisView(input: {
  /** scope -> its declaration (`requires`). */
  readonly declarations: Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>;
  readonly rows: readonly PersonalRow[];
}): YourAiPermissionView[] {
  const out: YourAiPermissionView[] = [];
  for (const row of input.rows) {
    const d = input.declarations[row.scope];
    if (!d?.label || !d.description) continue;
    out.push({
      requestId: row.requestId,
      principalUserId: row.principalUserId,
      who: row.name?.trim() || NEUTRAL_WHO,
      scope: row.scope,
      label: d.label,
      description: d.description,
      on: row.state === "granted",
      until: row.state === "granted" ? row.expiresAt : null,
    });
  }
  // Asks waiting first (they need a decision), then by AI name, then by permission name.
  return out.sort(
    (a, b) => Number(a.on) - Number(b.on) || a.who.localeCompare(b.who) || a.label.localeCompare(b.label)
  );
}
