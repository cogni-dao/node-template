// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@github/actions/node-ci/scripts/workspace-edges`
 * Purpose: Find relative imports that cross from one workspace package into another without a declared dependency, an edge pnpm's graph cannot see (task.0127).
 * Scope: Static text scan of tracked source and test files under each workspace dir. Does not resolve aliases, and does not catch paths read at run time.
 * Invariants:
 *   - Affected-only CI trusts pnpm's dependency graph; an undeclared edge makes that graph lie, so the classifier runs `full` when one exists.
 *   - Run directly (`node .github/actions/node-ci/scripts/workspace-edges.mjs`), it fails when the tree contains one, so the edge is fixed at its root rather than forever running full.
 * Side-effects: IO (git ls-files, pnpm ls, reads source files).
 * Links: .github/actions/node-ci/scripts/classify-ci-scope.mjs
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The repository under test, never the directory this script lives in: a consumer node runs
// these scripts from its pinned copy of the action, with the node checkout as the working dir.
export const REPO_ROOT = resolve(process.env.GITHUB_WORKSPACE || process.cwd());

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const RELATIVE_SPECIFIER = /\b(?:from|import|require|mock|importActual)\s*\(?\s*["'](\.\.?\/[^"'\n]+)["']/g;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Workspace packages as `{ name, dir }`, dir repo-relative with `/` separators. */
export function workspacePackages() {
  return JSON.parse(sh("pnpm", ["ls", "-r", "--depth", "-1", "--json"]))
    .map((pkg) => ({ name: pkg.name, dir: relative(REPO_ROOT, pkg.path).split(sep).join("/") }))
    .filter((pkg) => pkg.dir !== "");
}

/**
 * @param {{ name: string, dir: string }[]} packages
 * @param {string[]} files tracked repo-relative paths
 * @param {(file: string) => string} read
 * @returns {string[]} `importer-file -> specifier (target-package)` per undeclared edge
 */
export function findUndeclaredWorkspaceEdges(packages, files, read) {
  const declared = new Map(
    packages.map((pkg) => {
      const manifest = JSON.parse(read(`${pkg.dir}/package.json`));
      // An aliased dependency (`"@cogni/x": "workspace:@cogni-dao/x@*"`) declares the real package.
      const names = DEP_FIELDS.flatMap((field) =>
        Object.entries(manifest[field] ?? {}).flatMap(([name, spec]) => {
          const real = /^workspace:(@?[^@]+)@/.exec(spec)?.[1];
          return real ? [name, real] : [name];
        })
      );
      return [pkg.dir, new Set(names)];
    })
  );
  const owner = (path) => packages.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`));
  const edges = [];
  for (const file of files) {
    if (!SOURCE.test(file)) continue;
    const from = owner(file);
    if (!from) continue;
    for (const [, specifier] of read(file).matchAll(RELATIVE_SPECIFIER)) {
      const target = owner(resolve("/", dirname(file), specifier).slice(1));
      if (target && target.dir !== from.dir && !declared.get(from.dir).has(target.name)) {
        edges.push(`${file} -> ${specifier} (${target.name})`);
      }
    }
  }
  return edges;
}

export function scanRepo() {
  const files = sh("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  return findUndeclaredWorkspaceEdges(workspacePackages(), files, (file) =>
    readFileSync(resolve(REPO_ROOT, file), "utf8")
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const edges = scanRepo();
  if (edges.length > 0) {
    console.error("✗ workspace-edges: relative imports into another workspace package with no declared dependency:");
    for (const edge of edges) console.error(`    ${edge}`);
    console.error("\nFix: import through the package, or move what is needed into the importing package.");
    process.exit(1);
  }
  console.log("✓ workspace-edges: no undeclared cross-workspace relative imports.");
}
