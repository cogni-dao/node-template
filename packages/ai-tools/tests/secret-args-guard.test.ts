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
  declaredPathsNotStringFields,
  pathsThatLeakAProbe,
  secretArgsLeaks,
  undeclaredCredentialFields,
} from "../src/secret-args-lint";
import type { ToolContract } from "../src/types";

type AnyContract = ToolContract<string, unknown, unknown, unknown>;

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

  it("lets no probe survive at any shipped contract's own declared paths", async () => {
    const leaks = await Promise.all(
      contracts.map(async (c) => (await secretArgsLeaks(c)).map((p) => `${c.name}:${p}`))
    );
    expect(leaks.flat()).toEqual([]);
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

    it("drives a drivable contract through its real runtime and finds no leak", async () => {
      const drivable: AnyContract = {
        name: "fixture__drivable",
        description: "d",
        effect: "read_only",
        secretArgs: ["api_key"],
        inputSchema: z.object({ api_key: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        redact: (o) => o,
        allowlist: ["ok"] as never,
      };
      expect(await secretArgsLeaks(drivable)).toEqual([]);
    });

    it("lets no probe survive at any declared path shape", () => {
      expect(
        pathsThatLeakAProbe(["api_key", "auth.bearer", "auth.tokens[]", "rows[].password", "a[][].b"])
      ).toEqual([]);
    });
  });
});
