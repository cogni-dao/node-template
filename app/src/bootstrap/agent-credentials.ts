// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/agent-credentials`
 * Purpose: This node's wiring of the `@cogni-dao/agent-grants/credentials` store: the service-role postgres.js client.
 * Scope: Composition only. `agent_credentials` is deny-all for the app role (FORCE RLS, no policy), so the store gets the
 *   BYPASSRLS service connection. No decision lives here.
 *   Also the proof wiring (task.0091): the node id and the allowlisted proof issues, the GitHub comment verifier with an installation-token provider
 *   (the review App's `issues: read` token, in memory only; a personal access token is never used), and the per-IP limiters for anonymous challenges
 *   and for wrong secrets. No decision lives here.
 * Side-effects: none (the client is built lazily by the container); the per-client lookup limiter is in-memory; the verifier reads GitHub
 * Links: packages/agent-grants/src/credentials
 * @internal
 */

import {
  agentRolesHasRoles,
  type CredentialSql,
  CredentialStoreUnavailableError,
  type CredentialStore,
  createGithubCommentVerifier,
  createPostgresCredentialStore,
  DEFAULT_PROOF_POLICY,
  parseIssueAllowlist,
  parseIssueRef,
  type ProofConfig,
  type ProofVerifier,
} from "@cogni/agent-grants/credentials";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { credentialLookupLimiter, extractEdgeClientIp, TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server-env";
import { EVENT_NAMES } from "@/shared/observability";

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

/** The GitHub App credentials of this node, or null. A GitHub read with a token has the 5000-per-hour budget; without one, GitHub allows 60 per hour per IP. */
function appCredentials(): { appId: string; privateKey: string } | null {
  const env = serverEnv();
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) return null;
  return { appId: env.GH_REVIEW_APP_ID, privateKey: Buffer.from(env.GH_REVIEW_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8") };
}

/** Production fails closed: no App token means `proof_unavailable`. A non-production node may read unauthenticated (30 reads per hour). */
const requireToken = (): boolean => {
  const env = serverEnv().DEPLOY_ENVIRONMENT;
  return env === undefined || env === "production";
};

/** What the proof routes read each time: the node id, the allowlisted issues and the limits (smaller GitHub budget with no App token). */
export function getProofConfig(): ProofConfig {
  return {
    nodeId: getNodeId(),
    issues: parseIssueAllowlist(serverEnv().AGENT_PROOF_ISSUES),
    policy: { ...DEFAULT_PROOF_POLICY, fetchBudgetPerHour: appCredentials() ? DEFAULT_PROOF_POLICY.fetchBudgetPerHour : 30 },
  };
}

let tokenCache: { token: string; expiresAt: number } | undefined;

/** An installation token cut to `issues: read`, cached in memory only until 5 minutes before it ends. Null when this node holds no App credentials. */
async function installationToken(): Promise<string | null> {
  const app = appCredentials();
  if (!app) return null;
  if (tokenCache && tokenCache.expiresAt - Date.now() > 5 * 60_000) return tokenCache.token;
  const first = parseIssueRef(parseIssueAllowlist(serverEnv().AGENT_PROOF_ISSUES)[0] ?? "");
  if (!first) return null;
  const [{ createAppAuth }, { Octokit }] = await Promise.all([import("@octokit/auth-app"), import("@octokit/core")]);
  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: app.appId, privateKey: app.privateKey } });
  const installation = await octokit.request("GET /repos/{owner}/{repo}/installation", { owner: first.owner, repo: first.repo });
  const auth = (await octokit.auth({
    type: "installation",
    installationId: installation.data.id,
    permissions: { issues: "read" },
  })) as { token: string; expiresAt?: string };
  tokenCache = { token: auth.token, expiresAt: auth.expiresAt ? Date.parse(auth.expiresAt) : Date.now() + 30 * 60_000 };
  return auth.token;
}

/** `fetch` that logs ONE `agent.proof.github_failed` line when GitHub does not answer 2xx (status and duration only: never a body, header or token). */
const loggedFetch: typeof fetch = async (input, init) => {
  const started = Date.now();
  try {
    const res = await fetch(input, init);
    if (!res.ok && res.status !== 404) logGithubFailure(`http_${res.status}`, res.status, Date.now() - started);
    return res;
  } catch (error) {
    logGithubFailure(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network", 0, Date.now() - started);
    throw error;
  }
};

function logGithubFailure(reasonCode: string, status: number, durationMs: number): void {
  getContainer().log.warn({ event: EVENT_NAMES.AGENT_PROOF_GITHUB_FAILED, dep: "github", reasonCode, status, durationMs }, EVENT_NAMES.AGENT_PROOF_GITHUB_FAILED);
}

let verifier: ProofVerifier | undefined;

export function getProofVerifier(): ProofVerifier {
  verifier ??= createGithubCommentVerifier({
    fetch: loggedFetch,
    getToken: async () => {
      try {
        return await installationToken();
      } catch (error) {
        logGithubFailure(error instanceof Error ? error.name : "token", 0, 0);
        throw error;
      }
    },
    requireToken: requireToken(),
  });
  return verifier;
}

/** Anonymous challenge flood: 3 per client per hour (best effort, per instance; the node-wide cap is counted in the database). */
const anonymousChallengeLimiter = new TokenBucketRateLimiter({ maxTokens: 3, refillRate: 3 / 3600, burstSize: 0, maxKeys: 10_000 });

/** Spends one token; false = over the limit (429). */
export function admitAnonymousChallenge(headers: { get(name: string): string | null }): boolean {
  return anonymousChallengeLimiter.consume(extractEdgeClientIp({ headers }));
}

/** Wrong-secret flood on one challenge: 10 misses in 10 minutes per (challenge, client). A hit never spends. */
const proofMissLimiter = new TokenBucketRateLimiter({ maxTokens: 10, refillRate: 10 / 600, burstSize: 0, maxKeys: 10_000 });

export function proofAttemptGuards(headers: { get(name: string): string | null }, challengeId: string): { admit: () => boolean; onInvalid: () => void } {
  const key = `${challengeId}\u0000${extractEdgeClientIp({ headers })}`;
  return { admit: () => proofMissLimiter.hasTokens(key), onInvalid: () => void proofMissLimiter.consume(key) };
}
