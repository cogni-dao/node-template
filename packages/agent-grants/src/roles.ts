// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/roles`
 * Purpose: Principal lookup, the ask (an agent requests a scope for itself and gets one link), and the approver's yes, no and take-back on grant rows:
 *   an admin for a node row, the account owner for an account row. Every decision passes `canApprove` (ONE_GATE).
 * Scope: Pure over the store. A node row never grants account data; an account row never grants node data (RESOURCE_SPLIT).
 * Invariants:
 *   - NODE_DECLARED_SCOPES: an undeclared scope is rejected before any write, on the ask and on the grant.
 *   - REQUEST_IS_AN_OFF_ROW: an ask is a row with no approver. It opens no lock until an admin approves it.
 *   - NO_SELF_APPROVAL: `requestAccess` can only write a pending row for the caller; only a decision sets an approver,
 *     and `canApprove` refuses an approver who is the asking principal.
 *   - ONE_GATE: node rows are decided with an admin session, account rows by the owner of the account; both through `canApprove`.
 *   - TWO_STARTS: an outside AI asks and gets one link (its token is shown once, rotated by a re-ask); this node's AI never asks, its approver
 *     turns it On directly (`grantInternalOnAccount`, and `grantRole` for a node scope). An outside principal with no pending row is refused.
 *   - Revoke is soft: the row stays, `revoked_at` is set. A deny is the same soft write on a row that was never approved.
 * Side-effects: IO (store writes)
 * @public
 */

import {
  ACCOUNT_GRANT_DAYS,
  type ApprovalCaller,
  approvalPath,
  canApprove,
  DEFAULT_ACCOUNT_GRANT_DAYS,
  hashLinkToken,
  isAccountGrantDays,
  isLinkTokenShape,
  LINK_TTL_MS,
  newLinkToken,
  resourceOfKind,
} from "./approval";
import type { AgentGrantsStore, GrantResource, PendingAskView, RoleState, ScopeKind } from "./types";

export type RolesErrorCode =
  | "principal_not_found"
  | "invalid_scope"
  | "not_pending"
  | "self_approval"
  | "too_many_requests"
  | "no_external_door"
  | "not_allowed"
  | "invalid_days";

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

/** What an ask returns. `approvalPath` is present while the row waits (a new token on every ask); the node adds its public origin. */
export interface AskOutcome {
  readonly state: "pending" | "granted";
  readonly created: boolean;
  /** Path and fragment of the one-time link, by the scope's declared kind. Absent when the grant is already live. */
  readonly approvalPath?: string;
}

/**
 * An agent asks for a scope for itself. Idempotent: a pending row is reported and its link rotated (a link is always returned), a live row is
 * reported as granted. The declared kind picks the resource and so the page and the approver.
 */
export async function requestAccess(
  store: AgentGrantsStore,
  input: {
    principalUserId: string;
    scope: string;
    declaredScopes: readonly string[];
    /** Scopes an outside agent can actually use: a route twin it can call. Any other ask is refused (`no_external_door`). */
    askableScopes: readonly string[];
    /** The declared kind of every scope. A scope missing here is `node`. */
    scopeKinds?: Readonly<Record<string, ScopeKind>>;
  }
): Promise<AskOutcome> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  // An ask the approver could say yes to but that opens nothing is misleading consent: refuse it.
  if (!input.askableScopes.includes(input.scope))
    throw new AgentRolesError("no_external_door", "no route an outside agent can call uses this scope");
  const kind = input.scopeKinds?.[input.scope] ?? "node";
  const token = newLinkToken();
  const result = await store.requestRole({
    principalUserId: input.principalUserId,
    scope: input.scope,
    resource: resourceOfKind(kind),
    link: { hash: await hashLinkToken(token), expiresAt: new Date(Date.now() + LINK_TTL_MS) },
    maxPending: MAX_PENDING_PER_AGENT,
    maxPendingTotal: MAX_PENDING_TOTAL,
  });
  if (result === "too_many" || result === "node_full")
    throw new AgentRolesError("too_many_requests", result === "node_full" ? "node has too many open requests" : "too many open requests");
  if (result === "granted") return { state: "granted", created: false };
  return { state: "pending", created: result === "created", approvalPath: approvalPath(kind, token) };
}

/** The agent's own rows, by state, per account. */
export async function listOwnAccess(
  store: AgentGrantsStore,
  principalUserId: string
): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>> {
  return store.listOwnRoles(principalUserId);
}

/**
 * The admin turns a NODE row ON. A pending ask is approved; an internal AI with no row gets a live row. An outside agent with no
 * ask cannot be granted: it has to ask first. `me.admin` is the admin session (ONE_GATE).
 */
export async function grantRole(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string; me: ApprovalCaller; declaredScopes: readonly string[] }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const { userId, internal } = await resolveRef(store, input);
  if (userId === input.me.userId)
    throw new AgentRolesError("self_approval", "an approver cannot approve its own row");
  if (!(await canApprove(store, input.me, { resource: "node", principalUserId: userId })))
    throw new AgentRolesError("not_allowed", "only a node admin decides a node permission");
  if (await store.approvePending({ principalUserId: userId, scope: input.scope, approvedBy: input.me.userId }))
    return { principalUserId: userId, created: true };
  if (!internal) {
    // No pending ask: if it is already live this is a no-op, else the agent must ask first.
    if (await store.hasLiveRole(userId, input.scope)) return { principalUserId: userId, created: false };
    throw new AgentRolesError("not_pending", "no pending ask for this agent and scope");
  }
  const created = await store.insertRole({
    principalUserId: userId,
    scope: input.scope,
    approvedBy: input.me.userId,
  });
  return { principalUserId: userId, created };
}

/** The admin turns a live NODE row OFF. */
export async function revokeRole(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string; me: ApprovalCaller }
): Promise<{ principalUserId: string; revoked: boolean }> {
  const { userId } = await resolveRef(store, input);
  if (!(await canApprove(store, input.me, { resource: "node", principalUserId: userId })))
    throw new AgentRolesError("not_allowed", "only a node admin decides a node permission");
  const revoked = await store.revokeRole({ principalUserId: userId, scope: input.scope });
  return { principalUserId: userId, revoked };
}

/** The admin dismisses a pending NODE ask (the x). The agent sees `denied`. */
export async function denyRequest(
  store: AgentGrantsStore,
  input: PrincipalRef & { scope: string; me: ApprovalCaller }
): Promise<{ principalUserId: string; denied: boolean }> {
  const { userId } = await resolveRef(store, input);
  if (!(await canApprove(store, input.me, { resource: "node", principalUserId: userId })))
    throw new AgentRolesError("not_allowed", "only a node admin decides a node permission");
  const denied = await store.denyPending({ principalUserId: userId, scope: input.scope });
  return { principalUserId: userId, denied };
}

const daysOrDefault = (days: number | undefined): number => {
  const d = days ?? DEFAULT_ACCOUNT_GRANT_DAYS;
  if (!isAccountGrantDays(d))
    throw new AgentRolesError("invalid_days", `days must be one of ${ACCOUNT_GRANT_DAYS.join(", ")}`);
  return d;
};

/**
 * Looks up a pending ask by its one-time link token for the page that opens it (profile: account asks; admin: node asks). A wrong-kind,
 * used, expired or unknown token is one answer: null (the route says 404 and discloses nothing).
 */
export async function previewAsk(
  store: AgentGrantsStore,
  input: { token: string; resource: GrantResource }
): Promise<PendingAskView | null> {
  if (!isLinkTokenShape(input.token)) return null;
  return store.findPendingByLink({ linkHash: await hashLinkToken(input.token), resource: input.resource });
}

/**
 * The account owner turns a pending ACCOUNT ask On, by its link token. The row takes an account the approver owns, and ends in 1, 7 or 30
 * days (default 7). A node-admin has no say here (R12). Returns false for a token that is not usable.
 */
export async function approveAccountAsk(
  store: AgentGrantsStore,
  input: { me: ApprovalCaller; token: string; days?: number | undefined }
): Promise<{ approved: boolean }> {
  const days = daysOrDefault(input.days);
  const pending = await previewAsk(store, { token: input.token, resource: "account" });
  if (!pending) return { approved: false };
  if (!(await canApprove(store, input.me, { resource: "account", principalUserId: pending.principalUserId })))
    throw new AgentRolesError("not_allowed", "only the owner of an account decides access to it");
  const approved = await store.approveAccountByLink({
    linkHash: await hashLinkToken(input.token),
    approvedBy: input.me.userId,
    days,
  });
  return { approved };
}

/** The account owner dismisses a pending ACCOUNT ask (the x). It needs the token: an undecided ask has no account yet (R15). */
export async function denyAccountAsk(
  store: AgentGrantsStore,
  input: { me: ApprovalCaller; token: string }
): Promise<{ denied: boolean }> {
  const pending = await previewAsk(store, { token: input.token, resource: "account" });
  if (!pending) return { denied: false };
  if (!(await canApprove(store, input.me, { resource: "account", principalUserId: pending.principalUserId })))
    throw new AgentRolesError("not_allowed", "only the owner of an account decides access to it");
  return { denied: await store.denyAccountByLink({ linkHash: await hashLinkToken(input.token), deniedBy: input.me.userId }) };
}

/**
 * The account owner turns this node's own AI On for their own account (no ask). Internal principals only: an outside principal is refused
 * (`not_pending`), because it has to ask and be approved by its link.
 */
export async function grantInternalOnAccount(
  store: AgentGrantsStore,
  input: { me: ApprovalCaller; principalUserId: string; scope: string; declaredScopes: readonly string[]; days?: number | undefined }
): Promise<{ principalUserId: string; created: boolean }> {
  if (!input.declaredScopes.includes(input.scope))
    throw new AgentRolesError("invalid_scope", "scope is not declared");
  const days = daysOrDefault(input.days);
  const { internal } = await resolveRef(store, { principalUserId: input.principalUserId });
  if (!internal) throw new AgentRolesError("not_pending", "an outside agent must ask first");
  if (!(await canApprove(store, input.me, { resource: "account", principalUserId: input.principalUserId })))
    throw new AgentRolesError("not_allowed", "only the owner of an account decides access to it");
  const created = await store.insertAccountRole({
    principalUserId: input.principalUserId,
    scope: input.scope,
    approvedBy: input.me.userId,
    days,
  });
  // `false` with an internal AI means a live or pending row already exists (the v0 limit: one open row per AI and scope).
  return { principalUserId: input.principalUserId, created };
}

/** The account owner turns a live ACCOUNT row Off, by id. A row on someone else's account is invisible: `revoked: false`. */
export async function revokeAccountRow(
  store: AgentGrantsStore,
  input: { me: ApprovalCaller; rowId: string }
): Promise<{ revoked: boolean }> {
  // The statement joins billing_accounts.owner_user_id = me, which is exactly canApprove for an account row with an account.
  return { revoked: await store.revokeAccountRole({ rowId: input.rowId, ownerUserId: input.me.userId }) };
}
