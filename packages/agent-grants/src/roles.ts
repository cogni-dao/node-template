// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/roles`
 * Purpose: Principal lookup and the grant/revoke of role rows. The caller already passed the node admin gate.
 * Scope: Pure over the store. Role rows never grant account data.
 * Invariants:
 *   - NODE_DECLARED_SCOPES: an undeclared scope is rejected before any write.
 *   - Only an internal principal slug can receive a role here; no row means `principal_not_found`.
 *   - Revoke is soft: the row stays, `revoked_at` is set.
 * Side-effects: IO (store writes)
 * @public
 */

import type { AgentGrantsStore } from "./types";

export type RolesErrorCode = "principal_not_found" | "invalid_scope";

export class AgentRolesError extends Error {
  readonly code: RolesErrorCode;
  constructor(code: RolesErrorCode, message: string) {
    super(message);
    this.name = "AgentRolesError";
    this.code = code;
  }
}

/** The principal's seeded user id for a catalog slug, or null (the run is then denied). */
export async function resolveInternalPrincipal(
  store: AgentGrantsStore,
  slug: string
): Promise<string | null> {
  return (await store.findInternalPrincipal(slug))?.userId ?? null;
}

export async function grantRole(
  store: AgentGrantsStore,
  input: {
    principalSlug: string;
    scope: string;
    approvedBy: string;
    declaredScopes: readonly string[];
  }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const principalUserId = await resolveInternalPrincipal(
    store,
    input.principalSlug
  );
  if (!principalUserId)
    throw new AgentRolesError("principal_not_found", "unknown principal");
  const created = await store.insertRole({
    principalUserId,
    scope: input.scope,
    approvedBy: input.approvedBy,
  });
  return { principalUserId, created };
}

export async function revokeRole(
  store: AgentGrantsStore,
  input: { principalSlug: string; scope: string }
): Promise<{ principalUserId: string; revoked: boolean }> {
  const principalUserId = await resolveInternalPrincipal(
    store,
    input.principalSlug
  );
  if (!principalUserId)
    throw new AgentRolesError("principal_not_found", "unknown principal");
  const revoked = await store.revokeRole({
    principalUserId,
    scope: input.scope,
  });
  return { principalUserId, revoked };
}
