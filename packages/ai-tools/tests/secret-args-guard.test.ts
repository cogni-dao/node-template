// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/secret-args-guard`
 * Purpose: CI lint for secret tool arguments, shaped like the `requires` guard (task.0093): a credential-named input
 *   field must be declared in `secretArgs`, a declared path must be a string field of the compiled input schema, and a
 *   `cogni_ag_sk_v2_` probe at a declared path must not survive the scrub.
 * Scope: Contracts only; no tool runs. This is a lint, not proof: a field named `value` passes it, so the author must
 *   declare the field and a runner test must prove the sinks (tests/secret-args.test.ts).
 * Invariants: SECRET_FIELDS_ARE_DECLARED.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "../src/catalog";
import {
  collectSecretValues,
  maskDeclaredPaths,
  parseSecretPath,
  scrubString,
  scrubValue,
} from "../src/secret-args";
import type { ToolContract } from "../src/types";

type AnyContract = ToolContract<string, unknown, unknown, unknown>;

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
export function schemaLeaves(
  schema: unknown,
  prefix = ""
): Leaf[] {
  const node = schema as {
    type?: string;
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

function inputJsonSchema(contract: AnyContract): unknown {
  return z.toJSONSchema(contract.inputSchema, {
    io: "input",
    target: "draft-07",
    unrepresentable: "throw",
  });
}

/**
 * Credential-named fields that are not declared in `secretArgs`. A string field must be declared by its own path
 * (`auth.bearer`, `tokens[]`); an object or array field is covered when a declared path lies beneath it.
 */
export function undeclaredCredentialFields(
  contract: Pick<AnyContract, "name" | "inputSchema" | "secretArgs">
): string[] {
  const declared = contract.secretArgs ?? [];
  return schemaLeaves(inputJsonSchema(contract as AnyContract))
    .filter((leaf) => {
      const name = leaf.path.split(".").pop()?.replace(/\[\]$/, "") ?? "";
      return CREDENTIAL_NAME.test(name) && !NOT_CREDENTIALS.has(name);
    })
    .filter((leaf) =>
      leaf.type === "string"
        ? !declared.includes(leaf.path)
        : !declared.some((d) => d.startsWith(`${leaf.path}.`) || d.startsWith(`${leaf.path}[]`))
    )
    .map((leaf) => leaf.path);
}

/** Declared paths that are not a string field of the compiled input schema. */
export function declaredPathsNotStringFields(
  contract: Pick<AnyContract, "name" | "inputSchema" | "secretArgs">
): string[] {
  const leaves = schemaLeaves(inputJsonSchema(contract as AnyContract));
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

const PROBE = "cogni_ag_sk_v2_probe0123456789abcdef";

/** Declared paths whose probe survives the event copy, an error message or an output. */
export function pathsThatLeakAProbe(paths: readonly string[]): string[] {
  const leaks: string[] = [];
  for (const path of paths) {
    const input = objectWith(path, PROBE);
    const secrets = collectSecretValues(input, [path]);
    const event = JSON.stringify(scrubValue(maskDeclaredPaths(input, [path]), secrets));
    const error = scrubString(`failed with ${PROBE}`, secrets);
    const output = JSON.stringify(scrubValue({ echo: PROBE, nested: [PROBE] }, secrets));
    if ([event, error, output].some((text) => text.includes(PROBE))) leaks.push(path);
  }
  return leaks;
}

describe("secretArgs guard", () => {
  const contracts = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE].map(
    (t) => t.contract as AnyContract
  );

  it("finds no undeclared credential field in any shipped contract", () => {
    const bad = contracts.flatMap((c) =>
      undeclaredCredentialFields(c).map((f) => `${c.name}:${f}`)
    );
    expect(bad).toEqual([]);
  });

  it("finds no declared path that is not a string field", () => {
    expect(
      contracts.flatMap((c) => declaredPathsNotStringFields(c).map((f) => `${c.name}:${f}`))
    ).toEqual([]);
  });

  describe("on a fixture contract", () => {
    const fixture = (secretArgs?: readonly string[]) => ({
      name: "fixture__save",
      secretArgs,
      inputSchema: z.object({
        label: z.string(),
        api_key: z.string(),
        auth: z.object({ bearer: z.string(), tokens: z.array(z.string()) }),
        rows: z.array(z.object({ password: z.string(), n: z.number() })),
        count: z.number(),
      }),
    });

    it("fails a credential-named field that is not declared", () => {
      expect(undeclaredCredentialFields(fixture()).sort()).toEqual([
        "api_key",
        "auth.bearer",
        "auth.tokens",
        "auth.tokens[]",
        "rows[].password",
      ]);
    });

    it("passes when every credential field is declared", () => {
      expect(
        undeclaredCredentialFields(
          fixture(["api_key", "auth.bearer", "auth.tokens[]", "rows[].password"])
        )
      ).toEqual([]);
    });

    it("fails a declared path that is missing, not a string, or an array", () => {
      expect(
        declaredPathsNotStringFields(fixture(["missing", "count", "auth.tokens", "auth.tokens[]", "api_key"]))
      ).toEqual(["missing", "count", "auth.tokens"]);
    });

    it("lets no probe survive at any declared path shape", () => {
      expect(
        pathsThatLeakAProbe(["api_key", "auth.bearer", "auth.tokens[]", "rows[].password", "a[][].b"])
      ).toEqual([]);
    });
  });
});
