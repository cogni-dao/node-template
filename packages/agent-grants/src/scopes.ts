// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/scopes`
 * Purpose: Validate requested scopes against the node's declared scope list.
 * Scope: Pure function.
 * Invariants: NODE_DECLARED_SCOPES — the node declares its scopes in one place
 *   and passes them in; an undeclared scope is rejected before any write, so
 *   it can never be stored and never match a required scope.
 * Side-effects: none
 * @public
 */

import { AgentGrantsError } from "./types";

/** Returns the de-duplicated, sorted scopes or throws `invalid_scope`. */
export function validateScopes(
  requested: readonly string[],
  declared: readonly string[]
): string[] {
  const unique = [...new Set(requested)].sort();
  if (unique.length === 0) {
    throw new AgentGrantsError("invalid_scope", "at least one scope required");
  }
  const undeclared = unique.filter((scope) => !declared.includes(scope));
  if (undeclared.length > 0) {
    throw new AgentGrantsError(
      "invalid_scope",
      `undeclared scope: ${undeclared.join(", ")}`
    );
  }
  return unique;
}
