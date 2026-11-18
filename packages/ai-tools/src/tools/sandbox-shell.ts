// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/sandbox-shell`
 * Purpose: Run shell work in the node's sandbox: one command or a whole script per call, in the run's own folder.
 * Scope: Schema + capability-injected implementation. Does NOT import LangChain, does NOT read env.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__sandbox_shell` (double-underscore for provider compat)
 *   - EFFECT_TYPED: effect is `external_side_effect` (runs a command outside the app process)
 *   - REQUIRES_DECLARED: needs `sandbox:exec` for an admin; an admin turns it on per program
 *   - NO_SECRETS_IN_CONTEXT: sandbox origin and token resolved by the capability, never tool params
 *   - NO_THROW_TO_MODEL: unavailable and transport failures return a structured result, never throw
 *   - BOUNDED_OUTPUT: the capability keeps head and tail of long output; this tool surfaces `truncated`
 * Side-effects: IO (one command via the injected SandboxShellCapability)
 * Links: https://node-template.cognidao.org/knowledge/node-sandbox-design, https://node-template.cognidao.org/work/items/story.0064
 * @public
 */

import { z } from "zod";

import type { SandboxShellCapability } from "../capabilities/sandbox";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

const DEFAULT_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const SandboxShellInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .refine((text) => new TextEncoder().encode(text).length <= 16384, {
      message: "command is over 16 KiB",
    })
    .describe(
      "Shell text to run in this run's sandbox folder. May be a multi-line script."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(900000)
    .optional()
    .describe(
      "Call limit in milliseconds (default 120000, max 900000). Raise it for installs and builds."
    ),
});
export type SandboxShellInput = z.infer<typeof SandboxShellInputSchema>;

export const SandboxShellOutputSchema = z.object({
  status: z
    .enum(["ok", "error", "unavailable"])
    .describe(
      "`ok` the command ran (see exitCode); `error` the call failed; `unavailable` no sandbox is configured here."
    ),
  exitCode: z
    .number()
    .int()
    .describe("Process exit code; 0 on success; -1 when the call itself failed."),
  output: z
    .string()
    .describe("Standard output and error together, in order; head and tail when long."),
  truncated: z.boolean().describe("True when the middle of a long output was dropped."),
  message: z
    .string()
    .optional()
    .describe("Why the call timed out, failed or is unavailable; absent otherwise."),
});
export type SandboxShellOutput = z.infer<typeof SandboxShellOutputSchema>;

/** Redacted output: already bounded and allowlisted. */
export type SandboxShellRedacted = SandboxShellOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const SANDBOX_SHELL_NAME = "core__sandbox_shell" as const;

export const sandboxShellContract: ToolContract<
  typeof SANDBOX_SHELL_NAME,
  SandboxShellInput,
  SandboxShellOutput,
  SandboxShellRedacted
> = {
  name: SANDBOX_SHELL_NAME,
  description:
    "Run shell commands in this run's folder of the node's sandbox, a Linux box with git, Node, pnpm, gh, python and build tools. " +
    "The command may be a multi-line script: put dependent steps in one call, and make separate calls only for independent work. " +
    "Calls of one run run one after another, in order. Files persist in the run's folder for 60 idle minutes; " +
    "`cd` and `export` last only one call, and background jobs end when the call ends. " +
    "Raise timeoutMs for installs and builds. The network is open. " +
    "Git push and the GitHub API work through the configured credentials; never print tokens. " +
    "Returns merged output, the exit code, and status `unavailable` when no sandbox is configured.",
  effect: "external_side_effect",
  requires: {
    scope: "sandbox:exec",
    kind: "node",
    subject: "member",
    label: "Run commands in the sandbox",
    description: "Run shell commands and edit code in the node's sandbox.",
  },
  inputSchema: SandboxShellInputSchema,
  outputSchema: SandboxShellOutputSchema,
  redact: (output: SandboxShellOutput): SandboxShellRedacted => output,
  allowlist: ["status", "exitCode", "output", "truncated", "message"] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxShellDeps {
  readonly sandboxShellCapability: SandboxShellCapability;
}

export function createSandboxShellImplementation(
  deps: SandboxShellDeps
): ToolImplementation<SandboxShellInput, SandboxShellOutput> {
  return {
    execute: async (input: SandboxShellInput): Promise<SandboxShellOutput> => {
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const result = await deps.sandboxShellCapability.run({
          command: input.command,
          timeoutMs,
        });
        return {
          status: "ok",
          exitCode: result.exitCode,
          output: result.output,
          truncated: result.truncated,
          ...(result.errorCode === "timeout" && {
            message: `The command ran to its limit of ${Math.ceil(timeoutMs / 1000)} seconds and was killed. Raise timeoutMs if it needs longer.`,
          }),
        };
      } catch (err) {
        // NO_THROW_TO_MODEL: validation and transport failures are structured, never thrown.
        const reason = err instanceof Error ? err.message : "unknown error";
        return {
          status: "error",
          exitCode: -1,
          output: "",
          truncated: false,
          message: `Sandbox call failed: ${reason}`,
        };
      }
    },
  };
}

/** Used when no sandbox token or host is configured: a structured `unavailable`, never a throw. */
export const sandboxShellUnavailableImplementation: ToolImplementation<
  SandboxShellInput,
  SandboxShellOutput
> = {
  execute: async (): Promise<SandboxShellOutput> => ({
    status: "unavailable",
    exitCode: -1,
    output: "",
    truncated: false,
    message: "No sandbox is configured for this environment.",
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool (contract + default implementation)
// ─────────────────────────────────────────────────────────────────────────────

export const sandboxShellBoundTool: BoundTool<
  typeof SANDBOX_SHELL_NAME,
  SandboxShellInput,
  SandboxShellOutput,
  SandboxShellRedacted
> = {
  contract: sandboxShellContract,
  implementation: sandboxShellUnavailableImplementation,
};
