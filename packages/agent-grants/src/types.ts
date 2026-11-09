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
 * Where a tool's authority lives. `own` data also needs a subject. `account` is reserved: account scopes are out of
 * scope for this release, so `authorize()` denies any `account` tool with `policy_denied`.
 */
export type ScopeKind = "node" | "own" | "account";

/** `member` = any caller with a user id; `admin` = a DAO admin (bound admin wallet; agents have none). */
export type SubjectRequirement = "member" | "admin";

/** What a non-read_only tool contract declares (`contract.requires`). */
export interface ToolRequires {
  readonly scope: string;
  readonly kind: ScopeKind;
  readonly subject: SubjectRequirement;
  /** Plain-language permission name for the admin table (from the tool contract). */
  readonly label?: string;
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

/** Persistence port. The Postgres adapter is the only implementation a node needs. */
export interface AgentGrantsStore {
  /** A live (unrevoked) role row for this principal user id and scope. Never cached. */
  hasLiveRole(principalId: string, scope: string): Promise<boolean>;
  /** The seeded user id of an internal principal slug, else null. */
  findInternalPrincipal(slug: string): Promise<{ userId: string } | null>;
  /** Every live role row with its principal's slug, for the admin page. Never cached. */
  listLiveRoles(): Promise<Array<{ principalSlug: string; scope: string }>>;
  /** Inserts a live role row; false when one already exists. */
  insertRole(input: {
    principalUserId: string;
    scope: string;
    approvedBy: string;
  }): Promise<boolean>;
  /** Revokes the live role row; false when none exists. */
  revokeRole(input: { principalUserId: string; scope: string }): Promise<boolean>;
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

/** One row of the admin table: one AI and one permission (a scope) it may have. */
export interface NodeAiPermissionView {
  /** Opaque to the human; the table sends it back unchanged when the admin clicks. */
  readonly principal: string;
  /** The AI's plain name. */
  readonly ai: string;
  /** Opaque to the human; the table sends it back unchanged when the admin clicks. */
  readonly scope: string;
  /** The permission's plain name. */
  readonly permission: string;
  readonly allowed: boolean;
}

/** The `GET /api/v1/agent-access/roles` body. A non-admin gets `canManage: false` and no rows. */
export interface NodeAiAccessView {
  readonly canManage: boolean;
  readonly permissions: readonly NodeAiPermissionView[];
}
