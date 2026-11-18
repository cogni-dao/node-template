// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-push-token`
 * Purpose: Give each sandbox call a short-lived GH_TOKEN for this node's own repo, minted by the operator GitHub App.
 * Scope: Calls the operator's POST /api/v1/vcs/push-token with this node AI's operator key and caches the token.
 *   Holds no GitHub credential of its own; the private key stays on the operator.
 * Invariants:
 *   - WARN_NEVER_BLOCK: no key, or a failed mint, logs a warning and returns no env; the call still runs and only
 *     git push fails.
 *   - CACHE_UNTIL_NEAR_EXPIRY: one mint serves every call until 10 minutes before the token expires.
 *   - BACK_OFF_ON_FAILURE: after a failed mint, calls skip minting for 60 seconds, so an operator outage
 *     never adds the mint timeout to every call.
 *   - TOKEN_NEVER_LOGGED: logs carry the status and error code only.
 * Side-effects: IO (HTTPS to the operator); logs `adapter.sandbox.push_token` on failure
 * Links: https://node-template.cognidao.org/knowledge/node-ai-github-apps
 * @internal
 */

import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "SandboxPushToken" });
const REFRESH_BEFORE_MS = 10 * 60_000;
const MINT_TIMEOUT_MS = 15_000;
const FAILURE_BACKOFF_MS = 60_000;

/** Returns the per-call env provider for the sandbox: `{ GH_TOKEN }` when a token is available, else `{}`. */
export function createSandboxPushTokenEnv(
  env: Pick<ServerEnv, "COGNI_OPERATOR_NODE_API_KEY" | "COGNI_OPERATOR_URL">,
  nodeSlug: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): () => Promise<Readonly<Record<string, string>>> {
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<Readonly<Record<string, string>>> | null = null;
  let warnedNoKey = false;
  let failedAtMs = Number.NEGATIVE_INFINITY;

  const mint = async (): Promise<Readonly<Record<string, string>>> => {
    const apiKey = env.COGNI_OPERATOR_NODE_API_KEY;
    if (!apiKey || !env.COGNI_OPERATOR_URL) {
      if (!warnedNoKey) {
        warnedNoKey = true;
        logger.warn(
          { event: EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN, error_code: "no_operator_key" },
          EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN
        );
      }
      return {};
    }
    try {
      const res = await fetchImpl(`${env.COGNI_OPERATOR_URL}/api/v1/vcs/push-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ nodeId: nodeSlug }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        expiresAt?: string;
        errorCode?: string;
      };
      if (!res.ok || !body.token || !body.expiresAt) {
        logger.warn(
          {
            event: EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN,
            status: res.status,
            error_code: body.errorCode ?? "mint_failed",
          },
          EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN
        );
        failedAtMs = now();
        return {};
      }
      cached = { token: body.token, expiresAtMs: Date.parse(body.expiresAt) };
      return { GH_TOKEN: body.token };
    } catch {
      logger.warn(
        { event: EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN, error_code: "transport_error" },
        EVENT_NAMES.ADAPTER_SANDBOX_PUSH_TOKEN
      );
      failedAtMs = now();
      return {};
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
