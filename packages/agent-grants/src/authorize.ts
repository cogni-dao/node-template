// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/authorize`
 * Purpose: The ONE decision: may this principal, serving this subject, use a tool that requires this scope?
 * Scope: Pure over an injected store and admin check. Salvaged in shape from node-template#204 `authorize()`.
 * Invariants:
 *   - ONE_AUTHORIZE_FN: no other module decides tool authority.
 *   - SCOPED_TOOL_NEEDS_PRINCIPAL: no principal means deny.
 *   - SUBJECT_ONLY_NARROWS: a subject can only remove access, never add it. Every caller has a subject (bearer
 *     agents included). `admin` means a principal the DAO approved (AUTHORITY_IS_NOT_KIND); until the AI-admin item (I2)
 *     ships no AI identity is approved, so an agent fails `admin` checks and passes `member` checks.
 *   - FAIL_CLOSED_ON_UNKNOWN: a `kind` outside node|own|account or a `subject` outside member|admin is `policy_denied`.
 *   - NO_ACCOUNT_SCOPE: `authorize()` never answers for account data; an `account` tool is denied with `policy_denied`.
 *   - PERSONAL_DELEGATION: a bearer passes a scope with a live NODE row (an admin approved) OR, when the scope is on the delegable list and its DECLARED subject is `member`, a live
 *     personal `delegated` row its OWNER approved (the agent is owned by that owner, the row is not revoked and has not ended). The agent stays the principal; the allow names the owner.
 *     A scope that needs a node-admin (subject `admin`) opens only on a node row, and a personal row never satisfies `adminCheck`.
 *   - FAIL_CLOSED_NON_DISCLOSING: a store or admin outage is `authz_unavailable`, never an allow.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads)
 * @public
 */

import { DELEGABLE_SCOPES } from "./roles";
import type {
  AdminCheck,
  AgentGrantsStore,
  AuthzDecision,
  ToolRequires,
} from "./types";

export interface AuthorizeInput {
  readonly principalId?: string | undefined;
  readonly subjectUserId?: string | undefined;
  readonly requires: ToolRequires;
  /**
   * The route door for a bearer: an `admin`-subject scope passes on its node row alone (the DAO admin who wrote it was the check; an agent has no admin
   * wallet). Skips the subject admin check; it does NOT let a personal row open an `admin`-subject scope.
   */
  readonly adminSubjectWaived?: boolean | undefined;
}

const KINDS: ReadonlySet<string> = new Set(["node", "own", "account"]);
const SUBJECTS: ReadonlySet<string> = new Set(["member", "admin"]);

const deny = (reason: string): AuthzDecision => ({
  decision: "deny",
  code: "policy_denied",
  reason,
});
const unavailable = (reason: string): AuthzDecision => ({
  decision: "deny",
  code: "authz_unavailable",
  reason,
});

/** The contract-only denials of the principal lock (no store read): unknown kind or subject, account scope, no principal. */
export function principalLockPrecheck(
  principalId: string | undefined,
  requires: ToolRequires
): AuthzDecision | null {
  if (!KINDS.has(requires.kind) || !SUBJECTS.has(requires.subject))
    return deny("unknown_contract_value");
  if (!principalId) return deny("no_principal");
  if (requires.kind === "account") return deny("account_scope_unsupported");
  return null;
}

/**
 * The principal lock alone: no subject, no admin check. It is the first half of `authorize()`, shared with the run-start
 * filter (DENIAL_IS_TERMINAL: the model never sees a tool it cannot use) and the route door (a bearer caller is its own principal).
 */
export async function authorizePrincipalLock(
  store: AgentGrantsStore,
  input: { readonly principalId?: string | undefined; readonly requires: ToolRequires }
): Promise<AuthzDecision> {
  const { principalId, requires } = input;
  // FAIL_CLOSED_ON_UNKNOWN: `requires` comes from a published contract and this package is pinned independently,
  // so an unknown kind or subject (a newer contract) must deny, never run as `node` or `member`.
  const early = principalLockPrecheck(principalId, requires);
  if (early) return early;
  if (!principalId) return deny("no_principal");
  try {
    if (await store.hasLiveRole(principalId, requires.scope))
      return { decision: "allow", basis: "role" };
    // PERSONAL_DELEGATION: no node row. A delegable scope (declared `member`, a node scope) can also be opened by the agent's OWNER.
    if (requires.subject === "member" && requires.kind === "node" && DELEGABLE_SCOPES.includes(requires.scope)) {
      const owner = await store.agentOwner(principalId);
      if (owner && (await store.hasLiveRole(principalId, requires.scope, { kind: "delegated", ownerUserId: owner })))
        return { decision: "allow", basis: "personal_grant", owner };
    }
    return deny("no_role");
  } catch {
    return unavailable("store_unavailable");
  }
}

export async function authorize(
  store: AgentGrantsStore,
  adminCheck: AdminCheck,
  input: AuthorizeInput
): Promise<AuthzDecision> {
  const { principalId, subjectUserId, requires } = input;
  const lock = await authorizePrincipalLock(store, { principalId, requires });
  if (lock.decision === "deny") return lock;
  if (requires.kind === "own" && !subjectUserId) return deny("no_subject");

  if (subjectUserId && requires.subject === "admin" && input.adminSubjectWaived !== true) {
    let admin: Awaited<ReturnType<AdminCheck>>;
    try {
      admin = await adminCheck(subjectUserId);
    } catch {
      return unavailable("admin_check_failed");
    }
    if (admin === "unavailable") return unavailable("no_admin_authority");
    if (admin !== "allow") return deny("subject_not_admin");
  }
  return lock;
}
