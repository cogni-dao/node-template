// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/sandbox`
 * Purpose: Sandbox shell capability interface for AI tool execution.
 * Scope: Defines SandboxShellCapability: run one command in the current run's sandbox folder. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: the capability resolves the sandbox origin and token, never through tool params.
 *   - RUN_FROM_THE_RUN: the capability knows which run is calling; the model never names a folder.
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/node-sandbox-design
 * @public
 */

/** One command for the calling run's sandbox folder. */
export interface SandboxShellParams {
  /** Shell text; may be a multi-line script. */
  readonly command: string;
  /** Call limit in milliseconds; the capability rejects values outside 1000..900000. */
  readonly timeoutMs: number;
}

/** `none` = exit 0; `nonzero_exit` = the command failed; `timeout` = the call ran to its limit. */
export type SandboxShellErrorCode = "none" | "nonzero_exit" | "timeout";

/** Result of one command: stdout and stderr merged in arrival order, head and tail kept when long. */
export interface SandboxShellResult {
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly errorCode: SandboxShellErrorCode;
}

/** Runs one command in the calling run's sandbox folder. A transport failure throws. */
export interface SandboxShellCapability {
  run(params: SandboxShellParams): Promise<SandboxShellResult>;
}
