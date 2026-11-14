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
 *   - ACCOUNT_NEEDS_ACCOUNT (R1, R13): an `account` tool is decided only against one account. With no `accountId` it is denied (`no_account`);
 *     with one, the principal needs a live account row for exactly that account (`hasLiveAccountGrant`). Node rows never satisfy it and
 *     account rows never satisfy a node tool.
 *   - ONE_ACCOUNT_DOOR: `authorizeAccount()` is the one answer for account data on a route: owner | delegated | null (a non-disclosing 404).
 *   - FAIL_CLOSED_NON_DISCLOSING: a store or admin outage is `authz_unavailable`, never an allow.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads)
 * @public
 */

import type {
  AccountAccess,
  AdminCheck,
  AgentGrantsStore,
  AuthzDecision,
  ToolRequires,
} from "./types";

export interface AuthorizeInput {
  readonly principalId?: string | undefined;
  readonly subjectUserId?: string | undefined;
  /** The account the run acts on. Only an `account` tool reads it. */
  readonly accountId?: string | undefined;
  readonly requires: ToolRequires;
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

/** The contract-only denials of the principal lock (no store read): unknown kind or subject, no principal, an account tool with no account. */
export function principalLockPrecheck(
  principalId: string | undefined,
  requires: ToolRequires,
  accountId?: string | undefined
): AuthzDecision | null {
  if (!KINDS.has(requires.kind) || !SUBJECTS.has(requires.subject))
    return deny("unknown_contract_value");
  if (!principalId) return deny("no_principal");
  if (requires.kind === "account" && !accountId) return deny("no_account");
  return null;
}

/**
 * The principal lock alone: no subject, no admin check. It is the first half of `authorize()`, shared with the run-start
 * filter (DENIAL_IS_TERMINAL: the model never sees a tool it cannot use) and the route door (a bearer caller is its own principal).
 */
export async function authorizePrincipalLock(
  store: AgentGrantsStore,
  input: {
    readonly principalId?: string | undefined;
    readonly accountId?: string | undefined;
    readonly requires: ToolRequires;
  }
): Promise<AuthzDecision> {
  const { principalId, requires, accountId } = input;
  // FAIL_CLOSED_ON_UNKNOWN: `requires` comes from a published contract and this package is pinned independently,
  // so an unknown kind or subject (a newer contract) must deny, never run as `node` or `member`.
  const early = principalLockPrecheck(principalId, requires, accountId);
  if (early) return early;
  if (!principalId) return deny("no_principal");
  try {
    if (requires.kind === "account") {
      // The same call at the run-start filter and at exec (DENIAL_IS_TERMINAL), so the two cannot disagree.
      if (!accountId || !(await store.hasLiveAccountGrant(principalId, requires.scope, accountId)))
        return deny("no_role");
    } else if (!(await store.hasLiveRole(principalId, requires.scope))) return deny("no_role");
  } catch {
    return unavailable("store_unavailable");
  }
  return { decision: "allow", basis: "role" };
}

export async function authorize(
  store: AgentGrantsStore,
  adminCheck: AdminCheck,
  input: AuthorizeInput
): Promise<AuthzDecision> {
  const { principalId, subjectUserId, accountId, requires } = input;
  const lock = await authorizePrincipalLock(store, { principalId, accountId, requires });
  if (lock.decision === "deny") return lock;
  if (requires.kind === "own" && !subjectUserId) return deny("no_subject");

  if (subjectUserId && requires.subject === "admin") {
    let admin: Awaited<ReturnType<AdminCheck>>;
    try {
      admin = await adminCheck(subjectUserId);
    } catch {
      return unavailable("admin_check_failed");
    }
    if (admin === "unavailable") return unavailable("no_admin_authority");
    if (admin !== "allow") return deny("subject_not_admin");
  }
  return { decision: "allow", basis: "role" };
}

export interface AuthorizeAccountInput {
  /** The caller's user id: the signed-in person, or the bearer agent. */
  readonly callerUserId: string;
  /** How the request authenticated. A `bearer` caller is an agent, so a delegated row can apply; a session caller is a person. */
  readonly via: "bearer" | "session";
  readonly scope: string;
  readonly accountId: string;
}

/**
 * The ONE answer for a read of one account's data on a route: `owner` (the caller owns the account), `delegated` (a bearer agent holds a live
 * account row for this scope and this exact account), or null. A null is a non-disclosing 404: foreign, expired, revoked, wrong-scope and
 * missing accounts are indistinguishable. A store failure throws (the route says 503), never allows.
 */
export async function authorizeAccount(
  store: AgentGrantsStore,
  input: AuthorizeAccountInput
): Promise<AccountAccess> {
  if (await store.ownsAccount(input.callerUserId, input.accountId)) return "owner";
  if (
    input.via === "bearer" &&
    (await store.hasLiveAccountGrant(input.callerUserId, input.scope, input.accountId))
  )
    return "delegated";
  return null;
}
