// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/roles`
 * Purpose: Principal lookup, the ask (an agent requests a scope for itself), the admin's yes, no and take-back on node rows, and the owner's
 *   yes, no and take-back on personal rows (`grantPersonal`, `revokePersonal`).
 *   The caller already passed the node admin gate for every admin function, and the person session guard for every owner function.
 * Scope: Pure over the store. A node row never grants account data.
 * Invariants:
 *   - NODE_DECLARED_SCOPES: an undeclared scope is rejected before any write, on the ask and on the grant.
 *   - REQUEST_IS_AN_OFF_ROW: an ask is a row with no approver. It opens no lock until an admin approves it.
 *   - NO_SELF_APPROVAL: `requestAccess` can only write a pending row for the caller; only `approveRequest` sets an approver,
 *     and it refuses an approver who is the asking principal.
 *   - Revoke is soft: the row stays, `revoked_at` is set. A deny is the same soft write on a row that was never approved.
 *   - PERSONAL_IS_THE_OWNERS: the row's plane comes from the scope's declaration, the delegable list and the agent's owner, never from the request. A scope on the
 *     delegable list (`DELEGABLE_SCOPES`, subject `member`) is `delegated`: an OWNED agent's ask is a personal row owned by its owner; an ownerless agent's ask, and an ask
 *     for any other scope, is a node row an admin decides. The row stores the owner; the agent cannot name one.
 *   - APPROVER_FOLLOWS_RESOURCE: a personal row is turned On and Off only by its owner (`grantPersonal`, `revokePersonal`, `decideAsOwner`). An agent that is not the
 *     owner's is "principal_not_found" (the route says 404). A scope not on the delegable list is refused (`invalid_scope`) on every personal path. The admin path never grants
 *     a delegable scope to an agent that has an owner, but may revoke any live row (the kill switch).
 *   - ASK_RETURNS_ITS_OWN_URL: every ask answers with the deep link of that ask (`approvalPath`): into the owner's profile for a personal row, into the Admin AI-access page otherwise.
 *   - PERSONAL_GRANT_ENDS: an approved personal row lasts `PERSONAL_GRANT_TTL_DAYS` (30) on the database clock. There is no picker in v0.
 * Side-effects: IO (store writes)
 * @public
 */

import { approvalPath } from "./approval";
import type {
  AgentGrantsStore,
  GrantResource,
  OwnRoleRow,
  PersonalScopeKind,
  RequestRecord,
  ScopeKind,
  SubjectRequirement,
} from "./types";

/** An owner's grant lasts this many days. Friction, when needed, is a shorter number. */
export const PERSONAL_GRANT_TTL_DAYS = 30;

/** What a scope's declaration says about who decides it. */
export interface ScopeDeclaration {
  readonly kind: ScopeKind;
  readonly subject: SubjectRequirement;
}

/**
 * The scopes an owner may delegate to an agent they own. Everything else stays an admin's decision. Add a scope here only when any signed-in member may already
 * do it (subject `member`) and acting under the owner's delegation cannot touch anyone else's data. Widen one by one.
 */
export const DELEGABLE_SCOPES: readonly string[] = ["knowledge:read", "knowledge:contribute"];

/** Open personal asks one owner's agents may hold in all. */
export const MAX_PENDING_PER_OWNER = 5;

/**
 * The personal kind of a scope, or null when only an admin may decide it. A personal row exists only for a scope on the delegable list whose DECLARED subject is
 * `member` and whose kind is a node scope. The declaration is the declared one: a bearer's admin-subject downgrade at the route door never makes a scope personal.
 */
export function personalKindFor(scope: string, declaration: ScopeDeclaration | undefined): PersonalScopeKind | null {
  if (!declaration || declaration.subject !== "member" || declaration.kind !== "node") return null;
  return DELEGABLE_SCOPES.includes(scope) ? "delegated" : null;
}

export type RolesErrorCode =
  | "principal_not_found"
  | "invalid_scope"
  | "not_pending"
  | "self_approval"
  | "too_many_requests"
  | "no_external_door"
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
    /** scope -> its declaration. A scope not listed is a node scope an admin decides. */
    scopes?: Readonly<Record<string, ScopeDeclaration>>;
  }
): Promise<{ state: "pending" | "granted"; created: boolean; approvalPath: string | null }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  // An ask the admin could approve but that opens nothing is misleading consent: refuse it.
  if (!input.askableScopes.includes(input.scope))
    throw new AgentRolesError("no_external_door", "no route an outside agent can call uses this scope");
  const personal = personalKindFor(input.scope, input.scopes?.[input.scope]);
  let resource: GrantResource = { kind: "node" };
  if (personal) {
    // A delegable scope asked by an OWNED agent is its owner's to decide. An ownerless agent has no one else to ask: an admin decides, as before.
    const ownerUserId = await store.agentOwner(input.principalUserId);
    if (ownerUserId) resource = { kind: personal, ownerUserId };
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
  const open = await store.openRequest(input.principalUserId, input.scope);
  return {
    state: result === "granted" ? "granted" : "pending",
    created: result === "created",
    approvalPath: open ? approvalPath(open.id, open.resourceKind === "node" ? "node" : "personal") : null,
  };
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
    /** scope -> its declaration. Lets the admin path refuse what the owner decides. */
    scopes?: Readonly<Record<string, ScopeDeclaration>>;
  }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const { userId, internal } = await resolveRef(store, input);
  // APPROVER_FOLLOWS_RESOURCE: an admin never decides what is the owner's. A delegable scope is the owner's to delegate when the agent has one. This node's own AI and
  // an ownerless agent have no owner, so an admin decides their scopes.
  if (personalKindFor(input.scope, input.scopes?.[input.scope]) && !internal && (await store.agentOwner(userId)) !== null)
    throw new AgentRolesError("personal_scope", "this permission is turned on by the person who owns the agent");
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
  let revoked = await store.revokeRole({ principalUserId: userId, scope: input.scope });
  if (!revoked) {
    // The kill switch: an admin may end an owner's delegation too. Revoke only; the admin never approves one.
    const owner = await store.agentOwner(userId);
    if (owner) revoked = await store.revokeRole({ principalUserId: userId, scope: input.scope, resource: { kind: "delegated", ownerUserId: owner } });
  }
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

/** The scope's personal kind, or an error: an undeclared scope, or one not on the delegable list. */
function personalKind(input: { scope: string; scopes: Readonly<Record<string, ScopeDeclaration>> }): PersonalScopeKind {
  const kind = personalKindFor(input.scope, input.scopes[input.scope]);
  if (kind) return kind;
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
  input: { ownerUserId: string; principalUserId: string; scope: string; scopes: Readonly<Record<string, ScopeDeclaration>> }
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
    scopes: Readonly<Record<string, ScopeDeclaration>>;
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

/**
 * The owner decides ONE ask on its own page: Approve or Deny, by the request id. One atomic UPDATE in the store (id AND pending AND this owner AND delegable AND the agent still theirs).
 * Not found, someone else's and a node row are the same `principal_not_found` (404); a request already decided is `not_pending`; a scope off the delegable list is `invalid_scope`.
 */
export async function decideAsOwner(
  store: AgentGrantsStore,
  input: { ownerUserId: string; requestId: string; decision: "approve" | "deny" }
): Promise<{ principalUserId: string; scope: string; changed: boolean }> {
  const record = await store.getRequest(input.requestId);
  if (!record || record.resourceKind === "node" || record.ownerUserId !== input.ownerUserId)
    throw new AgentRolesError("principal_not_found", "no such request");
  if (!DELEGABLE_SCOPES.includes(record.scope)) throw new AgentRolesError("invalid_scope", "scope is not a personal permission");
  if (record.principalUserId === input.ownerUserId) throw new AgentRolesError("self_approval", "an approver cannot approve its own row");
  const changed = await store.decideRequest({
    requestId: input.requestId,
    deciderUserId: input.ownerUserId,
    decision: input.decision,
    ttlDays: PERSONAL_GRANT_TTL_DAYS,
  });
  if (!changed && record.state !== "pending") throw new AgentRolesError("not_pending", "this request was already decided");
  return { principalUserId: record.principalUserId, scope: record.scope, changed };
}
