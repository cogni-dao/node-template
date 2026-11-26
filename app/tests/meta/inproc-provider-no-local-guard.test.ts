// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/meta/inproc-provider-no-local-guard`
 * Purpose: Fail the build when this node grows local graph-run guard code beside the shared in-process provider.
 * Scope: Scans app/src for the guard and tool-runner primitives. Does NOT test runtime behavior.
 * Invariants:
 *   - NO_LOCAL_PROVIDER_LOGIC: the tool guard, the run-start tool filter and the tool runner are used only inside `@cogni/langgraph-graphs/inproc`. A node that needs different behavior changes the package, not a local supplement.
 *   - THIN_ADAPTER: the node's provider adapter stays a wiring file
 * Side-effects: IO (file system reads)
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @public
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const ADAPTER = join(SRC, "adapters/server/ai/langgraph/inproc.provider.ts");

/** Primitives only the package provider may use. */
const FORBIDDEN = [
  "guardTools",
  "offeredToolIds",
  "createToolRunner",
  "createToolAllowlistPolicy",
  "createStaticToolSourceFromRecord",
  "ToolAuthorityError",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Code with comments removed, so a rule documented in a header does not trip the scan. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the in-process provider has no local guard code", () => {
  it("app/src uses none of the guard or tool-runner primitives", () => {
    const hits = sourceFiles(SRC).flatMap((file) =>
      FORBIDDEN.filter((name) => new RegExp(`\\b${name}\\b`).test(code(file))).map(
        (name) => `${file.slice(SRC.length + 1)}: ${name}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("the adapter builds the provider from the package and stays small", () => {
    const text = code(ADAPTER);
    expect(text).toContain("createLangGraphInProcProvider");
    expect(text).not.toMatch(/@langchain\//);
    expect(text.split("\n").filter((line) => line.trim()).length).toBeLessThanOrEqual(80);
  });
});
