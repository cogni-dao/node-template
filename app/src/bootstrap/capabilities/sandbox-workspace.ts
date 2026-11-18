// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/sandbox-workspace`
 * Purpose: Factory for the sandbox shell capability (`core__sandbox_shell`) from server environment.
 * Scope: Resolves sandbox origin + token and binds each call to the calling run. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: SANDBOX_EXECD_TOKEN resolved from env, never passed through tool params.
 *   - DERIVED_HOST: origin = SANDBOX_BASE_URL override, else derived from APP_BASE_URL + node slug.
 *   - UNCONFIGURED_IS_NULL: missing token or underivable origin returns null (the tool answers `unavailable`), never a guess.
 *   - RUN_FROM_THE_SCOPE: the run id comes from the execution scope the tool guard binds, never from tool params.
 * Side-effects: none (factory only)
 * Links: src/adapters/server/sandbox-workspace/, services/sandbox/
 * @internal
 */

import type { SandboxShellCapability } from "@cogni/ai-tools";

import { getExecutionScope } from "@/adapters/server";
import {
  deriveIsolatedServiceOrigin,
  ExecdSandboxClient,
  SANDBOX_SERVICE_NAME,
  SandboxShell,
} from "@/adapters/server/sandbox-workspace";
import { getNodeName } from "@/shared/config";
import type { ServerEnv } from "@/shared/env";

/** Resolve the sandbox origin this node's app should call, or null when unknown. */
export function resolveSandboxWorkspaceOrigin(
  env: Pick<ServerEnv, "SANDBOX_BASE_URL" | "APP_BASE_URL">,
  nodeSlug: string
): string | null {
  if (env.SANDBOX_BASE_URL) return env.SANDBOX_BASE_URL;
  if (!env.APP_BASE_URL) return null;
  return deriveIsolatedServiceOrigin({
    appBaseUrl: env.APP_BASE_URL,
    nodeSlug,
    service: SANDBOX_SERVICE_NAME,
  });
}

/** Create the sandbox shell capability, or null when the token or origin is not configured. */
export function createSandboxShellCapability(
  env: ServerEnv
): SandboxShellCapability | null {
  const accessToken = env.SANDBOX_EXECD_TOKEN;
  if (!accessToken) return null;
  const baseUrl = resolveSandboxWorkspaceOrigin(env, getNodeName());
  if (!baseUrl) return null;
  const shell = new SandboxShell(new ExecdSandboxClient({ baseUrl, accessToken }));
  return {
    async run(params) {
      const { runId } = getExecutionScope();
      if (!runId) throw new Error("no run to give a folder");
      return shell.run({ runId, ...params });
    },
  };
}
