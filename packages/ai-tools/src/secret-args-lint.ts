// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/secret-args-lint`
 * Purpose: CI lint helpers for secret tool arguments, reusable by a node over its own tool bundle (task.0093).
 * Scope: Contracts only; never calls a real implementation. A lint, not proof: a field named `value` passes it, so the
 *   author must declare the field and a runner test must prove the sinks.
 * Invariants: SECRET_FIELDS_ARE_DECLARED, DECLARED_PATHS_ARE_STRING_FIELDS, PROBE_DOES_NOT_SURVIVE.
 * Side-effects: none
 * Links: tests/secret-args-guard.test.ts, runtime-adapter.ts
 */

import { z } from "zod";

import { toBoundToolRuntime } from "./runtime-adapter";
import {
  collectSecretValues,
  maskDeclaredPaths,
  parseSecretPath,
  scrubString,
  scrubValue,
} from "./secret-args";
import type { ToolContract } from "./types";

type AnyContract = ToolContract<
  string,
  unknown,
  unknown,
  Record<string, unknown>
>;
type LintContract = Pick<AnyContract, "name" | "inputSchema" | "secretArgs">;

/** Field names that look like a credential. */
export const CREDENTIAL_NAME =
  /secret|token|password|passwd|api[_-]?key|credential|bearer|authorization|private[_-]?key/i;

/** Names that match above but hold a count or a limit, not a credential. */
const NOT_CREDENTIALS = new Set(["max_tokens", "maxTokens", "tokens_used"]);

interface Leaf {
  readonly path: string;
  readonly type: string | undefined;
}

/** Every property path of a compiled input schema (`a.b`, `rows[].pass`), with its JSON type. */
export function schemaLeaves(schema: unknown, prefix = ""): Leaf[] {
  const node = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
  };
  const out: Leaf[] = [];
  if (node.properties) {
    for (const [key, child] of Object.entries(node.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push({ path, type: (child as { type?: string }).type });
      out.push(...schemaLeaves(child, path));
    }
  }
  if (node.items && typeof node.items === "object") {
    const path = `${prefix}[]`;
    out.push({ path, type: (node.items as { type?: string }).type });
    out.push(...schemaLeaves(node.items, path));
  }
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    out.push(...schemaLeaves(branch, prefix));
  }
  return out;
}

function inputJsonSchema(contract: LintContract): unknown {
  return z.toJSONSchema(contract.inputSchema as z.ZodType, {
    io: "input",
    target: "draft-07",
    unrepresentable: "throw",
  });
}

/**
 * Credential-named fields that are not declared in `secretArgs`. A string field must be declared by its own path
 * (`auth.bearer`, `tokens[]`); an object or array field is covered when a declared path lies beneath it.
 */
export function undeclaredCredentialFields(contract: LintContract): string[] {
  const declared = contract.secretArgs ?? [];
  return schemaLeaves(inputJsonSchema(contract))
    .filter((leaf) => {
      const name = leaf.path.split(".").pop()?.replace(/\[\]$/, "") ?? "";
      return CREDENTIAL_NAME.test(name) && !NOT_CREDENTIALS.has(name);
    })
    .filter((leaf) =>
      leaf.type === "string"
        ? !declared.includes(leaf.path)
        : !declared.some(
            (d) => d.startsWith(`${leaf.path}.`) || d.startsWith(`${leaf.path}[]`)
          )
    )
    .map((leaf) => leaf.path);
}

/** Declared paths that are not a string field of the compiled input schema. */
export function declaredPathsNotStringFields(contract: LintContract): string[] {
  const leaves = schemaLeaves(inputJsonSchema(contract));
  return (contract.secretArgs ?? []).filter(
    (path) => !leaves.some((l) => l.path === path && l.type === "string")
  );
}

/** Build a minimal object that holds `probe` at `path`. */
function objectWith(path: string, probe: string): unknown {
  const build = (segments: ReturnType<typeof parseSecretPath>): unknown => {
    const [head, ...rest] = segments;
    if (!head) return probe;
    let value: unknown = build(rest);
    for (let i = 0; i < head.arrays; i++) value = [value];
    return { [head.key]: value };
  };
  return build(parseSecretPath(path));
}

/** The probe: an agent-key shaped value that no generic backstop regex matches. */
export const SECRET_PROBE = "cogni_ag_sk_v2_probe0123456789abcdef";

/** Declared paths whose probe survives the event copy, an error message or an output (scrub primitives only). */
export function pathsThatLeakAProbe(paths: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const path of paths) {
    const input = objectWith(path, SECRET_PROBE);
    const secrets = collectSecretValues(input, [path]);
    const event = JSON.stringify(scrubValue(maskDeclaredPaths(input, [path]), secrets));
    const error = scrubString(`failed with ${SECRET_PROBE}`, secrets);
    const output = JSON.stringify(scrubValue({ echo: SECRET_PROBE, nested: [SECRET_PROBE] }, secrets));
    if ([event, error, output].some((text) => text.includes(SECRET_PROBE))) leaks.push(path);
  }
  return leaks;
}

/**
 * Drive the contract's own `secretArgs` through its real runtime adapter with the probe at each path: the event copy,
 * the exec error and its receipt, and the exec output must not contain the probe. A contract whose other fields make a
 * minimal input invalid cannot be driven; it still gets the primitive check (`pathsThatLeakAProbe`).
 * Returns the leaking paths.
 */
export async function secretArgsLeaks(contract: AnyContract): Promise<string[]> {
  const paths = contract.secretArgs ?? [];
  const leaks = new Set(pathsThatLeakAProbe(paths));
  for (const path of paths) {
    const input = objectWith(path, SECRET_PROBE);
    if (!contract.inputSchema.safeParse(input).success) continue;
    const texts: string[] = [];
    const failing = toBoundToolRuntime({
      contract,
      implementation: {
        execute: async () => {
          throw Object.assign(new Error(`failed with ${SECRET_PROBE}`), {
            receipt: { code: "probe", retryable: false, lookup: { sent: SECRET_PROBE } },
          });
        },
      },
    });
    const echoing = toBoundToolRuntime({
      contract,
      implementation: { execute: async () => ({ echo: SECRET_PROBE, nested: [SECRET_PROBE] }) },
    });
    const ctx = { runId: "lint", toolCallId: "lint" };
    const copy = failing.validateInput(input);
    texts.push(JSON.stringify(copy));
    try {
      await failing.exec(copy, ctx, {});
    } catch (err) {
      texts.push(String((err as Error).message), JSON.stringify((err as { receipt?: unknown }).receipt));
    }
    texts.push(JSON.stringify(await echoing.exec(echoing.validateInput(input), ctx, {})));
    if (texts.some((t) => t.includes(SECRET_PROBE))) leaks.add(path);
  }
  return [...leaks];
}
