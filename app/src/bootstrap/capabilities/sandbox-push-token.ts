// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-push-token`
 * Purpose: Give each sandbox call a short-lived GH_TOKEN for this node's own repo, minted by this node's own GitHub App.
 * Scope: Mints locally with @octokit/auth-app from GH_AI_APP_ID + GH_AI_APP_PRIVATE_KEY_BASE64 and caches the token.
 *   No operator call. The App key stays in the app; only the 1-hour token reaches the sandbox.
 * Invariants:
 *   - ONE_REPO_OR_NOTHING: the App must be installed on exactly one repo; the token names that repo and only
 *     contents + pull_requests write. Any other install shape mints nothing.
 *   - WARN_NEVER_BLOCK: no key, or a failed mint, logs a warning and returns no env; the call still runs and only
 *     git push fails.
 *   - CACHE_UNTIL_NEAR_EXPIRY: one mint serves every call until 20 minutes before expiry, longer than any call (15 min).
 *   - BACK_OFF_ON_FAILURE: after a failed mint, calls skip minting for 60 seconds.
 *   - TOKEN_NEVER_LOGGED: logs carry the error code only.
 * Side-effects: IO (GitHub REST); logs `adapter.sandbox.push_token` on failure
 * Links: https://node-template.cognidao.org/knowledge/node-ai-git-push
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";

import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "SandboxPushToken" });
// Longer than the longest sandbox call (15 min), so a token never expires mid-call.
const REFRESH_BEFORE_MS = 20 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const PUSH_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

type CallEnv = Readonly<Record<string, string>>;

/** Returns the per-call env provider for the sandbox: `{ GH_TOKEN }` when a token is available, else `{}`. */
export function createSandboxPushTokenEnv(
  env: Pick<ServerEnv, "GH_AI_APP_ID" | "GH_AI_APP_PRIVATE_KEY_BASE64">,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): () => Promise<CallEnv> {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<CallEnv> | null = null;
  let failedAtMs = Number.NEGATIVE_INFINITY;
  let warnedUnset = false;

  const warn = (errorCode: string): CallEnv => {
    failedAtMs = now();
    logger.warn(
      { event: EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN, error_code: errorCode },
      EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN
    );
    return {};
  };

  const mint = async (): Promise<CallEnv> => {
    if (!env.GH_AI_APP_ID || !env.GH_AI_APP_PRIVATE_KEY_BASE64) {
      if (warnedUnset) return {};
      warnedUnset = true;
      return warn("no_app_key");
    }
    try {
      const auth = createAppAuth({
        appId: env.GH_AI_APP_ID,
        privateKey: Buffer.from(env.GH_AI_APP_PRIVATE_KEY_BASE64, "base64").toString("utf-8"),
      });
      const { token: jwt } = await auth({ type: "app" });
      const gh = async (path: string, token: string) =>
        fetchImpl(`https://api.github.com${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`github_${r.status}`))));

      const installs = (await gh("/app/installations", jwt)) as Array<{ id: number }>;
      const [install] = installs;
      if (installs.length !== 1 || !install) return warn("not_one_installation");
      const installationId = install.id;
      const probe = await auth({ type: "installation", installationId });
      const { repositories } = (await gh("/installation/repositories", probe.token)) as {
        repositories: Array<{ name: string }>;
      };
      const [repo] = repositories;
      if (repositories.length !== 1 || !repo) return warn("not_one_repo");

      const minted = await auth({
        type: "installation",
        installationId,
        repositoryNames: [repo.name],
        permissions: { ...PUSH_PERMISSIONS },
      });
      cached = { token: minted.token, expiresAtMs: Date.parse(minted.expiresAt) };
      return { GH_TOKEN: minted.token };
    } catch {
      return warn("mint_failed");
    }
  };

  return async () => {
    if (cached && cached.expiresAtMs - now() > REFRESH_BEFORE_MS) {
      return { GH_TOKEN: cached.token };
    }
    if (now() - failedAtMs < FAILURE_BACKOFF_MS) return {};
    inFlight ??= mint().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
