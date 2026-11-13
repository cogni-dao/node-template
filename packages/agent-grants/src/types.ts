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
 * Where a tool's authority lives. `own` data also needs a subject. `account` data is read through `authorizeAccount()`, not
 * `authorize()`: `authorize()` denies any `account` tool with `policy_denied`.
 */
export type ScopeKind = "node" | "own" | "account";

/** A scope kind a person decides for their own agent (not a node scope). */
export type PersonalScopeKind = "own" | "account";

/**
 * The resource a grant row is about. `node` rows are an admin's decision. A personal row names the person who owns the agent and decides it
 * (APPROVER_FOLLOWS_RESOURCE). Absent on a store call means `node`.
 */
export type GrantResource =
  | { readonly kind: "node" }
  | { readonly kind: PersonalScopeKind; readonly ownerUserId: string };

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

/** Structural run identity: the acting principal and the subject (the authenticated caller; absent for ownerless runs). */
export interface RunIdentity {
  readonly principalId?: string | undefined;
  readonly subjectUserId?: string | undefined;
}

export type DenialCode = "policy_denied" | "authz_unavailable";

export type AuthzDecision =
  | { readonly decision: "allow"; readonly basis: string }
  | {
      readonly decision: "deny";
      readonly code: DenialCode;
      readonly reason: string;
    };

/**
 * The state of one grant row, from the asking agent's side. A personal grant past its end reads `revoked` (it ended).
 */
export type RoleState = "pending" | "granted" | "denied" | "revoked";

/** One of the agent's own rows. `accountId` is set only on a live account grant: the account the owner opened to it. */
export interface OwnRoleRow {
  readonly scope: string;
  readonly state: RoleState;
  readonly at: string;
  readonly accountId?: string;
}

/** One personal row for the owner's "Your AIs" block: an ask waiting (`pending`) or a live grant (`granted`). */
export interface PersonalRow {
  readonly principalUserId: string;
  /** The agent's registered name, or null. */
  readonly name: string | null;
  readonly scope: string;
  readonly state: "pending" | "granted";
  /** When a live grant ends (ISO); null on an ask. */
  readonly expiresAt: string | null;
  readonly at: string;
}

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
}

/**
 * Persistence port. The Postgres adapter is the only implementation a node needs.
 * LIVE_NEEDS_APPROVAL: every read that opens a lock (`hasLiveRole`, `liveScopes`) counts only rows with an approver and no revoke.
 * A pending row (an ask) never opens a lock.
 */
export interface AgentGrantsStore {
  /**
   * A live (approved, unrevoked) role row for this principal user id and scope. Never cached. With no `resource` (or `node`) only node
   * rows count: a personal row never opens a node lock. With a personal `resource` only a live personal row counts, and it is live only when
   * its owner approved it, it has not ended, and the agent still belongs to that owner (the same predicate as the SQL function `agent_has_scope`).
   */
  hasLiveRole(principalId: string, scope: string, resource?: GrantResource): Promise<boolean>;
  /** The subset of `scopes` this principal holds a live role for, in ONE read. Never cached. */
  liveScopes(principalId: string, scopes: readonly string[]): Promise<string[]>;
  /** The seeded user id of an internal principal slug, else null. */
  findInternalPrincipal(slug: string): Promise<{ userId: string } | null>;
  /** Every internal principal (user id and slug). The slug is its name. */
  listInternalPrincipals(): Promise<Array<{ userId: string; slug: string }>>;
  /** Every live role row with its principal's slug. Never cached. */
  listLiveRoles(): Promise<Array<{ principalSlug: string; scope: string }>>;
  /**
   * Every pending and live row for the admin table. Never cached. Rows of this node's own AI are always all returned (few);
   * rows of outside agents are bounded by `limit` (pending first). `more` counts the outside rows not returned.
   */
  listRoleRows(limit: number): Promise<{ rows: RoleRow[]; more: number }>;
  /** The caller's own rows (any kind), newest state per scope (bounded). */
  listOwnRoles(principalUserId: string): Promise<OwnRoleRow[]>;
  /**
   * An agent asks for a scope for itself: inserts a pending row (`approved_by` null, `requested_by` = the agent).
   * `pending` and `granted` mean a pending or live row already exists (nothing is written). `too_many` caps this agent's open
   * asks; `node_full` caps open asks across all agents (a flood from throwaway identities).
   */
  requestRole(input: {
    principalUserId: string;
    scope: string;
    maxPending: number;
    maxPendingTotal: number;
    /** Default `node`. A personal ask counts only against `maxPending` (it cannot flood the admin), and first ends a personal grant that has run out. */
    resource?: GrantResource;
  }): Promise<"created" | "pending" | "granted" | "too_many" | "node_full">;
  /**
   * Approves the pending row: sets the approver and `granted_at`. False when no pending row exists. A personal row is approved only by its
   * owner (`approvedBy` must be that owner) and gets `expires_at = now() + ttlDays` on the database clock.
   */
  approvePending(input: {
    principalUserId: string;
    scope: string;
    approvedBy: string;
    resource?: GrantResource;
    ttlDays?: number;
  }): Promise<boolean>;
  /** Denies the pending row (soft: `revoked_at` set, never approved). False when no pending row exists. */
  denyPending(input: { principalUserId: string; scope: string; resource?: GrantResource }): Promise<boolean>;
  /** Inserts a live role row an admin writes directly (approved at once); false when a live or pending row exists. */
  insertRole(input: {
    principalUserId: string;
    scope: string;
    approvedBy: string;
  }): Promise<boolean>;
  /** Revokes the live (approved) role row; false when none exists. A pending row is not touched. */
  revokeRole(input: { principalUserId: string; scope: string; resource?: GrantResource }): Promise<boolean>;
  /** The person who owns this agent (`agent_principals.owner_user_id`), or null for an ownerless or unknown agent. */
  agentOwner(principalUserId: string): Promise<string | null>;
  /** The person who owns this billing account, or null when it does not exist. `accountId` must be a UUID. */
  accountOwner(accountId: string): Promise<string | null>;
  /** The personal rows (asks waiting and live grants) of the agents this person owns. Ended and revoked rows are left out. Never cached. */
  listPersonalRows(ownerUserId: string): Promise<PersonalRow[]>;
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
  /** When the grant ends (ISO), or null for no end. v0 grants have no end. */
  readonly until: string | null;
}

/** The `GET /api/v1/agent-access/roles` body. A non-admin gets `canManage: false` and no rows. */
export interface NodeAiAccessView {
  readonly canManage: boolean;
  readonly permissions: readonly NodeAiPermissionView[];
  /** Outside rows left out of `permissions` because the list is bounded. 0 when nothing is cut. */
  readonly more: number;
}

/**
 * One row of the owner's "Your AIs" block = one personal grant row: which AI, what it asks to do, on or off, until when.
 * `principalUserId` and `scope` are opaque to the human; the block sends them back unchanged when the owner clicks.
 */
export interface YourAiPermissionView {
  readonly principalUserId: string;
  /** The AI's registered name, an identifier and never a vanity label. */
  readonly who: string;
  readonly scope: string;
  /** The permission's short plain name, from the declaration. */
  readonly label: string;
  /** One plain line on what the permission lets the AI do, from the declaration. */
  readonly description: string;
  /** On = a live grant. Off = the AI asked and the owner has not said yes. */
  readonly on: boolean;
  /** When the grant ends (ISO), or null while it is only an ask. */
  readonly until: string | null;
}

/** The `GET /api/v1/agent-access/mine` body. */
export interface YourAiAccessView {
  readonly permissions: readonly YourAiPermissionView[];
}
