// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Host-only durable ports. Secret values cannot appear in LinkView. */
import type { JWK } from "jose";
import type {
  ConnectionKey,
  EnrollmentIntent,
  PendingKeyEnvelope,
} from "../protocol";
export type LinkPhase =
  | "start_ready"
  | "start_unknown"
  | "awaiting_consent"
  | "key_staged"
  | "confirm_unknown"
  | "connected"
  | "disconnected"
  | "denied"
  | "expired"
  | "expired_unknown"
  | "needs_reenroll";
export interface ReplacementBasis {
  operationId: string;
  intentDigest: string;
  disposition: "not_accepted" | "terminal";
  observedAt: string;
}
export interface LinkState {
  /** Authenticated accepted-only reconciliation for an explicit local replacement; never an automatic restart. */
  replacementBasis?: ReplacementBasis;
  key: ConnectionKey;
  intent: EnrollmentIntent;
  intentDigest: string;
  originalTokenDigest: string;
  phase: LinkPhase;
  nextAction: "start" | "poll" | "confirm" | "continue" | "none";
  acceptedAt?: string;
  recoveryExpiresAt?: string;
  enrollmentId?: string;
  principalUserId?: string;
  credentialId?: string;
  pendingExpiresAt?: string;
  expiresAt?: string;
  renewUntil?: string;
  connectionId?: string;
  attempts: number;
  paused: boolean;
  quarantined?: boolean;
  error:
    | "permission_off"
    | "transient"
    | "unconfirmed"
    | "key_rejected"
    | "protocol_error"
    | null;
}
export interface LinkSecrets {
  token: string;
  privateJwk: JWK;
  deviceCode?: string;
}
export interface LinkRow {
  operationId: string;
  revision: number;
  fence: number;
  state: LinkState;
  encryptedSecrets: string | null;
  nextAttemptAt: string;
  secretDeadline: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
}
export interface LinkHandle {
  operationId: string;
  key: ConnectionKey;
}
export interface LinkView {
  linkId: string;
  revision: number;
  phase: LinkPhase;
  generation: number;
  nextAttemptAt: string;
  paused: boolean;
  error: LinkState["error"];
}
export interface LeaseGuard {
  operationId: string;
  key: ConnectionKey;
  revision: number;
  fence: number;
  leaseOwner: string;
}
export interface CustodyCipher {
  keyId: string;
  seal(plaintext: string, aad: string): Promise<Uint8Array>;
  open(ciphertext: Uint8Array, aad: string): Promise<string>;
}
export interface RequesterStore {
  readonly durable: true;
  reserve(row: LinkRow): Promise<LinkRow>;
  replace?(
    handle: LinkHandle,
    expectedRevision: number,
    draft: LinkRow
  ): Promise<LinkRow | null>;
  read(handle: LinkHandle): Promise<LinkRow | null>;
  acquire(handle: LinkHandle, owner: string): Promise<LinkRow | null>;
  /** Every transition compares full K + revision + fence + live lease; DB time owns deadlines. */
  update(
    guard: LeaseGuard,
    change: {
      state: LinkState;
      encryptedSecrets?: string | null;
      delaySec?: number;
      release?: boolean;
    }
  ): Promise<LinkRow | null>;
  stage(
    guard: LeaseGuard,
    envelope: PendingKeyEnvelope
  ): Promise<LinkRow | null>;
  publish(
    guard: LeaseGuard,
    deadlines: { expiresAt: string; renewUntil: string }
  ): Promise<LinkRow | null>;
  disconnect(
    handle: LinkHandle,
    expectedRevision: number
  ): Promise<LinkRow | null>;
  keyRejected(
    handle: LinkHandle,
    expected: { connectionId: string; credentialId: string }
  ): Promise<boolean>;
}
export interface RequesterVault {
  /** Staged credentials are readable only by exact fenced confirmation; broker requires ready and a connected current pointer. */
  readStaged(
    guard: LeaseGuard,
    connectionId: string,
    credentialId: string
  ): Promise<string | null>;
  resolveServiceConnection(
    input: LinkHandle & { connectionId: string; credentialId: string }
  ): Promise<string | null>;
}
export const linkView = (row: LinkRow): LinkView => ({
  linkId: row.operationId,
  revision: row.revision,
  generation: row.state.intent.generation,
  phase: row.state.phase,
  nextAttemptAt: row.nextAttemptAt,
  paused: row.state.paused,
  error: row.state.error,
});
