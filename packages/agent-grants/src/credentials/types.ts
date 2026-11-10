// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` types
 * Purpose: Boundary types and the store port for revocable, hashed agent credentials (v2 keys).
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

export type CredentialCreatedFrom = "legacy_upgrade" | "rotation";

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

export type IssueRefusal = "unknown_user" | "wallet_user" | "internal_principal" | "already_upgraded" | "binding_required" | "not_rotatable";

export type IssueResult =
  | { readonly ok: true; readonly credentialId: string; readonly userId: string; readonly pendingExpiresAt: string }
  | { readonly ok: false; readonly reason: IssueRefusal };

export type ConfirmResult =
  | { readonly ok: true; readonly status: "confirmed" | "already_active"; readonly userId: string; readonly expiresAt: string; readonly renewUntil: string }
  | { readonly ok: false; readonly reason: "revoked" | "expired" | "predecessor_revoked" | "not_found" };

/**
 * Persistence port. Every method is one atomic unit; the Postgres adapter runs each in one transaction.
 * Expiry and ordering use the database clock, never the app's.
 */
export interface CredentialStore {
  /** The credential whose key hashes to `tokenHash`, with its derived state, else null. Never cached. */
  lookup(tokenHash: string): Promise<CredentialLookup | null>;
  /**
   * v1 key -> pending v2 key for the SAME `users.id`. Creates the external `agent_principals` row when absent. Refuses a wallet user,
   * an internal principal, a user that already holds a live v2 key, and a user with live role rows and no GitHub binding
   * (BINDING_BEFORE_UPGRADE). A pending upgrade key from an earlier call is superseded.
   */
  issueUpgrade(input: { userId: string; tokenHash: string; policy: CredentialPolicy }): Promise<IssueResult>;
  /**
   * Locks the predecessor (`active` or `renew_only` only), revokes any unconfirmed successor (`superseded`), inserts a fresh
   * pending successor. Calls serialize on the predecessor; the last wins.
   */
  issueSuccessor(input: { predecessorId: string; tokenHash: string; policy: CredentialPolicy }): Promise<IssueResult>;
  /** Activates a pending credential and revokes its predecessor (`rotated`) in one transaction. Idempotent for an active credential. */
  confirm(input: { credentialId: string; policy: CredentialPolicy }): Promise<ConfirmResult>;
  /**
   * True when the user holds, or ever held, a CONFIRMED v2 credential, revoked or not. After an upgrade the user's v1 keys stop working,
   * and revoking the v2 key must not bring them back (a leaked v1 key could otherwise re-upgrade).
   */
  everConfirmed(userId: string): Promise<boolean>;
  /** Revokes the credential (owned by `userId`) and any pending successor. False when none is live. */
  revoke(input: { credentialId: string; userId: string; reason: string; revokedBy: string }): Promise<boolean>;
}
