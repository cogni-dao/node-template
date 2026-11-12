// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client.
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. No decision lives here.
 *   Also the proof wiring (task.0091, task.0095): the node id, the allowlisted proof issues, the operator-backed comment verifier (the operator reads GitHub
 *   with its own App and signs the facts; this node holds no GitHub credential), and the per-IP limiters for anonymous challenges and for wrong secrets.
 *   No decision lives here.
 * Side-effects: none (the client is built lazily by the container); the per-client lookup limiter is in-memory; the verifier calls the operator
 * Links: packages/agent-grants/src/credentials
 * @internal
 */

import {
  agentRolesHasRoles,
  type CredentialSql,
  CredentialStoreUnavailableError,
  type CredentialStore,
  createPostgresCredentialStore,
  DEFAULT_PROOF_POLICY,
  parseIssueAllowlist,
  type ProofConfig,
  type ProofVerifier,
} from "@cogni/agent-grants/credentials";
import { createPinnedOperatorProofVerifier } from "@/app/_lib/auth/operator-proof-verifier";
import { resolveServiceDb } from "@/bootstrap/container";
import { credentialLookupLimiter, extractEdgeClientIp, TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import type { RequestContext } from "@/shared/observability";

let store: CredentialStore | undefined;

/** A missing or broken service connection is an outage (503), never a 500 or a 401. */
export function getAgentCredentialStore(): CredentialStore {
  try {
    // node-template's role read is `agent_roles` (the operator injects its OpenFGA read here instead).
    const client = resolveServiceDb().$client as unknown as CredentialSql;
    store ??= createPostgresCredentialStore(client, { hasRoles: agentRolesHasRoles(client) });
  } catch (cause) {
    throw new CredentialStoreUnavailableError(cause);
  }
  return store;
}

/**
 * Per-client admission for credential lookups (ADMIT_BEFORE_STORE, SPEND_ON_MISS). `admitCredentialLookup` only CHECKS the client's bucket: false = over
 * the limit, the caller answers 429 and reads nothing. `recordCredentialMiss` spends one token, and the caller invokes it only when the lookup found no
 * usable key. The client key is the Cloudflare-written `cf-connecting-ip` (see `extractEdgeClientIp` for the evidence).
 */
export function admitCredentialLookup(headers: { get(name: string): string | null }): boolean {
  return credentialLookupLimiter.hasTokens(extractEdgeClientIp({ headers }));
}

export function recordCredentialMiss(headers: { get(name: string): string | null }): void {
  credentialLookupLimiter.consume(extractEdgeClientIp({ headers }));
}


// ---------------------------------------------------------------------------------------------------------------------
// Proofs (task.0091)
// ---------------------------------------------------------------------------------------------------------------------

/** What the proof routes read each time: the node id, the allowlisted issues (lowercase `owner/repo#number`) and the default limits. */
export function getProofConfig(): ProofConfig {
  return {
    nodeId: getNodeId(),
    issues: parseIssueAllowlist(serverEnv().AGENT_PROOF_ISSUES),
    policy: DEFAULT_PROOF_POLICY,
  };
}

/**
 * The proof verifier of one request (task.0095): the OPERATOR reads the comment with its own GitHub App and signs the facts; this node holds no GitHub
 * credential and verifies the signature, the audience, the echoed nonce and the read time. No answer from the operator is `unavailable` (503
 * `proof_unavailable`, nothing consumed), in every environment. `ctx` gives the request id (sent as `x-request-id`) and the logger.
 */
export function getProofVerifier(ctx: Pick<RequestContext, "log" | "reqId">): ProofVerifier {
  return createPinnedOperatorProofVerifier({ nodeId: getNodeId(), reqId: ctx.reqId, log: ctx.log });
}

/** Anonymous challenge flood: 3 per client per hour (best effort, per instance; the node-wide cap is counted in the database). */
const anonymousChallengeLimiter = new TokenBucketRateLimiter({ maxTokens: 3, refillRate: 3 / 3600, burstSize: 0, maxKeys: 10_000 });

/** Spends one token; false = over the limit (429). */
export function admitAnonymousChallenge(headers: { get(name: string): string | null }): boolean {
  return anonymousChallengeLimiter.consume(extractEdgeClientIp({ headers }));
}

/** Wrong-secret flood on one challenge: 10 misses in 10 minutes per (challenge, client). A hit never spends. */
const proofMissLimiter = new TokenBucketRateLimiter({ maxTokens: 10, refillRate: 10 / 600, burstSize: 0, maxKeys: 10_000 });

/**
 * The rate limit of the PUBLIC proof routes (anonymous challenge, recover): their OWN bucket, keyed on Cloudflare's `cf-connecting-ip` like the credential
 * limiter. The shared public bucket is keyed on `x-real-ip`, which nothing writes on Akash, so there one client could lock every agent out of recovery.
 * 10 per minute + 5 burst per client. Spread into the route's `wrapPublicRoute` config.
 */
export const proofPublicRateLimit = {
  limiter: new TokenBucketRateLimiter({ maxTokens: 10, refillRate: 10 / 60, burstSize: 5, maxKeys: 10_000 }),
  clientKey: (request: { headers: { get(name: string): string | null } }): string => extractEdgeClientIp(request),
};

export function proofAttemptGuards(headers: { get(name: string): string | null }, challengeId: string): { admit: () => boolean; onInvalid: () => void } {
  const key = `${challengeId}\u0000${extractEdgeClientIp({ headers })}`;
  return { admit: () => proofMissLimiter.hasTokens(key), onInvalid: () => void proofMissLimiter.consume(key) };
}
