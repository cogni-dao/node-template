// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/roles`
 * Purpose: Principal lookup, the ask (an agent requests a scope for itself), and the admin's yes, no and take-back on grant rows.
 *   The caller already passed the node admin gate for every admin function here.
 * Scope: Pure over the store. Role rows never grant account data.
 * Invariants:
 *   - NODE_DECLARED_SCOPES: an undeclared scope is rejected before any write, on the ask and on the grant.
 *   - REQUEST_IS_AN_OFF_ROW: an ask is a row with no approver. It opens no lock until an admin approves it.
 *   - NO_SELF_APPROVAL: `requestAccess` can only write a pending row for the caller; only `approveRequest` sets an approver,
 *     and it refuses an approver who is the asking principal.
 *   - Revoke is soft: the row stays, `revoked_at` is set. A deny is the same soft write on a row that was never approved.
 * Side-effects: IO (store writes)
 * @public
 */

import type { AgentGrantsStore, RoleState } from "./types";

export type RolesErrorCode =
  | "principal_not_found"
  | "invalid_scope"
  | "not_pending"
  | "self_approval"
  | "too_many_requests";

export class AgentRolesError extends Error {
  readonly code: RolesErrorCode;
  constructor(code: RolesErrorCode, message: string) {
    super(message);
    this.name = "AgentRolesError";
    this.code = code;
  }
}

/** Open asks one agent may hold at once. */
export const MAX_PENDING_PER_AGENT = 20;

/** A principal named by catalog slug (internal AI) or by user id (any agent). */
export type PrincipalRef =
  | { readonly principalSlug: string; readonly principalUserId?: undefined }
  | { readonly principalUserId: string; readonly principalSlug?: undefined };

/** The principal's seeded user id for a catalog slug, or null (the run is then denied). */
export async function resolveInternalPrincipal(
  store: AgentGrantsStore,
  slug: string
): Promise<string | null> {
  return (await store.findInternalPrincipal(slug))?.userId ?? null;
}

async function resolveRef(
  store: AgentGrantsStore,
  ref: PrincipalRef
): Promise<{ userId: string; internal: boolean }> {
  if (ref.principalSlug !== undefined) {
    const userId = await resolveInternalPrincipal(store, ref.principalSlug);
    if (!userId) throw new AgentRolesError("principal_not_found", "unknown principal");
    return { userId, internal: true };
  }
  const internal = (await store.listInternalPrincipals()).some(
    (p) => p.userId === ref.principalUserId
  );
  return { userId: ref.principalUserId, internal };
}

/** An agent asks for a scope for itself. Idempotent: a pending or live row is reported, not duplicated. */
export async function requestAccess(
  store: AgentGrantsStore,
  input: { principalUserId: string; scope: string; declaredScopes: readonly string[] }
): Promise<{ state: "pending" | "granted"; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const result = await store.requestRole({
    principalUserId: input.principalUserId,
    scope: input.scope,
    maxPending: MAX_PENDING_PER_AGENT,
  });
  if (result === "too_many")
    throw new AgentRolesError("too_many_requests", "too many open requests");
  return { state: result === "granted" ? "granted" : "pending", created: result === "created" };
}

/** The agent's own rows, by state. */
export async function listOwnAccess(
  store: AgentGrantsStore,
  principalUserId: string
): Promise<Array<{ scope: string; state: RoleState; at: string }>> {
  return store.listOwnRoles(principalUserId);
}

/**
 * The admin turns a row ON. A pending ask is approved; an internal AI with no row gets a live row. An outside agent with no
 * ask cannot be granted: it has to ask first.
 */
export async function grantRole(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string; approvedBy: string; declaredScopes: readonly string[] }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const { userId, internal } = await resolveRef(store, input);
  if (userId === input.approvedBy)
    throw new AgentRolesError("self_approval", "an approver cannot approve its own row");
  if (await store.approvePending({ principalUserId: userId, scope: input.scope, approvedBy: input.approvedBy }))
    return { principalUserId: userId, created: true };
  if (!internal) {
    // No pending ask: if it is already live this is a no-op, else the agent must ask first.
    if (await store.hasLiveRole(userId, input.scope)) return { principalUserId: userId, created: false };
    throw new AgentRolesError("not_pending", "no pending ask for this agent and scope");
  }
  const created = await store.insertRole({
    principalUserId: userId,
    scope: input.scope,
    approvedBy: input.approvedBy,
  });
  return { principalUserId: userId, created };
}

/** The admin turns a live row OFF. */
export async function revokeRole(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string }
): Promise<{ principalUserId: string; revoked: boolean }> {
  const { userId } = await resolveRef(store, input);
  const revoked = await store.revokeRole({ principalUserId: userId, scope: input.scope });
  return { principalUserId: userId, revoked };
}

/** The admin dismisses a pending ask (the x). The agent sees `denied`. */
export async function denyRequest(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string }
): Promise<{ principalUserId: string; denied: boolean }> {
  const { userId } = await resolveRef(store, input);
  const denied = await store.denyPending({ principalUserId: userId, scope: input.scope });
  return { principalUserId: userId, denied };
}
