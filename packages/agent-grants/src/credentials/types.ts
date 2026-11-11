// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` types
 * Purpose: Boundary types and the store port for revocable, hashed agent credentials (revocable keys).
 * Scope: Types only. The store sees the sha256 of a key, never the key (TOKEN_HASH_ONLY).
 * Invariants:
 *   - STATE_IS_DERIVED: a credential's state comes from its timestamps, read against the DATABASE clock. It is never stored.
 *   - Identities cross the boundary as plain strings (`users.id`, `agent_credentials.id`).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5474
 * @public
 */

/**
 * pending: issued, not yet confirmed, inside its window. pending_expired: never confirmed in time.
 * active: confirmed and unexpired. renew_only: expired, inside the renew window (it may only rotate, revoke, confirm).
 * expired: past the renew window. revoked: ended by `revoked_at`.
 */
export type CredentialState = "pending" | "pending_expired" | "active" | "renew_only" | "expired" | "revoked";

export type CredentialCreatedFrom = "key_upgrade" | "rotation" | "binding_recovery";

/** Lifetimes in seconds. Passed to the store so the database clock does the arithmetic. */
export interface CredentialPolicy {
  /** Life of a confirmed key before it needs a rotation. */
  readonly ttlSec: number;
  /** Extra life after expiry during which the key may still rotate. */
  readonly renewWindowSec: number;
  /** How long an unconfirmed successor stays usable for `confirm`. */
  readonly pendingSec: number;
}

export const DEFAULT_CREDENTIAL_POLICY: CredentialPolicy = {
  ttlSec: 30 * 24 * 3600,
  renewWindowSec: 14 * 24 * 3600,
  pendingSec: 15 * 60,
};

export interface CredentialLookup {
  readonly credentialId: string;
  readonly userId: string;
  /** The registered name (`users.name`), for the resolved identity. */
  readonly name: string | null;
  readonly state: CredentialState;
  readonly expiresAt: string;
  readonly renewUntil: string;
}

export type IssueRefusal =
  | "unknown_user"
  | "wallet_user"
  | "internal_principal"
  | "already_upgraded"
  | "binding_required"
  | "not_rotatable"
  /** An admin stopped this agent (`agent_stops`): no key, no upgrade, until a lift and a recovery. */
  | "stopped";

export type IssueResult =
  | { readonly ok: true; readonly credentialId: string; readonly userId: string; readonly pendingExpiresAt: string }
  | { readonly ok: false; readonly reason: IssueRefusal };

export type ConfirmResult =
  | { readonly ok: true; readonly status: "confirmed" | "already_active"; readonly userId: string; readonly expiresAt: string; readonly renewUntil: string }
  | { readonly ok: false; readonly reason: "revoked" | "expired" | "predecessor_revoked" | "not_found" | "binding_required" | "stopped" };

/**
 * Does this principal hold deploy or node roles? A node supplies the read: node-template reads `agent_roles` (`agentRolesHasRoles`); the operator
 * supplies its OpenFGA read. A throw is an outage (503), never "no roles". BINDING_BEFORE_UPGRADE uses it at upgrade AND at confirm.
 */
export type HasRoles = (userId: string) => Promise<boolean>;

/**
 * Persistence port. Every method is one atomic unit; the Postgres adapter runs each in one transaction.
 * Expiry and ordering use the database clock, never the app's.
 */
export interface CredentialStore {
  /** The credential whose key hashes to `tokenHash`, with its derived state, else null. Never cached. */
  lookup(tokenHash: string): Promise<CredentialLookup | null>;
  /**
   * signed key -> pending revocable key for the SAME `users.id`. Creates the external `agent_principals` row when absent. Refuses a wallet user,
   * an internal principal, a user that already holds a live revocable key, and a user with live role rows and no GitHub binding
   * (BINDING_BEFORE_UPGRADE, role read = the node's `HasRoles`). A pending upgrade key from an earlier call is superseded.
   */
  issueUpgrade(input: { userId: string; tokenHash: string; policy: CredentialPolicy }): Promise<IssueResult>;
  /**
   * Locks the predecessor (`active` or `renew_only` only), revokes any unconfirmed successor (`superseded`), inserts a fresh
   * pending successor. Calls serialize on the predecessor; the last wins.
   */
  issueSuccessor(input: { predecessorId: string; tokenHash: string; policy: CredentialPolicy }): Promise<IssueResult>;
  /**
   * Activates a pending credential and revokes its predecessor (`rotated`) in one transaction. Idempotent for an active credential.
   * An UPGRADE key is refused `binding_required` when its user now holds roles and has no GitHub binding (roles approved after the upgrade call).
   */
  confirm(input: { credentialId: string; policy: CredentialPolicy }): Promise<ConfirmResult>;
  /**
   * True when the user holds, or ever held, a CONFIRMED revocable credential, revoked or not, OR has an `agent_stops` row (stopped, lifted or not).
   * After an upgrade, or after an admin stop, the user's signed keys stop working for good, and revoking the revocable key must not bring them back
   * (a leaked signed key could otherwise re-upgrade). One query: the signed-key gate gains no second read.
   */
  everConfirmed(userId: string): Promise<boolean>;
  /** Revokes the credential (owned by `userId`) and any pending successor. False when none is live. */
  revoke(input: { credentialId: string; userId: string; reason: string; revokedBy: string }): Promise<boolean>;

  /** Makes one proof challenge (bind or recover). Refuses a stopped or unknown bind principal, and any limit in `policy`. Prunes expired rows. */
  createChallenge(input: CreateChallengeInput): Promise<ChallengeIssueResult>;
  /**
   * Step 1 of bind and recover, BEFORE any GitHub fetch. Checks the challenge (purpose, principal, secret hash, unconsumed, unexpired, attempts
   * below the cap) and, in the same statement, spends one unit of the node-wide fetch budget (`fetched_at`). A wrong secret changes nothing
   * (no attempt, no budget). Returns what the comment check needs.
   */
  openProofCheck(input: OpenProofCheckInput): Promise<OpenProofCheckResult>;
  /** One failed comment check: attempts + 1. The challenge is dead at `policy.maxFailedChecks`. */
  recordProofFailure(input: { challengeId: string }): Promise<{ attempts: number }>;
  /** Bind transaction (see the design). Consumes the challenge on success. */
  finishBind(input: FinishBindInput): Promise<FinishBindResult>;
  /** Recover transaction. Revokes every live key of the user and inserts ONE active key. Consumes the challenge on success. */
  finishRecover(input: FinishRecoverInput): Promise<FinishRecoverResult>;
  /** Stop: upsert the `agent_stops` row and revoke every live credential, under the user lock. Safe to repeat (the repeat revokes 0). */
  revokeAllForPrincipal(input: { actorUserId: string; targetUserId: string }): Promise<StopResult>;
  /** Lift: set `lifted_at`. Mints nothing, revives nothing. */
  liftStop(input: { actorUserId: string; targetUserId: string }): Promise<LiftResult>;
  /** The agents the admin table's keys rows show. Bounded: at most `limit` rows plus a count of the rest. */
  listKeyHolders(limit: number): Promise<{ holders: KeyHolder[]; more: number }>;
}

export type ProofPurpose = "bind" | "recover";

/** Limits for proofs, all counted on the DATABASE clock. Every limit fails toward "no key". */
export interface ProofPolicy {
  /** Life of a challenge. */
  readonly challengeTtlSec: number;
  /** Failed comment checks that kill a challenge. A wrong secret counts nothing. */
  readonly maxFailedChecks: number;
  /** A comment may be this much older than the challenge, or newer than its expiry. */
  readonly commentSkewSec: number;
  /** Bind challenges: open at once, and per hour, per principal. */
  readonly bindOpenPerPrincipal: number;
  readonly bindPerHourPerPrincipal: number;
  /** Recover challenges (anonymous): per hour for the whole node, and open at once. */
  readonly recoverPerHourNode: number;
  readonly maxOpenChallenges: number;
  /** GitHub fetches per hour for the whole node (counted from `fetched_at`). The node picks the smaller number when it holds no App token. */
  readonly fetchBudgetPerHour: number;
  /** Recoveries per principal per 24 hours. */
  readonly recoveriesPerDay: number;
  /** Lifetimes of the key a recovery mints. */
  readonly credential: CredentialPolicy;
}

export const DEFAULT_PROOF_POLICY: ProofPolicy = {
  challengeTtlSec: 10 * 60,
  maxFailedChecks: 3,
  commentSkewSec: 60,
  bindOpenPerPrincipal: 3,
  bindPerHourPerPrincipal: 5,
  recoverPerHourNode: 20,
  maxOpenChallenges: 200,
  fetchBudgetPerHour: 1000,
  recoveriesPerDay: 5,
  credential: DEFAULT_CREDENTIAL_POLICY,
};

export interface CreateChallengeInput {
  /** Made by the service: it goes into the proof line, so it exists before the row. */
  readonly challengeId: string;
  readonly purpose: ProofPurpose;
  /** Required for bind (the authenticated caller), null for recover. */
  readonly principalUserId: string | null;
  readonly nonceHash: string;
  readonly secretHash: string;
  readonly policy: ProofPolicy;
}

export type ChallengeRefusal = "stopped" | "unknown_user" | "rate_limited";
export type ChallengeIssueResult =
  | { readonly ok: true; readonly challengeId: string; readonly issuedAt: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: ChallengeRefusal };

export interface OpenProofCheckInput {
  readonly challengeId: string;
  readonly secretHash: string;
  readonly purpose: ProofPurpose;
  /** Bind: the authenticated caller, who must own the challenge. Recover: null. */
  readonly principalUserId: string | null;
  readonly policy: ProofPolicy;
}
export type OpenProofCheckResult =
  | { readonly ok: true; readonly issuedAt: string; readonly expiresAt: string; readonly nonceHash: string }
  /** `invalid_challenge`: unknown, wrong secret, wrong purpose or owner, consumed, expired or dead. One answer for all. `fetch_budget`: the node spent its GitHub budget. */
  | { readonly ok: false; readonly reason: "invalid_challenge" | "fetch_budget" };

export interface GithubEvidence {
  /** `String(user.id)`: the account's numeric id. A GitHub App comment gives the id of its bot user. */
  readonly githubId: string;
  readonly login: string;
  readonly userType: "User" | "Bot";
  readonly commentId: number;
  readonly issue: string;
}

export interface FinishBindInput {
  readonly challengeId: string;
  readonly secretHash: string;
  readonly principalUserId: string;
  readonly evidence: GithubEvidence;
  readonly policy: ProofPolicy;
}
export type FinishBindResult =
  | { readonly ok: true; readonly result: "created" | "already_bound" }
  | {
      readonly ok: false;
      readonly reason: "invalid_challenge" | "stopped" | "not_agent" | "binding_exists" | "already_linked";
    };

export interface FinishRecoverInput {
  readonly challengeId: string;
  readonly secretHash: string;
  readonly githubId: string;
  /** sha256 of the new key (the service minted it). */
  readonly tokenHash: string;
  readonly policy: ProofPolicy;
}
export type FinishRecoverResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly credentialId: string;
      readonly expiresAt: string;
      readonly renewUntil: string;
      readonly revokedCount: number;
    }
  | { readonly ok: false; readonly reason: "invalid_challenge" | "no_binding" | "stopped" | "recovery_limited" };

export type StopResult =
  | { readonly ok: true; readonly revokedCount: number }
  | { readonly ok: false; readonly reason: "principal_not_found" | "not_agent" };
export type LiftResult = { readonly ok: true } | { readonly ok: false; readonly reason: "principal_not_found" | "not_stopped" };

/**
 * One agent on the admin table's keys row. `on` = the agent can still call this node with a key (a live revocable key, or a role-holding
 * signed-key agent with no confirmed key and no stop row). A stopped agent is `on: false` and stays visible until a lift AND no live key.
 */
export interface KeyHolder {
  readonly userId: string;
  readonly name: string | null;
  /** The proven GitHub id, or null. */
  readonly githubId: string | null;
  readonly on: boolean;
}
