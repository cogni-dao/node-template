// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox` push-token
 * Purpose: Give each sandbox call a 1-hour GH_TOKEN for the node's own repo (hub node-ai-push-token).
 * Scope: Asks the operator's POST /api/v1/vcs/push-token with the node AI's operator key (role developer); the operator mints from its App,
 *   narrowed to this repo and contents + pull_requests write. Caches the token. The node passes the result as `callEnv` to
 *   `createSandboxShellCapability`. Leaf: reads no env, imports no logger; the node passes values and an `onWarn` callback.
 * Invariants:
 *   - ONE_REPO_ONLY: the operator narrows every token to this node's repo and contents + pull_requests write.
 *   - WARN_NEVER_BLOCK: no key, or a failed mint, calls `onWarn` and returns no env; the call still runs and only git push fails.
 *   - CACHE_UNTIL_NEAR_EXPIRY: one mint serves every call until 20 minutes before expiry, longer than any call (15 min).
 *   - BACK_OFF_ON_FAILURE: after a failed mint, calls skip minting for 60 seconds and keep any unexpired cached token.
 *   - TOKEN_NEVER_REPORTED: `onWarn` carries the adapter and error code only.
 *   - EVENT_NAMES_HERE: the node's event registry repeats `SANDBOX_PUSH_TOKEN_EVENT` as this value; a parity test pins it.
 * Side-effects: IO (HTTPS to the operator)
 * Links: https://node-template.cognidao.org/knowledge/node-ai-push-token
 * @public
 */

/** The event name a node logs a failed or missing mint under. */
export const SANDBOX_PUSH_TOKEN_EVENT = "adapter.sandbox.push_token" as const;

// Longer than the longest sandbox call (15 min), so a token never expires mid-call.
const REFRESH_BEFORE_MS = 20 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const MINT_TIMEOUT_MS = 15_000;

export type SandboxCallEnv = Readonly<Record<string, string>>;
type CallEnv = SandboxCallEnv;
type Minted = { token: string; expiresAt: string };
/** One mint attempt: a token, or the error code to log. */
type Mint = () => Promise<Minted | { errorCode: string }>;

export interface SandboxPushTokenConfig {
  /** The node AI's operator principal key (`NODE_AI_OPERATOR_KEY`); absent means no token. */
  readonly operatorKey?: string | undefined;
  /** The operator's origin (`COGNI_OPERATOR_URL`); absent means no token. */
  readonly operatorUrl?: string | undefined;
  readonly nodeSlug: string;
  /** Called on a missing key or a failed mint. Carries the adapter name and an error code, never a token. */
  readonly onWarn: (report: { readonly adapter: string; readonly errorCode: string }) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Returns the per-call env provider for the sandbox: `{ GH_TOKEN }` when a token is available, else `{}`. */
export function createSandboxPushTokenEnv(config: SandboxPushTokenConfig): () => Promise<CallEnv> {
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const adapter = selectAdapter(config, fetchImpl);
  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<CallEnv> | null = null;
  let failedAtMs = Number.NEGATIVE_INFINITY;
  let warnedUnset = false;

  const warn = (errorCode: string): CallEnv => {
    failedAtMs = now();
    config.onWarn({ adapter: adapter?.name ?? "none", errorCode });
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
  config: SandboxPushTokenConfig,
  fetchImpl: typeof fetch
): { name: "operator"; mint: Mint } | null {
  if (!config.operatorKey || !config.operatorUrl) return null;
  return {
    name: "operator",
    mint: operatorMint(config.operatorUrl.replace(/\/+$/, ""), config.operatorKey, config.nodeSlug, fetchImpl),
  };
}

/** The operator mints from its App after checking this principal is a developer on this node. */
function operatorMint(operatorUrl: string, apiKey: string, nodeSlug: string, fetchImpl: typeof fetch): Mint {
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
