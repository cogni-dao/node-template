// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/rights`
 * Purpose: The org roles and how they nest, as ONE table, and the one question every org route asks: does this person hold this right on this account?
 * Scope: Pure over the store port. No SQL, no routes.
 * Invariants:
 *   - ROLES_NEST: `org:owner` includes `org:admin`, and `org:admin` includes `account:read` on the org's account (the scope the usage and billing views already check).
 *     A caller holds a right when it holds a live grant for ANY scope that covers it. There is no second check and no members table (ORG_IS_AN_ACCOUNT).
 *   - TWO_ROLES: P1 has `org:owner` and `org:admin` only. Any other scope is an ordinary scope that covers only itself.
 * Side-effects: IO (one store read)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import type { AgentGrantsStore } from "./types";

export const ORG_OWNER = "org:owner";
export const ORG_ADMIN = "org:admin";
export const ACCOUNT_READ = "account:read";

export type OrgRole = "owner" | "admin";

/** The scope a role row carries. */
export const scopeOfRole = (role: OrgRole): string => (role === "owner" ? ORG_OWNER : ORG_ADMIN);

/** The role a scope names, or null for any other scope. */
export const roleOfScope = (scope: string): OrgRole | null => (scope === ORG_OWNER ? "owner" : scope === ORG_ADMIN ? "admin" : null);

/** Every scope that grants `scope`, itself included: the nesting `org:owner` ⊇ `org:admin` ⊇ `account:read`. */
export function scopesCovering(scope: string): readonly string[] {
  if (scope === ORG_OWNER) return [ORG_OWNER];
  if (scope === ORG_ADMIN) return [ORG_ADMIN, ORG_OWNER];
  if (scope === ACCOUNT_READ) return [ACCOUNT_READ, ORG_ADMIN, ORG_OWNER];
  return [scope];
}

/** True when `userId` holds a live grant (any credential, any kind of caller) on exactly this account for `scope` or any scope that covers it. Never cached; a store failure throws. */
export async function holdsAccountRight(store: AgentGrantsStore, userId: string, scope: string, accountId: string): Promise<boolean> {
  return (await store.liveAccountScopes(userId, scopesCovering(scope), accountId)).length > 0;
}
