// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` service
 * Purpose: Mint, verify, upgrade, rotate, confirm and revoke revocable agent keys over a `CredentialStore`.
 * Scope: Key format, hashing and the verify decision. No HTTP, no env, no v1 code (the v1 HMAC verify stays in the node).
 * Invariants:
 *   - TOKEN_HASH_ONLY: a key is 32 random bytes from the CSPRNG, shown once, stored only as sha256. It is derivable from nothing.
 *   - NEVER_CACHED: every verify reads the store. A revoke denies the next call.
 *   - STORE_OUTAGE_IS_NOT_401: a store failure is `unavailable`, so a caller answers 503, never a false 401.
 *   - FAIL_CLOSED_NON_DISCLOSING: every bad key is one `invalid` result; the reason is never told apart.
 *   - EVERY_STORE_FAILURE_IS_UNAVAILABLE: a store that throws at any step (verify, mint, confirm, revoke) surfaces as
 *     `CredentialStoreUnavailableError`, so a node answers 503 and never a 500 or a false 401.
 *   - PERIMETER_GUARD: a token with the wrong shape or a failing checksum is refused before any store read (`key-format.ts` owns the format).
 *   - ADMIT_BEFORE_STORE: an over-limit client gets `rate_limited` and no store read. The limiter itself lives in the node.
 *   - SPEND_ON_MISS: only a lookup that finds no usable key spends a limiter token (`onInvalid`); a valid key never does.
 *   - NO_SELF_APPROVAL (proofs): bind, recover, stop and lift never write `approved_by` and never touch a role row. An actor cannot lift its own stop.
 *   - CHECK_BEFORE_FETCH: the challenge (id, secret, expiry, attempts, consumed) is checked, and the node-wide GitHub budget spent, BEFORE any fetch.
 *     A wrong secret is `invalid_challenge`: it consumes nothing and counts no attempt, so nobody can burn another agent's challenge.
 *   - ADMIT_BEFORE_STORE (proofs): `admit` is the node's per-(challenge, IP) limiter check; `onInvalid` spends a token on a wrong secret only.
 * Side-effects: none (the store does the IO; the injected verifier does the GitHub read)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import type { AdminCheck } from "../types";
import { formatRevocableKey, isWellFormedRevocableKey } from "./key-format";
import {
  evaluateProofComment,
  type IssueRef,
  isWellFormedChallengeSecret,
  parseIssueRef,
  type ProofFailure,
  type ProofVerifier,
  proofLine,
  randomSecret,
  sha256Hex,
} from "./proofs";
import {
  type ChallengeRefusal,
  type ConfirmResult,
  type CredentialPolicy,
  type CredentialState,
  type CredentialStore,
  DEFAULT_CREDENTIAL_POLICY,
  DEFAULT_PROOF_POLICY,
  type GithubEvidence,
  type IssueResult,
  type ProofPolicy,
  type ProofPurpose,
} from "./types";

/** Thrown by a node's resolver when the store cannot answer, so the HTTP layer maps it to 503 instead of 401. */
export class CredentialStoreUnavailableError extends Error {
  readonly code = "authz_unavailable";
  constructor(cause?: unknown) {
    super("credential store unavailable");
    this.name = "CredentialStoreUnavailableError";
    attachCause(this, cause);
  }
}

/**
 * `Error`'s `cause` option is not in this package's ES2020 lib, so the cause is attached with `defineProperty` (non-enumerable, like the native one).
 * The cause may carry a database error whose message holds a key hash: it is for a debugger, never for a log line (see `storeFailureFields`).
 */
function attachCause(target: object, cause: unknown): void {
  if (cause !== undefined) Object.defineProperty(target, "cause", { value: cause, enumerable: false, writable: true, configurable: true });
}

/**
 * The only parts of a store failure that are safe to log: the error class and the SQLSTATE `code`. Never `message` (a unique-violation
 * detail carries a token hash). A node with a role that lacks BYPASSRLS, or a missing `agent_credential_state()`, shows up here.
 */
export function storeFailureFields(error: unknown): { errorClass?: string; sqlState?: string } {
  // An error, or a `verifyBearer` unavailable result: both carry the cause the same way.
  const cause = typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return {};
  const code = (cause as { code?: unknown }).code;
  return {
    errorClass: cause instanceof Error ? cause.name : typeof cause,
    ...(typeof code === "string" && code.length <= 16 ? { sqlState: code } : {}),
  };
}

/** Thrown when a client is over its per-IP limit on credential lookups: the node answers 429 and the store is never read. */
export class CredentialRateLimitedError extends Error {
  readonly code = "rate_limited";
  constructor() {
    super("credential lookup rate limited");
    this.name = "CredentialRateLimitedError";
  }
}

/**
 * Thrown for a signed key whose user already holds a confirmed revocable key: the signed key is superseded (401 `v1_superseded`).
 * `userId` is the verified signed-key subject, carried so the node can log a replayed signed key.
 */
export class V1SupersededError extends Error {
  readonly code = "v1_superseded";
  constructor(readonly userId: string) {
    super("signed key superseded by a revocable key");
    this.name = "V1SupersededError";
  }
}

/** Run a store call; any failure becomes `CredentialStoreUnavailableError`. */
async function viaStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
}

/** Call after a signed key verified for `userId`. Throws `V1SupersededError` once the user holds a confirmed revocable key. */
export async function assertV1NotSuperseded(store: CredentialStore, userId: string): Promise<void> {
  if (await viaStore(() => store.everConfirmed(userId))) throw new V1SupersededError(userId);
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** sha256 hex of the full key string. */
export async function hashAgentKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mintKey(): Promise<{ token: string; tokenHash: string }> {
  const token = formatRevocableKey(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  return { token, tokenHash: await hashAgentKey(token) };
}

export type VerifyResult =
  | {
      readonly ok: true;
      readonly credentialId: string;
      readonly userId: string;
      readonly name: string | null;
      readonly state: CredentialState;
    }
  | { readonly ok: false; readonly reason: "invalid" | "unavailable" | "rate_limited"; readonly cause?: unknown };

export interface VerifyOptions {
  /**
   * Called once per token that passed shape and checksum, BEFORE the store read. Return false when the caller is over its limit:
   * the result is `rate_limited` and the store is never read. It only CHECKS the limit; it must not spend anything.
   */
  readonly admit?: () => boolean;
  /**
   * Called when the lookup finds no usable key (`invalid`): the caller spends its limiter token here. A key that resolves, a bad shape
   * or checksum, and a store outage never call it, so a valid client is never throttled by its own traffic (SPEND_ON_MISS).
   */
  readonly onInvalid?: () => void;
}

/**
 * One hash lookup. `allow` lists the states the caller accepts: ordinary routes take `active` only; rotate also takes
 * `renew_only`; confirm takes `pending` and `active`.
 */
export async function verifyBearer(
  store: CredentialStore,
  token: string,
  allow: readonly CredentialState[] = ["active"],
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  if (!isWellFormedRevocableKey(token)) return { ok: false, reason: "invalid" };
  if (options.admit && !options.admit()) return { ok: false, reason: "rate_limited" };
  try {
    const row = await store.lookup(await hashAgentKey(token));
    if (!row || !allow.includes(row.state)) {
      options.onInvalid?.();
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, credentialId: row.credentialId, userId: row.userId, name: row.name, state: row.state };
  } catch (cause) {
    const unavailable: VerifyResult = { ok: false, reason: "unavailable" };
    attachCause(unavailable, cause);
    return unavailable;
  }
}

export type MintedKey =
  | { readonly ok: true; readonly credentialId: string; readonly userId: string; readonly apiKey: string; readonly pendingExpiresAt: string }
  | Extract<IssueResult, { ok: false }>;

/** A caller already authenticated with a signed key for `userId`: mint a pending revocable key for the same user. */
export async function upgradeSignedKey(
  store: CredentialStore,
  input: { userId: string; policy?: CredentialPolicy }
): Promise<MintedKey> {
  const { token, tokenHash } = await mintKey();
  const result = await viaStore(() =>
    store.issueUpgrade({ userId: input.userId, tokenHash, policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY })
  );
  return result.ok ? { ...result, apiKey: token } : result;
}

/** A caller authenticated with `credentialId` (active or renew_only): mint its pending successor. Replay-safe: a repeat supersedes. */
export async function rotateCredential(
  store: CredentialStore,
  input: { credentialId: string; policy?: CredentialPolicy }
): Promise<MintedKey> {
  const { token, tokenHash } = await mintKey();
  const result = await viaStore(() =>
    store.issueSuccessor({
      predecessorId: input.credentialId,
      tokenHash,
      policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY,
    })
  );
  return result.ok ? { ...result, apiKey: token } : result;
}

/** A caller authenticated WITH the pending key (that proves it stored the key): activate it, retire its predecessor. */
export function confirmCredential(
  store: CredentialStore,
  input: { credentialId: string; policy?: CredentialPolicy }
): Promise<ConfirmResult> {
  return viaStore(() => store.confirm({ credentialId: input.credentialId, policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY }));
}

export function revokeCredential(
  store: CredentialStore,
  input: { credentialId: string; userId: string; revokedBy: string }
): Promise<boolean> {
  return viaStore(() => store.revoke({ ...input, reason: "revoked" }));
}


// ---------------------------------------------------------------------------------------------------------------------
// Proofs: bind a GitHub account, recover a key, stop and lift (task.0091, slice S1a of task.5474)
// ---------------------------------------------------------------------------------------------------------------------

/** What the node supplies once: its id (inside every proof line), the allowlisted proof issues and the limits. */
export interface ProofConfig {
  readonly nodeId: string;
  /** `owner/repo#number` entries. Empty = every proof route answers `proof_unavailable`. */
  readonly issues: readonly string[];
  readonly policy?: ProofPolicy;
}

export type ProofRefusal =
  | "invalid_challenge"
  | "proof_failed"
  | "proof_unavailable"
  | "rate_limited"
  | "already_linked"
  | "binding_exists"
  | "no_binding"
  | "recovery_limited"
  | "not_agent"
  | "stopped";

export type ChallengeOutcome =
  | {
      readonly ok: true;
      readonly challengeId: string;
      readonly proofLine: string;
      /** Shown once to the requester. The store keeps only its sha256. */
      readonly challengeSecret: string;
      readonly expiresAt: string;
      readonly issues: readonly string[];
    }
  | { readonly ok: false; readonly reason: ChallengeRefusal | "proof_unavailable" };

/** Bind (authenticated caller) or recover (anonymous) challenge. */
export async function issueProofChallenge(
  store: CredentialStore,
  input: ProofConfig & { purpose: ProofPurpose; principalUserId?: string }
): Promise<ChallengeOutcome> {
  if (input.issues.length === 0) return { ok: false, reason: "proof_unavailable" };
  if (input.purpose === "bind" && !input.principalUserId) return { ok: false, reason: "unknown_user" };
  const challengeId = crypto.randomUUID();
  const nonce = randomSecret();
  const challengeSecret = randomSecret();
  const result = await viaStore(async () =>
    store.createChallenge({
      challengeId,
      purpose: input.purpose,
      principalUserId: input.purpose === "bind" ? (input.principalUserId as string) : null,
      nonceHash: await sha256Hex(nonce),
      secretHash: await sha256Hex(challengeSecret),
      policy: input.policy ?? DEFAULT_PROOF_POLICY,
    })
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    challengeId,
    proofLine: proofLine(input.nodeId, challengeId, nonce),
    challengeSecret,
    expiresAt: result.expiresAt,
    issues: input.issues,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProofAttempt {
  readonly challengeId: string;
  readonly challengeSecret: string;
  /** One of `ProofConfig.issues`. */
  readonly issue: string;
  readonly commentId: number;
  /** The per-(challenge, IP) wrong-secret limiter: only CHECKS. False = over the limit, nothing is read. */
  readonly admit?: () => boolean;
  /** Spends one limiter token. Called only for a wrong or unknown secret. */
  readonly onInvalid?: () => void;
}

type ProofChecked =
  | { readonly ok: true; readonly secretHash: string; readonly evidence: GithubEvidence }
  | { readonly ok: false; readonly reason: ProofRefusal; readonly failure?: ProofFailure };

async function checkProof(
  store: CredentialStore,
  verifier: ProofVerifier,
  config: ProofConfig,
  purpose: ProofPurpose,
  principalUserId: string | null,
  attempt: ProofAttempt
): Promise<ProofChecked> {
  const policy = config.policy ?? DEFAULT_PROOF_POLICY;
  if (config.issues.length === 0) return { ok: false, reason: "proof_unavailable" };
  if (attempt.admit && !attempt.admit()) return { ok: false, reason: "rate_limited" };
  if (!isWellFormedChallengeSecret(attempt.challengeSecret) || !UUID.test(attempt.challengeId)) {
    attempt.onInvalid?.();
    return { ok: false, reason: "invalid_challenge" };
  }
  const secretHash = await sha256Hex(attempt.challengeSecret);
  const opened = await viaStore(() =>
    store.openProofCheck({ challengeId: attempt.challengeId, secretHash, purpose, principalUserId, policy })
  );
  if (!opened.ok) {
    if (opened.reason === "invalid_challenge") {
      attempt.onInvalid?.();
      return { ok: false, reason: "invalid_challenge" };
    }
    return { ok: false, reason: "proof_unavailable" }; // the node's GitHub budget is spent: delay, never grant
  }
  const fail = async (failure: ProofFailure): Promise<ProofChecked> => {
    await viaStore(() => store.recordProofFailure({ challengeId: attempt.challengeId }));
    return { ok: false, reason: "proof_failed", failure };
  };
  const issue: IssueRef | null = config.issues.includes(attempt.issue) ? parseIssueRef(attempt.issue) : null;
  if (!issue) return fail("issue_not_allowed");
  if (!Number.isSafeInteger(attempt.commentId) || attempt.commentId <= 0) return fail("comment_not_found");

  const read = await verifier.fetchComment({ issue, commentId: attempt.commentId }).catch((): { kind: "unavailable" } => ({ kind: "unavailable" }));
  const verdict = await evaluateProofComment(read, issue, {
    nodeId: config.nodeId,
    challengeId: attempt.challengeId,
    nonceHash: opened.nonceHash,
    issuedAt: opened.issuedAt,
    expiresAt: opened.expiresAt,
    commentSkewSec: policy.commentSkewSec,
  });
  if (verdict.ok === "unavailable") return { ok: false, reason: "proof_unavailable" }; // consumes nothing, counts nothing
  if (!verdict.ok) return fail(verdict.reason);
  return {
    ok: true,
    secretHash,
    evidence: { githubId: verdict.githubId, login: verdict.login, userType: verdict.userType, commentId: attempt.commentId, issue: attempt.issue },
  };
}

export type BindOutcome =
  | { readonly ok: true; readonly result: "created" | "already_bound"; readonly githubId: string; readonly userType: "User" | "Bot" }
  | { readonly ok: false; readonly reason: ProofRefusal; readonly failure?: ProofFailure };

/** The authenticated agent proves it controls a GitHub account. `principalUserId` is the caller the node already authenticated. */
export async function bindGithubIdentity(
  store: CredentialStore,
  verifier: ProofVerifier,
  config: ProofConfig,
  input: ProofAttempt & { principalUserId: string }
): Promise<BindOutcome> {
  const checked = await checkProof(store, verifier, config, "bind", input.principalUserId, input);
  if (!checked.ok) return checked;
  const policy = config.policy ?? DEFAULT_PROOF_POLICY;
  const done = await viaStore(() =>
    store.finishBind({
      challengeId: input.challengeId,
      secretHash: checked.secretHash,
      principalUserId: input.principalUserId,
      evidence: checked.evidence,
      policy,
    })
  );
  if (!done.ok) return { ok: false, reason: done.reason };
  return { ok: true, result: done.result, githubId: checked.evidence.githubId, userType: checked.evidence.userType };
}

export type RecoverOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly credentialId: string;
      readonly apiKey: string;
      readonly expiresAt: string;
      readonly renewUntil: string;
      readonly revokedCount: number;
    }
  | { readonly ok: false; readonly reason: ProofRefusal; readonly failure?: ProofFailure };

/** An agent with no key proves the GitHub account bound to its principal and gets ONE active key on the SAME `users.id`. Every other key dies. */
export async function recoverCredential(
  store: CredentialStore,
  verifier: ProofVerifier,
  config: ProofConfig,
  input: ProofAttempt
): Promise<RecoverOutcome> {
  const checked = await checkProof(store, verifier, config, "recover", null, input);
  if (!checked.ok) return checked;
  const policy = config.policy ?? DEFAULT_PROOF_POLICY;
  const { token, tokenHash } = await mintKey();
  const done = await viaStore(() =>
    store.finishRecover({
      challengeId: input.challengeId,
      secretHash: checked.secretHash,
      githubId: checked.evidence.githubId,
      tokenHash,
      policy,
    })
  );
  if (!done.ok) return { ok: false, reason: done.reason };
  return {
    ok: true,
    userId: done.userId,
    credentialId: done.credentialId,
    apiKey: token,
    expiresAt: done.expiresAt,
    renewUntil: done.renewUntil,
    revokedCount: done.revokedCount,
  };
}

export type StopActor = { readonly actorUserId: string; readonly targetUserId: string; readonly plane: "human" | "ai" };
export type StopOutcome =
  | { readonly ok: true; readonly revokedCount: number }
  | { readonly ok: false; readonly reason: "authz_denied" | "authz_unavailable" | "principal_not_found" | "not_agent" };
export type LiftOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "authz_denied" | "authz_unavailable" | "principal_not_found" | "not_stopped" | "self_lift" };

/** The ONE admin gate of stop and lift, for both doors: a throw or `unavailable` is 503, never an allow. */
async function adminAllows(adminCheck: AdminCheck, actorUserId: string): Promise<"allow" | "authz_denied" | "authz_unavailable"> {
  const decision = await adminCheck(actorUserId).catch(() => "unavailable" as const);
  return decision === "allow" ? "allow" : decision === "unavailable" ? "authz_unavailable" : "authz_denied";
}

/**
 * Stop: every credential of the target dies and the agent cannot bind or recover until a lift. It removes only; it never writes `approved_by`.
 * The human door (the keys row) and the bearer twin both call this, so the check is the same by construction.
 */
export async function revokePrincipalCredentials(store: CredentialStore, adminCheck: AdminCheck, input: StopActor): Promise<StopOutcome> {
  const gate = await adminAllows(adminCheck, input.actorUserId);
  if (gate !== "allow") return { ok: false, reason: gate };
  const result = await viaStore(() => store.revokeAllForPrincipal({ actorUserId: input.actorUserId, targetUserId: input.targetUserId }));
  return result.ok ? { ok: true, revokedCount: result.revokedCount } : result;
}

/** Lift: sets `lifted_at`. Mints nothing and revives no key. An actor cannot lift its own stop. */
export async function liftPrincipalStop(store: CredentialStore, adminCheck: AdminCheck, input: StopActor): Promise<LiftOutcome> {
  const gate = await adminAllows(adminCheck, input.actorUserId);
  if (gate !== "allow") return { ok: false, reason: gate };
  if (input.actorUserId === input.targetUserId) return { ok: false, reason: "self_lift" };
  const result = await viaStore(() => store.liftStop({ actorUserId: input.actorUserId, targetUserId: input.targetUserId }));
  return result.ok ? { ok: true } : result;
}
