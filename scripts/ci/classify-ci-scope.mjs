// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/classify-ci-scope`
 * Purpose: Decide how much of CI a change can break, so PR verdicts are fast while the merge queue still runs everything (task.0127).
 * Scope: Classifies a diff as `docs-only`, `affected` or `full` and names the unit-test packages an `affected` diff must run. Does not run tests or install anything.
 * Invariants:
 *   - AFFECTED_ON_PR_FULL_ON_QUEUE: only `pull_request` is ever scoped; `merge_group` and `push` are always `full`.
 *   - FAIL_SAFE: any classifier error, an empty diff or an unresolvable base is `full`, never a smaller scope.
 *   - SKIP_STEPS_NOT_JOBS: this script only emits outputs; the workflow skips steps and every required job still reports.
 *   - The curated unit list stays owned by the root `test` script: it is parsed here the way scripts/check-test-filters.mjs parses it, never copied.
 *   - UNDECLARED_EDGE_IS_FULL: a relative import across workspace packages with no declared dependency (scripts/ci/workspace-edges.mjs) hides a dependent from pnpm's graph, so the diff runs `full`.
 *   - Uses node builtins, git and `pnpm ls` only, so it runs before `pnpm install`.
 * Preview locally: `CI_EVENT=pull_request BASE_REF=main pnpm ci:scope` (run after `git fetch origin main`; optional HEAD_REF=<commit> classifies a past commit).
 * Side-effects: IO (runs git and pnpm, appends to $GITHUB_OUTPUT).
 * Links: .github/workflows/ci.yaml, scripts/ci/run-unit-tests.mjs, scripts/check-test-filters.mjs
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, scanRepo, workspacePackages } from "./workspace-edges.mjs";

// Root `CLAUDE.md` / `AGENTS.md` are Markdown that unit tests read as contract
// (app/tests/meta/cognition-bootstrap.test.ts), so they are not "docs only".
const READ_BY_TESTS = new Set(["CLAUDE.md", "AGENTS.md"]);

/** Markdown and `docs/` cannot break a build or a test, except the files tests read. */
export function isDocsFile(file) {
  if (READ_BY_TESTS.has(file)) return false;
  return file.endsWith(".md") || file.startsWith("docs/");
}

/** Changes that can alter how every package builds, installs or is checked. */
export function isGlobalFile(file) {
  return (
    !file.includes("/") || // any root file: package.json, lockfile, workspace, vitest/biome/drizzle config, Dockerfile
    /(^|\/)tsconfig[^/]*\.json$/.test(file) ||
    file.startsWith(".github/") ||
    file.startsWith("scripts/")
  );
}

/**
 * @param {string[]} files repo-relative changed paths
 * @param {string[]} packageDirs repo-relative workspace package dirs (e.g. `app`, `packages/ids`)
 * @returns {{ scope: "docs-only" | "affected" | "full", reason: string, packages: string[] }}
 *   `packages` is the set of changed workspace dirs when scope is `affected`.
 */
export function classifyFiles(files, packageDirs) {
  if (files.length === 0) {
    return { scope: "full", reason: "empty diff", packages: [] };
  }
  const code = files.filter((file) => !isDocsFile(file));
  if (code.length === 0) {
    return {
      scope: "docs-only",
      reason: `${files.length} changed file(s), all Markdown or under docs/`,
      packages: [],
    };
  }
  const global = code.find(isGlobalFile);
  if (global) {
    return { scope: "full", reason: `${global} can change every package`, packages: [] };
  }
  const changed = new Set();
  for (const file of code) {
    const dir = packageDirs.find((candidate) => file.startsWith(`${candidate}/`));
    if (!dir) {
      return {
        scope: "full",
        reason: `${file} is outside every workspace package, so a test may read it by path`,
        packages: [],
      };
    }
    changed.add(dir);
  }
  return {
    scope: "affected",
    reason: `${code.length} source file(s) in ${[...changed].sort().join(", ")}`,
    packages: [...changed].sort(),
  };
}

/** The root `test` chain's package names, parsed like scripts/check-test-filters.mjs. */
export function parseTestChain(testScript) {
  return [...testScript.matchAll(/--filter\s+(\S+)/g)].map((m) =>
    m[1].replace(/^["']|["']$/g, "")
  );
}

/** Curated chain order, restricted to packages the diff changed or that depend on one. */
export function selectUnitFilters(chain, affectedNames) {
  const affected = new Set(affectedNames);
  return chain.filter((name) => affected.has(name));
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(baseRef) {
  const head = process.env.HEAD_REF ?? "HEAD"; // overridable to classify a past commit locally
  const mergeBase = sh("git", ["merge-base", `origin/${baseRef}`, head]).trim();
  return sh("git", ["diff", "--name-only", "--no-renames", mergeBase, head])
    .split("\n")
    .filter(Boolean);
}

function classifyPullRequest(baseRef, findEdges = scanRepo) {
  const packages = workspacePackages();
  const files = changedFiles(baseRef);
  const result = classifyFiles(files, packages.map((pkg) => pkg.dir));
  if (result.scope !== "affected") return { ...result, unitFilters: [] };

  const edges = findEdges();
  if (edges.length > 0) {
    return { scope: "full", reason: `undeclared cross-workspace import, ${edges[0]}`, packages: [], unitFilters: [] };
  }

  // Changed packages plus everything that depends on them (pnpm's `...` selector).
  const selectors = result.packages.flatMap((dir) => ["--filter", `...{./${dir}}`]);
  const affectedNames = JSON.parse(sh("pnpm", ["ls", "-r", "--depth", "-1", "--json", ...selectors])).map(
    (pkg) => pkg.name
  );
  if (affectedNames.length === 0) {
    return { scope: "full", reason: "pnpm resolved no affected packages for a code diff", packages: [], unitFilters: [] };
  }
  const chain = parseTestChain(JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).scripts.test);
  return { ...result, unitFilters: selectUnitFilters(chain, affectedNames) };
}

/** The scope for this run. Only a pull request is ever scoped down; anything that throws is `full`. */
export function decide(env, classifyPr = classifyPullRequest) {
  const event = env.CI_EVENT ?? "";
  if (event !== "pull_request") {
    return {
      scope: "full",
      reason: `event "${event || "unknown"}" always runs everything (merge queue and main are the backstop)`,
      unitFilters: [],
    };
  }
  try {
    return classifyPr(env.BASE_REF ?? "main");
  } catch (error) {
    return { scope: "full", reason: `classifier error, failing safe: ${error.message}`, unitFilters: [] };
  }
}

function main() {
  const result = decide(process.env);
  console.log(`ci-scope: ${result.scope} -- ${result.reason}`);
  if (result.scope === "affected") {
    console.log(`ci-scope: unit packages: ${result.unitFilters.join(" ") || "(none in the curated chain)"}`);
  }
  const lines = [
    `scope=${result.scope}`,
    `reason=${result.reason.replace(/\s+/g, " ")}`,
    `unit_filters=${result.unitFilters.join(" ")}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
