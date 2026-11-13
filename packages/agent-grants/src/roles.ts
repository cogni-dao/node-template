// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/roles`
 * Purpose: Principal lookup, the ask (an agent requests a scope for itself), the admin's yes, no and take-back on node rows, and the owner's
 *   yes, no and take-back on personal rows (`grantPersonal`, `revokePersonal`).
 *   The caller already passed the node admin gate for every admin function, and the person session guard for every owner function.
 * Scope: Pure over the store. A node row never grants account data; a personal row is read through `authorizeAccount`.
 * Invariants:
 *   - NODE_DECLARED_SCOPES: an undeclared scope is rejected before any write, on the ask and on the grant.
 *   - REQUEST_IS_AN_OFF_ROW: an ask is a row with no approver. It opens no lock until an admin approves it.
 *   - NO_SELF_APPROVAL: `requestAccess` can only write a pending row for the caller; only `approveRequest` sets an approver,
 *     and it refuses an approver who is the asking principal.
 *   - Revoke is soft: the row stays, `revoked_at` is set. A deny is the same soft write on a row that was never approved.
 *   - PERSONAL_NEEDS_AN_OWNER: the kind of a row comes from the scope's declaration, never from the request. An ask for a personal scope needs an
 *     agent that has an owner (`needs_owner` otherwise); the row stores that owner. The agent cannot name one.
 *   - APPROVER_FOLLOWS_RESOURCE: a personal row is turned On and Off only by its owner, through `grantPersonal` and `revokePersonal`. An agent that is not the
 *     owner's is "principal_not_found" (the route says 404). The admin path never grants a personal scope (`personal_scope`), not even to this node's own AI.
 *   - PERSONAL_GRANT_ENDS: an approved personal row lasts `PERSONAL_GRANT_TTL_DAYS` (30) on the database clock. There is no picker in v0.
 * Side-effects: IO (store writes)
 * @public
 */

import type { AgentGrantsStore, GrantResource, OwnRoleRow, PersonalScopeKind, ScopeKind } from "./types";

/** An owner's grant lasts this many days. Friction, when needed, is a shorter number. */
export const PERSONAL_GRANT_TTL_DAYS = 30;

export type RolesErrorCode =
  | "principal_not_found"
  | "invalid_scope"
  | "not_pending"
  | "self_approval"
  | "too_many_requests"
  | "no_external_door"
  | "needs_owner"
  | "personal_scope";

export class AgentRolesError extends Error {
  readonly code: RolesErrorCode;
  constructor(code: RolesErrorCode, message: string) {
    super(message);
    this.name = "AgentRolesError";
    this.code = code;
  }
}

/**
 * Open asks one agent may hold at once. An agent can ask for at most one row per askable scope, so this must stay below the number
 * of askable scopes or it can never fire.
 */
export const MAX_PENDING_PER_AGENT = 3;

/**
 * Open asks across ALL agents. Registration is anonymous (bug.0297), so identities are cheap; this bounds what a flood of
 * throwaway agents can put in front of the admin. Past it, a new ask is refused until an admin clears some.
 */
export const MAX_PENDING_TOTAL = 50;

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
  input: {
    principalUserId: string;
    scope: string;
    declaredScopes: readonly string[];
    /** Scopes an outside agent can actually use: a route twin it can call. Any other ask is refused (`no_external_door`). */
    askableScopes: readonly string[];
    /** scope -> its declared kind. A scope not listed is a node scope. A personal kind (`account` today) needs an owned agent. */
    scopeKinds?: Readonly<Record<string, ScopeKind>>;
  }
): Promise<{ state: "pending" | "granted"; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  // An ask the admin could approve but that opens nothing is misleading consent: refuse it.
  if (!input.askableScopes.includes(input.scope))
    throw new AgentRolesError("no_external_door", "no route an outside agent can call uses this scope");
  const kind = input.scopeKinds?.[input.scope] ?? "node";
  let resource: GrantResource = { kind: "node" };
  // Only `account` is personal in this release. `own` (for example schedule:manage) stays an admin's node row until the S2b step moves it.
  if (kind === "account") {
    // The row's kind is the declaration's. An unowned agent (anonymous registration, or one that predates ownership) has no one to ask.
    const ownerUserId = await store.agentOwner(input.principalUserId);
    if (!ownerUserId) throw new AgentRolesError("needs_owner", "an agent with no owner cannot ask for a personal permission");
    resource = { kind, ownerUserId };
  }
  const result = await store.requestRole({
    principalUserId: input.principalUserId,
    scope: input.scope,
    maxPending: MAX_PENDING_PER_AGENT,
    maxPendingTotal: MAX_PENDING_TOTAL,
    resource,
  });
  if (result === "too_many" || result === "node_full")
    throw new AgentRolesError("too_many_requests", result === "node_full" ? "node has too many open requests" : "too many open requests");
  return { state: result === "granted" ? "granted" : "pending", created: result === "created" };
}

/** The agent's own rows, by state. */
export async function listOwnAccess(
  store: AgentGrantsStore,
  principalUserId: string
): Promise<OwnRoleRow[]> {
  return store.listOwnRoles(principalUserId);
}

/**
 * The admin turns a row ON. A pending ask is approved; an internal AI with no row gets a live row. An outside agent with no
 * ask cannot be granted: it has to ask first.
 */
export async function grantRole(
  store: AgentGrantsStore,
  input: PrincipalRef & {
    scope: string;
    approvedBy: string;
    declaredScopes: readonly string[];
    /** Scopes a person decides for their own agent. An admin never grants one: not to an outside agent, not to this node's own AI. */
    personalScopes?: readonly string[];
  }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  if (input.personalScopes?.includes(input.scope))
    throw new AgentRolesError("personal_scope", "a personal permission is turned on by the person who owns the agent");
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

/** The scope's personal kind, or an error: an undeclared scope, or a node scope (an admin's, not the owner's). */
function personalKind(
  input: { scope: string; scopeKinds: Readonly<Record<string, ScopeKind>> }
): PersonalScopeKind {
  const kind = input.scopeKinds[input.scope];
  if (kind === "account") return kind;
  throw new AgentRolesError("invalid_scope", "scope is not a personal permission");
}

/** The agent must be this person's. Another person's agent, an ownerless agent and an unknown id look the same. */
async function ownedBy(store: AgentGrantsStore, ownerUserId: string, principalUserId: string): Promise<void> {
  if ((await store.agentOwner(principalUserId)) !== ownerUserId)
    throw new AgentRolesError("principal_not_found", "no such agent");
}

/**
 * The owner turns a personal row ON: approves their own agent's pending ask. The owner is the approver (consent, never self-approval), and the row ends
 * after `PERSONAL_GRANT_TTL_DAYS`. A scope the agent never asked for cannot be turned On: it has to ask first.
 */
export async function grantPersonal(
  store: AgentGrantsStore,
  input: { ownerUserId: string; principalUserId: string; scope: string; scopeKinds: Readonly<Record<string, ScopeKind>> }
): Promise<{ principalUserId: string; created: boolean }> {
  const kind = personalKind(input);
  if (input.principalUserId === input.ownerUserId)
    throw new AgentRolesError("self_approval", "an approver cannot approve its own row");
  await ownedBy(store, input.ownerUserId, input.principalUserId);
  const resource: GrantResource = { kind, ownerUserId: input.ownerUserId };
  if (
    await store.approvePending({
      principalUserId: input.principalUserId,
      scope: input.scope,
      approvedBy: input.ownerUserId,
      resource,
      ttlDays: PERSONAL_GRANT_TTL_DAYS,
    })
  )
    return { principalUserId: input.principalUserId, created: true };
  if (await store.hasLiveRole(input.principalUserId, input.scope, resource))
    return { principalUserId: input.principalUserId, created: false };
  throw new AgentRolesError("not_pending", "no pending ask for this agent and scope");
}

/** The owner turns a personal row OFF (revoke a live row) or dismisses an ask (`deny`). Both are soft. */
export async function revokePersonal(
  store: AgentGrantsStore,
  input: {
    ownerUserId: string;
    principalUserId: string;
    scope: string;
    scopeKinds: Readonly<Record<string, ScopeKind>>;
    deny?: boolean;
  }
): Promise<{ principalUserId: string; changed: boolean }> {
  const kind = personalKind(input);
  await ownedBy(store, input.ownerUserId, input.principalUserId);
  const target = {
    principalUserId: input.principalUserId,
    scope: input.scope,
    resource: { kind, ownerUserId: input.ownerUserId } satisfies GrantResource,
  };
  const changed = input.deny ? await store.denyPending(target) : await store.revokeRole(target);
  return { principalUserId: input.principalUserId, changed };
}
