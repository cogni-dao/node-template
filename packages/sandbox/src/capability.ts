// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox/capability`
 * Purpose: The one factory a node calls to get the `core__sandbox_shell` capability.
 * Scope: Builds the execd client and shell from plain config. Reads no env and imports nothing from a node;
 *   the node passes the token, the origin, how to find the calling run, and where tick readings go.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: the token is config, never a call param.
 *   - RUN_FROM_THE_CALLER: the run id comes from `runId()`, which the node binds to its execution scope; the model never names a folder.
 *   - STRUCTURAL_CAPABILITY: the result satisfies `@cogni-dao/ai-tools` `SandboxShellCapability` without importing it.
 * Side-effects: none at construction (calls reach the sandbox lease)
 * Links: https://node-template.cognidao.org/knowledge/node-sandbox-design
 * @public
 */

import { ExecdSandboxClient } from "./execd-client";
import {
  SandboxShell,
  type SandboxShellParams,
  type SandboxShellResult,
  type SandboxTickReport,
} from "./sandbox-shell";

export interface SandboxShellCapabilityConfig {
  /** Sandbox origin, e.g. `https://node-template-sandbox.cognidao.org`. */
  readonly baseUrl: string;
  /** Shared execd access token (the node's SANDBOX_EXECD_TOKEN, at least 32 characters). */
  readonly accessToken: string;
  /** The calling run's UUID, or undefined outside a run. */
  readonly runId: () => string | undefined;
  /** Receives one report per cleanup tick (at most every 5 minutes, only while the tool is used). */
  readonly onTick?: (report: SandboxTickReport) => void;
  /**
   * Extra environment for each call, e.g. `{ GH_TOKEN }` from the operator push-token route. Optional: without it,
   * or when it fails, the call runs and only steps that need the value (git push) fail.
   */
  readonly callEnv?: () => Promise<Readonly<Record<string, string>>>;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface SandboxShellCapability {
  run(params: SandboxShellParams): Promise<SandboxShellResult>;
}

export function createSandboxShellCapability(
  config: SandboxShellCapabilityConfig
): SandboxShellCapability {
  const shell = new SandboxShell(
    new ExecdSandboxClient({
      baseUrl: config.baseUrl,
      accessToken: config.accessToken,
      ...(config.fetchImpl && { fetchImpl: config.fetchImpl }),
    }),
    config.onTick
  );
  return {
    async run(params) {
      const runId = config.runId();
      if (!runId) throw new Error("no run to give a folder");
      return shell.run({ runId, ...params, ...(config.callEnv && { env: config.callEnv }) });
    },
  };
}
