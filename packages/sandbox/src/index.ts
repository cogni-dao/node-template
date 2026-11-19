// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox`
 * Purpose: Public entry: the node sandbox mechanism (execd client, call wrapper, per-run queue, cleanup tick).
 * Scope: Exports only; no implementation logic.
 * Side-effects: none
 * @public
 */

export {
  createSandboxShellCapability,
  type SandboxShellCapability,
  type SandboxShellCapabilityConfig,
} from "./capability";
export {
  EXECD_ACCESS_TOKEN_HEADER,
  ExecdSandboxClient,
  type ExecdSandboxClientConfig,
  OUTPUT_BUDGET_CHARS,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  SandboxRequestError,
} from "./execd-client";
export {
  deriveIsolatedServiceOrigin,
  type IsolatedServiceOriginInput,
  SANDBOX_SERVICE_NAME,
} from "./sandbox-host";
export {
  CALL_WRAPPER,
  MAINTENANCE_COMMAND,
  SandboxShell,
  type SandboxShellErrorCode,
  type SandboxShellParams,
  type SandboxShellResult,
  type SandboxShellRun,
  type SandboxTickReport,
} from "./sandbox-shell";
