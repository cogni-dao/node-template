// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The requester entry (`@cogni-dao/agent-grants/enrollment-client`) is storage-free: a node that has not adopted grants (the operator) uses it
 * with only `fetch` and `jose`. This test walks the runtime import graph of `src/enrollment/client/index.ts` and fails when it reaches the
 * Postgres adapters, the roles code, the credential service, the provider service or any package other than `jose` and `zod`.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const ENTRY = resolve(SRC, "enrollment/client/index.ts");

/** Runtime imports of a file: `import type` and `export type` are erased and not followed. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(
    /^(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s+["']([^"']+)["']/gms
  ))
    found.push(match[1] as string);
  return found;
}

function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeImports(file)) {
      if (spec.startsWith(".")) {
        const base = resolve(dirname(file), spec);
        queue.push(`${base}.ts`);
      } else packages.add(spec);
    }
  }
  return { files, packages };
}

describe("enrollment-client entry boundary", () => {
  const { files, packages } = graph(ENTRY);
  const names = [...files].map((f) => relative(SRC, f)).sort();

  it("imports only jose and zod from outside the package", () => {
    expect([...packages].sort()).toEqual(["jose", "zod"]);
  });

  it("reaches only the pure modules: its own folder, claims, seal, key-format and the provider's wire shapes", () => {
    for (const name of names) {
      expect(
        name.startsWith("enrollment/client/") ||
          [
            "enrollment/claims.ts",
            "enrollment/seal.ts",
            "enrollment/http.ts",
            "enrollment/protocol.ts",
            "credentials/http.ts",
            "credentials/key-format.ts",
          ].includes(name)
      ).toBe(true);
    }
  });

  it("never reaches a Postgres adapter, the roles code, a store or a service", () => {
    for (const forbidden of [
      "postgres",
      "roles",
      "service",
      "types",
      "guard",
      "authorize",
      "verify",
    ]) {
      expect(
        names.filter((n) => new RegExp(`(^|/)${forbidden}\\.ts$`).test(n))
      ).toEqual([]);
    }
    for (const file of files)
      expect(readFileSync(file, "utf8")).not.toMatch(
        /\bbegin\(|pg_roles|agent_roles|agent_credentials/
      );
  });
});
