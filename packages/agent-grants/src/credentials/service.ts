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
 * Side-effects: none (the store does the IO)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { formatRevocableKey, isWellFormedRevocableKey } from "./key-format";
import {
  type ConfirmResult,
  type CredentialPolicy,
  type CredentialState,
  type CredentialStore,
  DEFAULT_CREDENTIAL_POLICY,
  type IssueResult,
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

/** A fresh revocable key and its sha256 (the store sees only the hash). Exported for `@cogni-dao/agent-grants/enrollment`, which mints the key a poll seals. */
export async function mintKey(): Promise<{ token: string; tokenHash: string }> {
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
