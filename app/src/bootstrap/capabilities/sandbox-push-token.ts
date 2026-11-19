// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-push-token`
 * Purpose: Give each sandbox call a 1-hour GH_TOKEN for this node's own repo, through one port with two adapters.
 * Scope: Fleet adapter: asks the operator's POST /api/v1/vcs/push-token with the node AI's operator key; the operator
 *   mints from the fleet dev App. Sovereign adapter: mints locally from the node's own GitHub App. Caches the token.
 *   No GitHub key ever reaches the sandbox; only the minted token does.
 * Invariants:
 *   - ONE_REPO_ONLY: every token names one repo and only contents + pull_requests write (the operator enforces it for
 *     the fleet; the sovereign adapter mints only when its App has exactly one installation with exactly one repo).
 *   - SOVEREIGN_WINS: when the node holds its own App key, it never calls the operator.
 *   - WARN_NEVER_BLOCK: no key, or a failed mint, logs a warning and returns no env; the call still runs and only
 *     git push fails.
 *   - CACHE_UNTIL_NEAR_EXPIRY: one mint serves every call until 20 minutes before expiry, longer than any call (15 min).
 *   - BACK_OFF_ON_FAILURE: after a failed mint, calls skip minting for 60 seconds and keep any unexpired cached token.
 *   - TOKEN_NEVER_LOGGED: logs carry the adapter and error code only.
 * Side-effects: IO (HTTPS to the operator or GitHub); logs `adapter.sandbox.push_token` on failure
 * Links: https://node-template.cognidao.org/knowledge/node-ai-push-token
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";

import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "SandboxPushToken" });
// Longer than the longest sandbox call (15 min), so a token never expires mid-call.
const REFRESH_BEFORE_MS = 20 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const MINT_TIMEOUT_MS = 15_000;
const PUSH_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

type CallEnv = Readonly<Record<string, string>>;
type Minted = { token: string; expiresAt: string };
/** One mint attempt: a token, or the error code to log. */
type Mint = () => Promise<Minted | { errorCode: string }>;

export type PushTokenEnv = Pick<
  ServerEnv,
  "GH_AI_APP_ID" | "GH_AI_APP_PRIVATE_KEY_BASE64" | "NODE_AI_OPERATOR_KEY" | "COGNI_OPERATOR_URL"
>;

/** Returns the per-call env provider for the sandbox: `{ GH_TOKEN }` when a token is available, else `{}`. */
export function createSandboxPushTokenEnv(
  env: PushTokenEnv,
  nodeSlug: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): () => Promise<CallEnv> {
  const adapter = selectAdapter(env, nodeSlug, fetchImpl);
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<CallEnv> | null = null;
  let failedAtMs = Number.NEGATIVE_INFINITY;
  let warnedUnset = false;

  const warn = (errorCode: string): CallEnv => {
    failedAtMs = now();
    logger.warn(
      { event: EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN, adapter: adapter?.name ?? "none", error_code: errorCode },
      EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN
    );
    return stillValid();
  };
  // A failed refresh keeps handing out the cached token while it has not expired.
  const stillValid = (): CallEnv => (cached && cached.expiresAtMs > now() ? { GH_TOKEN: cached.token } : {});

  const refresh = async (): Promise<CallEnv> => {
    if (!adapter) {
      if (warnedUnset) return {};
      warnedUnset = true;
      return warn("no_push_credential");
    }
    try {
      const result = await adapter.mint();
      if ("errorCode" in result) return warn(result.errorCode);
      const expiresAtMs = Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAtMs)) return warn("bad_expiry");
      cached = { token: result.token, expiresAtMs };
      return { GH_TOKEN: result.token };
    } catch {
      return warn("mint_failed");
    }
  };

  return async () => {
    if (cached && cached.expiresAtMs - now() > REFRESH_BEFORE_MS) {
      return { GH_TOKEN: cached.token };
    }
    if (now() - failedAtMs < FAILURE_BACKOFF_MS) return stillValid();
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

function selectAdapter(
  env: PushTokenEnv,
  nodeSlug: string,
  fetchImpl: typeof fetch
): { name: "sovereign" | "fleet"; mint: Mint } | null {
  if (env.GH_AI_APP_ID && env.GH_AI_APP_PRIVATE_KEY_BASE64) {
    return { name: "sovereign", mint: sovereignMint(env.GH_AI_APP_ID, env.GH_AI_APP_PRIVATE_KEY_BASE64, fetchImpl) };
  }
  if (env.NODE_AI_OPERATOR_KEY && env.COGNI_OPERATOR_URL) {
    return { name: "fleet", mint: fleetMint(env.COGNI_OPERATOR_URL, env.NODE_AI_OPERATOR_KEY, nodeSlug, fetchImpl) };
  }
  return null;
}

/** Fleet: the operator mints from the fleet dev App after checking this principal may push to this node. */
function fleetMint(operatorUrl: string, apiKey: string, nodeSlug: string, fetchImpl: typeof fetch): Mint {
  return async () => {
    const res = await fetchImpl(`${operatorUrl}/api/v1/vcs/push-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ nodeId: nodeSlug }),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<Minted> & { errorCode?: string };
    if (!res.ok || !body.token || !body.expiresAt) {
      return { errorCode: body.errorCode ?? `operator_${res.status}` };
    }
    return { token: body.token, expiresAt: body.expiresAt };
  };
}

/** Sovereign: the node's own App, installed on exactly one repo, mints locally. */
function sovereignMint(appId: string, keyBase64: string, fetchImpl: typeof fetch): Mint {
  const auth = createAppAuth({
    appId,
    privateKey: Buffer.from(keyBase64, "base64").toString("utf-8"),
  });
  const gh = async (path: string, token: string): Promise<unknown> => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github_${res.status}`);
    return res.json();
  };
  return async () => {
    const { token: jwt } = await auth({ type: "app" });
    const installs = (await gh("/app/installations", jwt)) as Array<{ id: number }>;
    const [install] = installs;
    if (installs.length !== 1 || !install) return { errorCode: "not_one_installation" };
    const listing = await auth({ type: "installation", installationId: install.id, permissions: { metadata: "read" } });
    const { repositories } = (await gh("/installation/repositories", listing.token)) as {
      repositories: Array<{ name: string }>;
    };
    const [repo] = repositories;
    if (repositories.length !== 1 || !repo) return { errorCode: "not_one_repo" };
    const minted = await auth({
      type: "installation",
      installationId: install.id,
      repositoryNames: [repo.name],
      permissions: { ...PUSH_PERMISSIONS },
      // auth-app caches installation tokens for 59 min; refresh so a re-mint is truly fresh.
      refresh: true,
    });
    return { token: minted.token, expiresAt: minted.expiresAt };
  };
}
