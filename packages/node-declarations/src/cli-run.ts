// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/cli-run`
 * Purpose: The body of `node-declarations-check --repo-root <dir> --node-slug <slug>`, as a function the tests call.
 * Scope: Reads `.cogni/repo-spec.yaml` and `.cogni/secrets-catalog.yaml` under the repo root and returns the exit code and output. `cli.ts` is the thin shebang caller.
 * Invariants:
 *   - NODE_SLUG_IS_INPUT: `--node-slug` is required and never derived from the directory or repository name.
 *   - NO_SOURCE_ECHO: output is issue codes, paths and fixed messages, never a file's text or a value.
 *   - An absent catalog is an empty catalog. An absent repo-spec is a failure.
 *   - Exit 0 = no issue; 1 = at least one issue; 2 = bad arguments or an unreadable repo root.
 * Side-effects: IO (reads two files, writes stdout and stderr)
 * Links: bug.5254
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkNodeDeclarations } from "./check";

const REPO_SPEC_PATH = ".cogni/repo-spec.yaml";
const CATALOG_PATH = ".cogni/secrets-catalog.yaml";
const USAGE =
  "usage: node-declarations-check --repo-root <dir> --node-slug <slug>";

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export interface CliResult {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(args: readonly string[]): CliResult {
  const repoRoot = readFlag(args, "--repo-root");
  const nodeSlug = readFlag(args, "--node-slug");
  if (!repoRoot || !nodeSlug)
    return {
      code: 2,
      stdout: "",
      stderr: `${USAGE}\n--repo-root and --node-slug are both required\n`,
    };
  const repoSpecFile = join(repoRoot, REPO_SPEC_PATH);
  if (!existsSync(repoSpecFile))
    return {
      code: 1,
      stdout: "",
      stderr: `${REPO_SPEC_PATH} not found under the repo root\n`,
    };
  const catalogFile = join(repoRoot, CATALOG_PATH);
  const result = checkNodeDeclarations({
    repoSpecText: readFileSync(repoSpecFile, "utf8"),
    catalogText: existsSync(catalogFile)
      ? readFileSync(catalogFile, "utf8")
      : null,
    nodeSlug,
  });
  if (result.ok)
    return { code: 0, stdout: `node-declarations: ok (${nodeSlug})\n`, stderr: "" };
  const lines = result.issues.map((issue) => {
    const file = issue.file === "repo-spec" ? REPO_SPEC_PATH : CATALOG_PATH;
    const at = issue.path === "" ? file : `${file}: ${issue.path}`;
    return `${at} [${issue.code}] ${issue.message}\n`;
  });
  lines.push(`node-declarations: ${result.issues.length} issue(s)\n`);
  return { code: 1, stdout: lines.join(""), stderr: "" };
}
