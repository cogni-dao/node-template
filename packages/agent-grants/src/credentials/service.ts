// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` service
 * Purpose: Mint, verify, upgrade, rotate, confirm and revoke v2 agent keys over a `CredentialStore`.
 * Scope: Key format, hashing and the verify decision. No HTTP, no env, no v1 code (the v1 HMAC verify stays in the node).
 * Invariants:
 *   - TOKEN_HASH_ONLY: a key is 32 random bytes from the CSPRNG, shown once, stored only as sha256. It is derivable from nothing.
 *   - NEVER_CACHED: every verify reads the store. A revoke denies the next call.
 *   - STORE_OUTAGE_IS_NOT_401: a store failure is `unavailable`, so a caller answers 503, never a false 401.
 *   - FAIL_CLOSED_NON_DISCLOSING: every bad key is one `invalid` result; the reason is never told apart.
 * Side-effects: none (the store does the IO)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import {
  type ConfirmResult,
  type CredentialPolicy,
  type CredentialState,
  type CredentialStore,
  DEFAULT_CREDENTIAL_POLICY,
  type IssueResult,
} from "./types";

export const AGENT_KEY_V2_PREFIX = "cogni_ag_sk_v2_";
/** 32 bytes, base64url, no padding. */
const SECRET_CHARS = 43;

/** Thrown by a node's resolver when the store cannot answer, so the HTTP layer maps it to 503 instead of 401. */
export class CredentialStoreUnavailableError extends Error {
  readonly code = "authz_unavailable";
  constructor() {
    super("credential store unavailable");
    this.name = "CredentialStoreUnavailableError";
  }
}

export const isAgentKeyV2 = (token: string): boolean => token.startsWith(AGENT_KEY_V2_PREFIX);

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
  const token = AGENT_KEY_V2_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
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
  | { readonly ok: false; readonly reason: "invalid" | "unavailable" };

/**
 * One hash lookup. `allow` lists the states the caller accepts: ordinary routes take `active` only; rotate also takes
 * `renew_only`; confirm takes `pending` and `active`.
 */
export async function verifyBearer(
  store: CredentialStore,
  token: string,
  allow: readonly CredentialState[] = ["active"]
): Promise<VerifyResult> {
  if (!isAgentKeyV2(token) || token.length !== AGENT_KEY_V2_PREFIX.length + SECRET_CHARS) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const row = await store.lookup(await hashAgentKey(token));
    if (!row || !allow.includes(row.state)) return { ok: false, reason: "invalid" };
    return { ok: true, credentialId: row.credentialId, userId: row.userId, name: row.name, state: row.state };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type MintedKey =
  | { readonly ok: true; readonly credentialId: string; readonly userId: string; readonly apiKey: string; readonly pendingExpiresAt: string }
  | Extract<IssueResult, { ok: false }>;

/** A caller already authenticated with a v1 key for `userId`: mint a pending v2 key for the same user. */
export async function upgradeFromV1(
  store: CredentialStore,
  input: { userId: string; policy?: CredentialPolicy }
): Promise<MintedKey> {
  const { token, tokenHash } = await mintKey();
  const result = await store.issueUpgrade({ userId: input.userId, tokenHash, policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY });
  return result.ok ? { ...result, apiKey: token } : result;
}

/** A caller authenticated with `credentialId` (active or renew_only): mint its pending successor. Replay-safe: a repeat supersedes. */
export async function rotateCredential(
  store: CredentialStore,
  input: { credentialId: string; policy?: CredentialPolicy }
): Promise<MintedKey> {
  const { token, tokenHash } = await mintKey();
  const result = await store.issueSuccessor({
    predecessorId: input.credentialId,
    tokenHash,
    policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY,
  });
  return result.ok ? { ...result, apiKey: token } : result;
}

/** A caller authenticated WITH the pending key (that proves it stored the key): activate it, retire its predecessor. */
export function confirmCredential(
  store: CredentialStore,
  input: { credentialId: string; policy?: CredentialPolicy }
): Promise<ConfirmResult> {
  return store.confirm({ credentialId: input.credentialId, policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY });
}

export function revokeCredential(
  store: CredentialStore,
  input: { credentialId: string; userId: string; revokedBy: string }
): Promise<boolean> {
  return store.revoke({ ...input, reason: "revoked" });
}
