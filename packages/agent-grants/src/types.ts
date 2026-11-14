// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/types`
 * Purpose: Boundary types for runtime agent tool authority.
 * Scope: Types only. No private `@cogni/*` import, no app ExecutionScope, no ai-core import.
 * Invariants: identities cross the boundary as plain strings (`users.id`, `billing_accounts.id`).
 * Side-effects: none
 * @public
 */

/**
 * Where a tool's authority lives. `own` data also needs a subject. `account` data belongs to one account: the principal needs a live
 * account row naming that account (`authorizeAccount()`), and a tool that declares it is checked against the run's account.
 * `authorize()` denies an `account` tool when no account is given.
 */
export type ScopeKind = "node" | "own" | "account";

/** `member` = any caller with a user id; `admin` = a DAO admin (bound admin wallet; agents have none). */
export type SubjectRequirement = "member" | "admin";

/** What a non-read_only tool contract declares (`contract.requires`). */
export interface ToolRequires {
  readonly scope: string;
  readonly kind: ScopeKind;
  readonly subject: SubjectRequirement;
  /** Plain-language short name of the permission (from the declaration). */
  readonly label?: string;
  /** One plain line saying what the permission lets an AI do (from the declaration). */
  readonly description?: string;
}

/** The node's own admin authority, as seen by the guard. */
export type AdminDecision = "allow" | "denied" | "unavailable";
export type AdminCheck = (subjectUserId: string) => Promise<AdminDecision>;

/**
 * Structural run identity: the acting principal, the subject (the authenticated caller; absent for ownerless runs) and the account
 * the run acts on (the person who owns the schedule or chat; absent when the run has none). The account is authority input for
 * account-kind tools only (R13): such a tool opens only when the principal holds a live row for exactly this account.
 */
export interface RunIdentity {
  readonly principalId?: string | undefined;
  readonly subjectUserId?: string | undefined;
  readonly accountId?: string | undefined;
}

/** What a grant row covers: the whole node, or one account. */
export type GrantResource = "node" | "account";

export type DenialCode = "policy_denied" | "authz_unavailable";

export type AuthzDecision =
  | { readonly decision: "allow"; readonly basis: string }
  | {
      readonly decision: "deny";
      readonly code: DenialCode;
      readonly reason: string;
    };

/**
 * The state of one grant row, from the asking agent's side. `expired` is a state, never a write (R14): an approved account row whose
 * `expires_at` passed before it was revoked.
 */
export type RoleState = "pending" | "granted" | "denied" | "revoked" | "expired";

/** What `authorizeAccount()` found: the account's owner, an agent holding a live delegated row, or nothing (a non-disclosing 404). */
export type AccountAccess = "owner" | "delegated" | null;

/** One pending or live grant row, with who it is for. For the admin table. */
export interface RoleRow {
  readonly principalUserId: string;
  /** The catalog slug for an internal AI, else null. */
  readonly slug: string | null;
  readonly internal: boolean;
  /** The slug for an internal AI (the slug IS its name), else the outside agent's registered name. */
  readonly name: string | null;
  /** A plain note that the agent is tied to something outside, such as "GitHub linked". Null when nothing is known. */
  readonly hint: string | null;
  readonly scope: string;
  readonly state: "pending" | "granted";
  readonly at: string;
  /** The grant row's id. The table sends it back to revoke an account row (R4). */
  readonly rowId: string;
  /** What the row covers. The admin table lists node rows only; the profile lists account rows only. */
  readonly resource: GrantResource;
  /** The account an approved account row covers; null on a node row and on a pending account row. */
  readonly accountId: string | null;
  /** When an approved account row ends (ISO); null on a node row. */
  readonly expiresAt: string | null;
}

/** One pending ask found by its one-time link token, for the page that highlights it. */
export interface PendingAskView {
  readonly principalUserId: string;
  readonly slug: string | null;
  readonly internal: boolean;
  readonly name: string | null;
  readonly hint: string | null;
  readonly scope: string;
  readonly resource: GrantResource;
  readonly at: string;
}

/** The one-time approval link written with an ask: sha256 of the token and when it ends. The token itself is never given to the store. */
export interface AskLink {
  readonly hash: string;
  readonly expiresAt: Date;
}

/** What an ask did. `created` and `pending` leave a pending row with `link` set (a re-ask rotates it); `granted` leaves nothing to approve. */
export type AskResult = "created" | "pending" | "granted" | "too_many" | "node_full";

/**
 * Persistence port. The Postgres adapter is the only implementation a node needs.
 * LIVE_NEEDS_APPROVAL: every read that opens a lock (`hasLiveRole`, `liveScopes`, `hasLiveAccountGrant`) counts only rows with an approver
 * and no revoke; an account row also needs a future `expires_at`. A pending row (an ask) never opens a lock.
 * RESOURCE_SPLIT (R1): every node-plane method acts on `resource = 'node'` rows only; every account method on `resource = 'account'` rows only.
 */
export interface AgentGrantsStore {
  /** A live (approved, unrevoked) node role row for this principal user id and scope. Never cached. */
  hasLiveRole(principalId: string, scope: string): Promise<boolean>;
  /** The subset of `scopes` this principal holds a live NODE role for, in ONE read. Never cached. Account rows never count. */
  liveScopes(principalId: string, scopes: readonly string[]): Promise<string[]>;
  /** A live account row for exactly this principal, scope and account: approved, unrevoked, `expires_at` in the future. Never cached. */
  hasLiveAccountGrant(principalId: string, scope: string, accountId: string): Promise<boolean>;
  /** The subset of `scopes` this principal holds a live row for on exactly this account, in ONE read. Never cached. */
  liveAccountScopes(principalId: string, scopes: readonly string[], accountId: string): Promise<string[]>;
  /** True when `userId` owns the billing account `accountId`. */
  ownsAccount(userId: string, accountId: string): Promise<boolean>;
  /** The billing account this user owns, or null when none exists yet. */
  accountOf(userId: string): Promise<string | null>;
  /** The seeded user id of an internal principal slug, else null. */
  findInternalPrincipal(slug: string): Promise<{ userId: string } | null>;
  /** Every internal principal (user id and slug). The slug is its name. */
  listInternalPrincipals(): Promise<Array<{ userId: string; slug: string }>>;
  /** Every live node role row with its principal's slug. Never cached. */
  listLiveRoles(): Promise<Array<{ principalSlug: string; scope: string }>>;
  /**
   * Every pending and live NODE row for the admin table. Never cached. Rows of this node's own AI are always all returned (few);
   * rows of outside agents are bounded by `limit` (pending first). `more` counts the outside rows not returned.
   */
  listRoleRows(limit: number): Promise<{ rows: RoleRow[]; more: number }>;
  /**
   * The live account rows on the one account `accountId` (its owner's view), newest first, bounded. Internal AI and outside agents
   * alike. An ended row (revoked or past `expires_at`) is not listed.
   */
  listAccountRoleRows(accountId: string, limit: number): Promise<RoleRow[]>;
  /**
   * The caller's own rows, newest state per (scope, account) (bounded). `expired` is derived (R14): an approved row whose `expires_at`
   * is not after the moment it was revoked or now.
   */
  listOwnRoles(
    principalUserId: string
  ): Promise<Array<{ scope: string; state: RoleState; at: string; accountId: string | null }>>;
  /**
   * An agent asks for a scope for itself: inserts a pending row (`approved_by` null, `requested_by` = the agent) of the given resource,
   * with a one-time link. An ask on an existing pending row rotates the link (a new hash, the old token stops working). A row that is
   * live, or live and expired, is closed first (R14: an expired live row is revoked at `now()` so the old index frees).
   * `granted` means a live row exists (nothing is written). `too_many` caps this agent's open asks; `node_full` caps open asks across
   * all agents (a flood from throwaway identities).
   */
  requestRole(input: {
    principalUserId: string;
    scope: string;
    resource: GrantResource;
    link: AskLink;
    maxPending: number;
    maxPendingTotal: number;
  }): Promise<AskResult>;
  /** Approves the pending NODE row: sets the approver and `granted_at`, and consumes its link. False when no pending node row exists. */
  approvePending(input: { principalUserId: string; scope: string; approvedBy: string }): Promise<boolean>;
  /** Denies the pending NODE row (soft: `revoked_at` set, never approved). False when no pending node row exists. */
  denyPending(input: { principalUserId: string; scope: string }): Promise<boolean>;
  /** Inserts a live NODE role row an admin writes directly (approved at once); false when a live or pending row exists. */
  insertRole(input: {
    principalUserId: string;
    scope: string;
    approvedBy: string;
  }): Promise<boolean>;
  /** Revokes the live (approved) NODE role row; false when none exists. A pending row is not touched. */
  revokeRole(input: { principalUserId: string; scope: string }): Promise<boolean>;
  /** Looks up a pending ask by the sha256 of its link token and the page's resource. Used, expired, wrong-kind and unknown tokens are all null. */
  findPendingByLink(input: { linkHash: string; resource: GrantResource }): Promise<PendingAskView | null>;
  /**
   * The account owner's yes on a pending ACCOUNT row found by its link token: in one UPDATE the row takes the approver, `granted_at`,
   * the account the approver owns, `expires_at = now() + days`, and its link is consumed. Refuses (false) a token that is used, expired or
   * of the wrong resource, an approver who owns no account, and an approver who is the asking principal.
   */
  approveAccountByLink(input: { linkHash: string; approvedBy: string; days: number }): Promise<boolean>;
  /** The owner's no on a pending ACCOUNT row found by its link token (the row's account is not set yet). */
  denyAccountByLink(input: { linkHash: string; deniedBy: string }): Promise<boolean>;
  /**
   * Direct On for this node's own AI on one account (no ask): inserts a live account row for an INTERNAL principal on the approver's
   * own account. False when a live or pending row already exists for this principal and scope, or the approver owns no account.
   */
  insertAccountRole(input: {
    principalUserId: string;
    scope: string;
    approvedBy: string;
    days: number;
  }): Promise<boolean>;
  /** Revokes a live ACCOUNT row by id, only where its account is owned by `ownerUserId`. False otherwise (a foreign row is invisible). */
  revokeAccountRole(input: { rowId: string; ownerUserId: string }): Promise<boolean>;
}

/** Hands the guard a store bound to one transaction or connection. */
export type WithStore = <T>(fn: (store: AgentGrantsStore) => Promise<T>) => Promise<T>;

/** One authorization decision, for the node's logger. Holds no tokens. */
export interface AuthzEvent {
  readonly principal: string | null;
  readonly subject: string | null;
  readonly payer: string | null;
  readonly tool: string;
  readonly decision: "allow" | "deny";
  readonly code: string;
  readonly reason: string;
  readonly runId: string | null;
  /** The route id when the decision came from a route (SAME_DOOR), else absent. */
  readonly route?: string | null;
  /** The account the decision was about (a run's account, or the account in an account route), else absent. An id, never data. */
  readonly account?: string | null;
}

/** Which block of the one admin table a row belongs to. */
export type AccessSection = "pending" | "node" | "outside";

/**
 * One row of the admin table = one grant row: who, what they can do, until when, on or off.
 * Name and description come from the declaration (`requires`), the who from `agent_principals` or the user's name.
 */
export interface NodeAiPermissionView {
  readonly section: AccessSection;
  /** Opaque to the human; the table sends it back unchanged when the admin clicks. */
  readonly principalUserId: string;
  /** The agent's identifier: the slug for this node's AI, the registered name for an outside agent. Never a vanity label. */
  readonly who: string;
  /** True for an agent that is not one of this node's own AI. */
  readonly outside: boolean;
  /** A plain note such as "GitHub linked", or null. */
  readonly hint: string | null;
  /** Opaque to the human; the table sends it back unchanged when the admin clicks. */
  readonly scope: string;
  /** The permission's short plain name. */
  readonly label: string;
  /** One plain line on what the permission lets the agent do. */
  readonly description: string;
  /** On = a live grant. Off = none yet (a pending ask, or an AI with no grant). */
  readonly on: boolean;
  /** When the grant ends (ISO), or null for no end. A node grant has no end in v0; an account grant always ends. */
  readonly until: string | null;
  /** What the row covers: the admin table shows node rows only, the profile table account rows only. */
  readonly resource: GrantResource;
  /** The grant row's id when one exists (needed to revoke an account row), else null (an AI with no row yet). */
  readonly rowId: string | null;
  /**
   * An ask found by its link token and not yet decided. The caller must send the token back to decide it, because an account ask
   * has no account until its owner decides.
   */
  readonly viaLink?: boolean | undefined;
}

/** The `GET /api/v1/agent-access/roles` body. A non-admin gets `canManage: false` and no rows. */
export interface NodeAiAccessView {
  readonly canManage: boolean;
  readonly permissions: readonly NodeAiPermissionView[];
  /** Outside rows left out of `permissions` because the list is bounded. 0 when nothing is cut. */
  readonly more: number;
}
