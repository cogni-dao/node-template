// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` spawn grants
 * Purpose: An agent is linked to the person who made it. A signed-in person issues a one-time, short-lived spawn grant; the agent redeems it
 *   at registration for its first key; the agent's principal row stores that person as its owner. The owner lists and revokes the agents they own.
 * Scope: Grant format, hashing, and the decisions over a `SpawnStore` port. No HTTP, no env, no session. The node's routes authenticate the person;
 *   this file never learns who is signed in except as a `userId` string the route hands it.
 * Invariants:
 *   - TOKEN_HASH_ONLY: a grant is 32 random bytes from the CSPRNG, shown once to the issuer, stored only as sha256. It is derivable from nothing.
 *   - ONE_USE: a redeemed grant is refused (`already_redeemed`) unless it is an idempotent retry (below).
 *   - IDEMPOTENT_RETRY: a retry of the SAME redeem (same grant, same name) before the agent confirmed its first key supersedes the earlier
 *     unconfirmed key with a fresh pending key for the same agent. It creates no second agent. After the first confirm, the grant is spent.
 *   - REVOKE_IS_FINAL: an owner revoke ends the agent for good. Once any key of the agent was revoked for a reason other than `superseded`
 *     (for example `owner_revoked`), the grant is spent even if the agent never confirmed a key: no retry makes a new key for it.
 *   - SHORT_LIVED: a grant lives `SPAWN_GRANT_TTL_SEC` (24 h), read against the DATABASE clock. An expired grant is refused, retry included.
 *   - CAPPED: at most `MAX_PENDING_SPAWN_GRANTS` (5) pending grants per person. The cap and the insert run in one transaction.
 *   - OWNER_IS_THE_ISSUER: the redeemed agent's `owner_user_id` is the grant's issuer. The agent cannot choose it, and cannot name any other owner.
 *   - OWNER_SEES_ONLY_OWN: `listOwnedAgents` and `revokeOwnedAgentKeys` answer for agents whose owner is the caller and no others. Another
 *     person's agent, an ownerless agent and an unknown id are the same answer (`not_found`).
 *   - ANONYMOUS_STAYS_OWNERLESS: the node's anonymous door never calls redeem; those agents have no owner and this file never gives them one.
 *   - CLAIM_KEEPS_THE_IDENTITY (no human-carried secret): an EXISTING ownerless agent starts a claim with its OWN key and gets a claim id (15 min, single use, bound to that
 *     agent). The signed-in person opens the claim link (their profile, `?claim=<id>`) and clicks Claim: ONE guarded write sets `owner_user_id` on that same principal, only where it is NULL (ONE_IDENTITY, history kept).
 *     The owner is the person who clicked, never a value the agent names. An agent cannot own itself or own another agent; a person owns at most `MAX_OWNED_AGENTS` agents (a spawn grant counts too).
 *   - STORE_OUTAGE_IS_NOT_A_REFUSAL: every store failure surfaces as `CredentialStoreUnavailableError` (503).
 * Side-effects: none (the store does the IO)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard (package row 2), https://cognidao.org/work/items/task.5474
 * @public
 */

import { formatRevocableKey } from "./key-format";
import { CredentialStoreUnavailableError, hashAgentKey } from "./service";
import { type CredentialPolicy, type CredentialStore, DEFAULT_CREDENTIAL_POLICY } from "./types";

export const SPAWN_GRANT_PREFIX = "cogni_sg_v1_";
const BODY_LENGTH = 43;

const SHAPE = new RegExp(`^${SPAWN_GRANT_PREFIX}[A-Za-z0-9_-]{${BODY_LENGTH}}$`);

/** A grant lives 24 hours. */
export const SPAWN_GRANT_TTL_SEC = 24 * 3600;
/** A person holds at most this many unredeemed, unexpired grants. */
export const MAX_PENDING_SPAWN_GRANTS = 5;

/** Shape only. A token that fails is refused before any store read. */
export const isWellFormedSpawnGrant = (token: string): boolean => SHAPE.test(token);

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The key a redeemed grant returns is a revocable key like any other, built by the format owner (`key-format.ts`). */
async function mintKeyForGrant(): Promise<{ token: string; tokenHash: string }> {
  const token = formatRevocableKey(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  return { token, tokenHash: await hashAgentKey(token) };
}

async function mintGrant(): Promise<{ token: string; tokenHash: string }> {
  const token = `${SPAWN_GRANT_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { token, tokenHash: await hashAgentKey(token) };
}

export type IssueGrantResult =
  | { readonly ok: true; readonly grant: string; readonly expiresAt: string; readonly pending: number }
  | { readonly ok: false; readonly reason: "too_many_pending" | "unknown_user" | "agent_issuer" };

/** The state of a grant as the redeemer sees it, read before the atomic redeem. */
export type GrantState =
  | { readonly state: "unknown" }
  | { readonly state: "expired" }
  | { readonly state: "open" }
  | {
      readonly state: "redeemed";
      /** The agent the grant made. */
      readonly userId: string;
      readonly name: string | null;
      /** True while that agent has never confirmed a key AND no key of it was ended by a revoke (only a `superseded` key is not one): a retry is still allowed. */
      readonly unconfirmed: boolean;
    };

export type RedeemRefusal = "unknown" | "expired" | "already_redeemed" | "too_many_agents";

/** Agents one person may own. A spawn grant and a claim past this are refused. */
export const MAX_OWNED_AGENTS = 25;
/** A claim lives 15 minutes. */
export const CLAIM_TTL_SEC = 15 * 60;

export type StartClaimResult =
  | { readonly ok: true; readonly claimId: string; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "already_owned" | "not_an_agent" };

/** What the claim row on the profile shows the person: the agent by name and whether the claim can still be used. */
export interface ClaimView {
  readonly claimId: string;
  readonly agentName: string | null;
  readonly state: "open" | "claimed" | "expired" | "owned";
  readonly expiresAt: string;
}

export type CompleteClaimResult =
  | { readonly ok: true; readonly agentUserId: string }
  | { readonly ok: false; readonly reason: "unknown" | "expired" | "used" | "already_owned" | "owner_is_agent" | "too_many_agents" };

export type RedeemResult =
  | {
      readonly ok: true;
      /** The agent's `users.id`. */
      readonly userId: string;
      /** The person who issued the grant. */
      readonly ownerUserId: string;
      readonly credentialId: string;
      readonly pendingExpiresAt: string;
      /** True when this call superseded an earlier unconfirmed key of the same agent (an idempotent retry). */
      readonly retry: boolean;
    }
  | { readonly ok: false; readonly reason: RedeemRefusal };

/** An agent the signed-in person owns, as the profile lists it. No key, hash or token. */
export interface OwnedAgent {
  /** The agent's `users.id`: the handle the owner's revoke call names. */
  readonly agentUserId: string;
  readonly name: string;
  readonly createdAt: string;
  /** active: a usable key exists. pending: made, not yet confirmed. expired: keys lapsed. revoked: every key ended. none: no key rows. */
  readonly keyState: "active" | "pending" | "expired" | "revoked" | "none";
}

/**
 * Persistence port. Every method is one atomic unit; the Postgres adapter runs each in one transaction. Expiry, the cap and ordering use the
 * database clock, never the app's.
 */
export interface SpawnStore {
  /** Insert a grant for `issuerUserId` unless they hold `maxPending` pending grants already. Refuses an issuer that is an agent principal. */
  issue(input: { issuerUserId: string; tokenHash: string; ttlSec: number; maxPending: number }): Promise<
    { readonly ok: true; readonly expiresAt: string; readonly pending: number } | { readonly ok: false; readonly reason: "too_many_pending" | "unknown_user" | "agent_issuer" }
  >;
  /** What the grant is now. Never cached. */
  grantState(tokenHash: string): Promise<GrantState>;
  /**
   * The atomic redeem, under a row lock on the grant. Open: create the agent's user (`name`), its `external` principal owned by the issuer and a
   * pending `spawn_grant` key, and mark the grant redeemed. Redeemed: only a live, same-name retry of an agent that never confirmed a key passes, and
   * it supersedes the unconfirmed key. Anything else is refused.
   */
  redeem(input: { tokenHash: string; name: string; newUserId: string; keyHash: string; policy: CredentialPolicy }): Promise<RedeemResult>;
  /**
   * An existing agent starts a claim (no secret leaves it). Refuses an agent that already has an owner, an internal AI, and a user that holds a wallet. A new claim
   * ends the agent's earlier open claim, so at most one is live.
   */
  startClaim(input: { agentUserId: string; ttlSec: number }): Promise<StartClaimResult>;
  /** One claim by id, or null (unknown or malformed). */
  getClaim(claimId: string): Promise<ClaimView | null>;
  /**
   * The person clicks Claim. Under a row lock on the claim: open, unexpired, unused; the person is not an agent and not the agent; the person owns fewer than `maxOwned` agents; then
   * ONE guarded write sets the agent's `owner_user_id` only where it is NULL, and the claim is marked used by that person. Anything else changes nothing.
   */
  completeClaim(input: { claimId: string; ownerUserId: string; maxOwned: number }): Promise<CompleteClaimResult>;
  /** The agents this person owns, newest first. Bounded. */
  listOwned(ownerUserId: string): Promise<OwnedAgent[]>;
  /** How many unredeemed, unexpired grants this person holds. */
  countPending(issuerUserId: string): Promise<number>;
  /** The ids of the agent's keys that are not revoked, or null when `ownerUserId` does not own `agentUserId`. */
  liveKeyIds(input: { ownerUserId: string; agentUserId: string }): Promise<string[] | null>;
}

/** Run a store call; any failure becomes `CredentialStoreUnavailableError`. */
async function viaStore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
}

/** A signed-in person asks for a grant. The returned `grant` is the only copy: show it once. */
export async function issueSpawnGrant(store: SpawnStore, input: { issuerUserId: string }): Promise<IssueGrantResult> {
  const { token, tokenHash } = await mintGrant();
  const result = await viaStore(() =>
    store.issue({ issuerUserId: input.issuerUserId, tokenHash, ttlSec: SPAWN_GRANT_TTL_SEC, maxPending: MAX_PENDING_SPAWN_GRANTS })
  );
  return result.ok ? { ok: true, grant: token, expiresAt: result.expiresAt, pending: result.pending } : result;
}

export type SpawnRedeemResult =
  | (Extract<RedeemResult, { ok: true }> & { readonly apiKey: string })
  | { readonly ok: false; readonly reason: RedeemRefusal | "name_taken" };

/**
 * The agent redeems a grant with the name it picked. `name` is already trimmed and collapsed by the node. `nameTaken` is the node's collision check
 * (an existing user, or one of this node's AI); it runs only for a NEW agent, never for an idempotent retry of the agent the grant already made.
 * `newUserId` is the id the new agent gets (the node generates it; a retry ignores it).
 */
export async function redeemSpawnGrant(
  store: SpawnStore,
  input: {
    grant: string;
    name: string;
    newUserId: string;
    nameTaken: (name: string) => Promise<boolean>;
    policy?: CredentialPolicy;
  }
): Promise<SpawnRedeemResult> {
  if (!isWellFormedSpawnGrant(input.grant)) return { ok: false, reason: "unknown" };
  const tokenHash = await hashAgentKey(input.grant);
  const state = await viaStore(() => store.grantState(tokenHash));
  switch (state.state) {
    case "unknown":
    case "expired":
      return { ok: false, reason: state.state };
    case "redeemed":
      // Only an unconfirmed agent with the same name may retry. The atomic redeem re-checks all of it.
      if (!state.unconfirmed || state.name !== input.name) return { ok: false, reason: "already_redeemed" };
      break;
    case "open":
      if (await viaStore(() => input.nameTaken(input.name))) return { ok: false, reason: "name_taken" };
      break;
  }
  const { token: apiKey, tokenHash: keyHash } = await mintKeyForGrant();
  const result = await viaStore(() =>
    store.redeem({ tokenHash, name: input.name, newUserId: input.newUserId, keyHash, policy: input.policy ?? DEFAULT_CREDENTIAL_POLICY })
  );
  return result.ok ? { ...result, apiKey } : result;
}

/** An existing agent starts a claim with its own key. The returned `claimId` is the path of the page the person opens. */
export function startAgentClaim(store: SpawnStore, input: { agentUserId: string }): Promise<StartClaimResult> {
  return viaStore(() => store.startClaim({ agentUserId: input.agentUserId, ttlSec: CLAIM_TTL_SEC }));
}

/** The claim as the page shows it. Null when unknown. */
export function readAgentClaim(store: SpawnStore, input: { claimId: string }): Promise<ClaimView | null> {
  return viaStore(() => store.getClaim(input.claimId));
}

/** The person clicks Claim. `ownerUserId` is the signed-in person, from the session: never from the request body. */
export function completeAgentClaim(store: SpawnStore, input: { claimId: string; ownerUserId: string }): Promise<CompleteClaimResult> {
  return viaStore(() => store.completeClaim({ claimId: input.claimId, ownerUserId: input.ownerUserId, maxOwned: MAX_OWNED_AGENTS }));
}

/** The agents `ownerUserId` owns. */
export function listOwnedAgents(store: SpawnStore, input: { ownerUserId: string }): Promise<OwnedAgent[]> {
  return viaStore(() => store.listOwned(input.ownerUserId));
}

/** How many grants this person may still issue right now. */
export async function spawnGrantsLeft(store: SpawnStore, input: { issuerUserId: string }): Promise<number> {
  const pending = await viaStore(() => store.countPending(input.issuerUserId));
  return Math.max(0, MAX_PENDING_SPAWN_GRANTS - pending);
}

/**
 * The owner ends every live key of an agent they own, through the credential store's own `revoke` (so a pending successor dies with its key).
 * `not_found` when `ownerUserId` does not own `agentUserId`: another person's agent, an ownerless agent and an unknown id look the same.
 */
export async function revokeOwnedAgentKeys(
  spawn: SpawnStore,
  credentials: CredentialStore,
  input: { ownerUserId: string; agentUserId: string }
): Promise<{ readonly ok: true; readonly revoked: number } | { readonly ok: false; readonly reason: "not_found" }> {
  const ids = await viaStore(() => spawn.liveKeyIds(input));
  if (ids === null) return { ok: false, reason: "not_found" };
  let revoked = 0;
  for (const credentialId of ids) {
    const done = await viaStore(() =>
      credentials.revoke({ credentialId, userId: input.agentUserId, reason: "owner_revoked", revokedBy: input.ownerUserId })
    );
    if (done) revoked += 1;
  }
  return { ok: true, revoked };
}
