// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/runtime-adapter`
 * Purpose: Convert BoundTool (ai-tools) to BoundToolRuntime (ai-core interface).
 * Scope: Adapter creation only. Does not execute tools.
 * Invariants:
 *   - TOOL_SOURCE_RETURNS_BOUND_TOOL: Returns executable BoundToolRuntime
 *   - AUTH_VIA_CAPABILITY_INTERFACE: exec() receives capabilities, not raw secrets
 *   - Zod validation stays in this layer; ai-core sees only the interface
 *   - SECRET_ARGS_SCRUBBED_AT_ADAPTER: a contract with `secretArgs` gets a runtime whose validateInput returns a
 *     frozen scrubbed copy; the real value lives in a WeakMap keyed by that copy and only exec reads it. A runner or
 *     guard that clones the copy makes exec fail closed (`secret_args_unavailable`). exec errors, the output (before
 *     validateOutput and after redact) and validation errors are scrubbed by exact match. No ai-core change.
 *   - CONTROL_TOOL_UNCHANGED: a contract with no `secretArgs` gets the plain runtime, byte for byte as before
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md #27
 * @public
 */

import type {
  BoundToolRuntime,
  ToolCapabilities,
  ToolInvocationContext,
} from "@cogni/ai-core";

import { toToolSpec } from "./schema";
import {
  collectSecretValues,
  declaresSecretArgs,
  deepFreeze,
  maskDeclaredPaths,
  scrubString,
  scrubValue,
} from "./secret-args";
import type { BoundTool, ToolContract, ToolImplementation } from "./types";

/** The one validation message a secret tool returns; it carries nothing from the input. */
export const SECRET_ARGS_VALIDATION_MESSAGE = "Invalid tool arguments";
/** Receipt code when exec receives an object that is not the adapter's own scrubbed copy. */
export const SECRET_ARGS_UNAVAILABLE = "secret_args_unavailable";

/** An error a secret tool may throw: the message and, when well formed, a lookup receipt. Nothing else crosses over. */
function scrubbedError(err: unknown, secrets: readonly string[]): Error {
  const message =
    err instanceof Error
      ? scrubString(err.message, secrets)
      : "Tool execution failed";
  const out = new Error(message);
  const receipt =
    typeof err === "object" && err !== null && "receipt" in err
      ? (err as { receipt?: unknown }).receipt
      : undefined;
  if (typeof receipt === "object" && receipt !== null) {
    const { code, lookup } = receipt as { code?: unknown; lookup?: unknown };
    if (typeof code === "string" && typeof lookup === "object" && lookup !== null) {
      (out as Error & { receipt: unknown }).receipt = {
        code: scrubString(code, secrets),
        retryable: false,
        lookup: Object.fromEntries(
          Object.entries(lookup).map(([key, value]) => [
            key,
            typeof value === "string" ? scrubString(value, secrets) : value,
          ])
        ),
      };
    }
  }
  return out;
}

function secretArgsUnavailable(): Error {
  const err = new Error("Tool arguments are unavailable");
  (err as Error & { receipt: unknown }).receipt = {
    code: SECRET_ARGS_UNAVAILABLE,
    retryable: false,
    lookup: {},
  };
  return err;
}

/** The runtime of a tool that declares `secretArgs`. See SECRET_ARGS_SCRUBBED_AT_ADAPTER. */
function toSecretRuntime<TInput, TOutput, TRedacted extends Record<string, unknown>>(
  contract: ToolContract<string, TInput, TOutput, TRedacted>,
  implementation: ToolImplementation<TInput, TOutput>,
  base: Omit<BoundToolRuntime, "validateInput" | "exec" | "validateOutput" | "redact">,
  paths: readonly string[]
): BoundToolRuntime {
  /** scrubbed copy -> the real parsed input and its secret values */
  const calls = new WeakMap<object, { real: TInput; secrets: readonly string[] }>();
  /** the call's output object (re-keyed at exec, validateOutput, redact) -> its secret values */
  const outputs = new WeakMap<object, readonly string[]>();

  return {
    ...base,

    validateInput(rawArgs: unknown): unknown {
      let parsed: TInput;
      try {
        parsed = contract.inputSchema.parse(rawArgs);
      } catch {
        throw new Error(SECRET_ARGS_VALIDATION_MESSAGE);
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(SECRET_ARGS_VALIDATION_MESSAGE);
      }
      const secrets = collectSecretValues(parsed, paths);
      const copy = deepFreeze(
        scrubValue(maskDeclaredPaths(parsed, paths), secrets) as object
      );
      calls.set(copy, { real: parsed, secrets });
      return copy;
    },

    async exec(validatedArgs: unknown): Promise<unknown> {
      const call =
        typeof validatedArgs === "object" && validatedArgs !== null
          ? calls.get(validatedArgs)
          : undefined;
      if (!call) throw secretArgsUnavailable();
      let output: unknown;
      try {
        output = await implementation.execute(call.real);
      } catch (err) {
        throw scrubbedError(err, call.secrets);
      }
      const scrubbed = scrubValue(output, call.secrets);
      if (typeof scrubbed !== "object" || scrubbed === null) {
        throw new Error("Invalid tool output");
      }
      outputs.set(scrubbed, call.secrets);
      return scrubbed;
    },

    validateOutput(rawOutput: unknown): unknown {
      const secrets =
        typeof rawOutput === "object" && rawOutput !== null
          ? outputs.get(rawOutput)
          : undefined;
      if (!secrets) throw new Error("Tool output is unavailable");
      let parsed: TOutput;
      try {
        parsed = contract.outputSchema.parse(rawOutput);
      } catch (err) {
        throw scrubbedError(err, secrets);
      }
      if (typeof parsed === "object" && parsed !== null) {
        outputs.set(parsed, secrets);
      }
      return parsed;
    },

    redact(validatedOutput: unknown): unknown {
      const secrets =
        typeof validatedOutput === "object" && validatedOutput !== null
          ? outputs.get(validatedOutput)
          : undefined;
      if (!secrets) throw new Error("Tool output is unavailable");
      try {
        return scrubValue(contract.redact(validatedOutput as TOutput), secrets);
      } catch (err) {
        throw scrubbedError(err, secrets);
      }
    },
  };
}

/**
 * Options for creating a BoundToolRuntime adapter.
 */
export interface ToBoundToolRuntimeOptions {
  /**
   * Whether this tool requires an authenticated connection.
   * If true, exec() will expect ctx.connectionId and capabilities.auth.
   * Default: false
   */
  readonly requiresConnection?: boolean;

  /**
   * Capability dependencies for this tool.
   * Default: [] (or ['auth'] if requiresConnection is true)
   */
  readonly capabilities?: readonly string[];
}

/**
 * Convert a BoundTool to BoundToolRuntime interface.
 *
 * This adapter bridges the gap between:
 * - BoundTool (ai-tools): Has Zod schemas, typed execute function
 * - BoundToolRuntime (ai-core): Method-based interface, no Zod dependency
 *
 * Per TOOL_SOURCE_RETURNS_BOUND_TOOL: The returned BoundToolRuntime owns
 * validation, execution, and redaction logic. toolRunner orchestrates but
 * never imports Zod directly.
 *
 * @param boundTool - BoundTool from ai-tools
 * @param options - Optional configuration
 * @returns BoundToolRuntime compatible with ai-core toolRunner
 */
export function toBoundToolRuntime<TInput, TOutput, TRedacted extends Record<string, unknown>>(
  boundTool: BoundTool<string, TInput, TOutput, TRedacted>,
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime {
  const { contract, implementation } = boundTool;

  // Compile spec once
  const { spec } = toToolSpec(contract);

  // Determine capabilities
  const requiresConnection = options?.requiresConnection ?? false;
  const capabilities =
    options?.capabilities ?? (requiresConnection ? ["auth"] : []);

  const identity = {
    id: contract.name,
    spec,
    effect: contract.effect,
    requiresConnection,
    capabilities,
  };

  // A declared secret argument gets the scrubbing runtime; every other contract gets the plain one below.
  if (declaresSecretArgs(contract) && contract.secretArgs) {
    return toSecretRuntime(contract, implementation, identity, contract.secretArgs);
  }

  return {
    // Identity
    ...identity,

    // Method-based interface
    validateInput(rawArgs: unknown): unknown {
      return contract.inputSchema.parse(rawArgs);
    },

    async exec(
      validatedArgs: unknown,
      _ctx: ToolInvocationContext,
      _capabilities: ToolCapabilities
    ): Promise<unknown> {
      // TODO: In P1, pass capabilities to tools that need them
      // For now, tools receive validated args only (existing behavior)
      return implementation.execute(validatedArgs as TInput);
    },

    validateOutput(rawOutput: unknown): unknown {
      return contract.outputSchema.parse(rawOutput);
    },

    redact(validatedOutput: unknown): unknown {
      return contract.redact(validatedOutput as TOutput);
    },
  };
}

/**
 * Convert multiple BoundTools to BoundToolRuntimes.
 *
 * @param boundTools - Array of BoundTools
 * @param options - Optional configuration (applied to all)
 * @returns Array of BoundToolRuntimes
 */
export function toBoundToolRuntimes(
  boundTools: readonly BoundTool<
    string,
    unknown,
    unknown,
    Record<string, unknown>
  >[],
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime[] {
  return boundTools.map((tool) => toBoundToolRuntime(tool, options));
}

/**
 * Create a BoundToolRuntime lookup map from BoundTools.
 *
 * @param boundTools - Array of BoundTools
 * @returns Map of tool ID → BoundToolRuntime
 */
export function createBoundToolRuntimeMap(
  boundTools: readonly BoundTool<
    string,
    unknown,
    unknown,
    Record<string, unknown>
  >[]
): Map<string, BoundToolRuntime> {
  const map = new Map<string, BoundToolRuntime>();
  for (const tool of boundTools) {
    const runtime = toBoundToolRuntime(tool);
    map.set(runtime.id, runtime);
  }
  return map;
}

/**
 * Create BoundToolRuntime from a contract and implementation separately.
 *
 * This enables dependency injection at bootstrap time:
 * - Contract defines the tool schema (from catalog)
 * - Implementation is injected with real capabilities (from bootstrap)
 *
 * Per AUTH_VIA_CAPABILITY_INTERFACE: tools receive capabilities via
 * implementation factory, not via exec() capabilities parameter.
 *
 * @param contract - Tool contract from catalog
 * @param implementation - Real implementation with injected dependencies
 * @param options - Optional configuration
 * @returns BoundToolRuntime compatible with ai-core toolRunner
 */
export function contractToRuntime<TInput, TOutput, TRedacted extends Record<string, unknown>>(
  contract: ToolContract<string, TInput, TOutput, TRedacted>,
  implementation: ToolImplementation<TInput, TOutput>,
  options?: ToBoundToolRuntimeOptions
): BoundToolRuntime {
  return toBoundToolRuntime({ contract, implementation }, options);
}
