// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@github/actions/node-ci/scripts/run-unit-tests`
 * Purpose: Run the node's curated unit chain, or only the packages a PR affected, with independent packages side by side (task.0127, story.0052).
 * Scope: Reads the root `test` script (the chain) and, for a scoped PR, $UNIT_FILTERS from classify-ci-scope.mjs. Runs `pnpm --filter <name> test` per package through run-concurrent.mjs.
 * Invariants:
 *   - FULL_UNLESS_AFFECTED: only `CI_SCOPE=affected` runs a subset. Any other value, empty included (a crashed classifier), runs the whole chain.
 *   - The chain stays owned by the node's root `test` script. A script that is anything but `pnpm --filter <pkg> test` steps (plus the optional scripts/check-test-filters.mjs guard) is not parallelised: it runs as `pnpm test`, serial and exact.
 *   - The scripts/check-test-filters.mjs guard runs first when the node has it, and its failure fails the run.
 *   - Heaviest package first (most test files), so the long pole starts at once and the small packages fill the second slot.
 *   - Every package runs to completion; the exit code is the first failing package's in chain order (run-concurrent.mjs).
 * Side-effects: IO (spawns node, git and pnpm).
 * Links: ./classify-ci-scope.mjs, ./run-concurrent.mjs, ../action.yml
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeOf, runAll } from "./run-concurrent.mjs";
import { REPO_ROOT, workspacePackages } from "./workspace-edges.mjs";

const GUARD = "node scripts/check-test-filters.mjs";
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The chain's package names in order, or null when the script is not a pure filter chain. */
export function pureChain(testScript) {
  const names = [];
  for (const part of String(testScript ?? "").split("&&").map((piece) => piece.trim())) {
    const step = /^pnpm --filter ("?)(\S+?)\1 test$/.exec(part);
    if (step) names.push(step[2]);
    else if (part !== GUARD) return null;
  }
  return names.length > 0 ? names : null;
}

/** What to run: the affected subset only for an explicit `affected` scope, otherwise everything. */
export function selectUnitRun(env, chain) {
  if (chain === null) return { mode: "serial", names: [] };
  if (env.CI_SCOPE === "affected") {
    const wanted = new Set((env.UNIT_FILTERS ?? "").split(/\s+/).filter(Boolean));
    return { mode: "affected", names: chain.filter((name) => wanted.has(name)) };
  }
  return { mode: "full", names: chain };
}

/** Stable sort, most test files first; `weights` maps package name to test-file count. */
export function heaviestFirst(names, weights) {
  return names
    .map((name, index) => ({ name, index }))
    .sort((a, b) => (weights.get(b.name) ?? 0) - (weights.get(a.name) ?? 0) || a.index - b.index)
    .map((entry) => entry.name);
}

function testFileWeights() {
  try {
    const files = spawnSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .stdout.split("\0")
      .filter((file) => TEST_FILE.test(file));
    const weights = new Map();
    for (const pkg of workspacePackages()) {
      weights.set(pkg.name, files.filter((file) => file.startsWith(`${pkg.dir}/`)).length);
    }
    return weights;
  } catch {
    return new Map(); // ordering is an optimisation; chain order is always correct
  }
}

async function main() {
  const chain = pureChain(JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).scripts?.test);
  const run = selectUnitRun(process.env, chain);

  if (existsSync(resolve(REPO_ROOT, "scripts/check-test-filters.mjs"))) {
    const guard = spawnSync("node", ["scripts/check-test-filters.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
    if (guard.status !== 0) process.exit(guard.status ?? 1);
  }

  if (run.mode === "serial") {
    console.log("run-unit-tests: the root `test` script is not a plain package chain, running `pnpm test` serially");
    const result = spawnSync("pnpm", ["test"], { cwd: REPO_ROOT, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (run.names.length === 0) {
    console.log("run-unit-tests: no curated unit package is affected by this diff");
    return;
  }

  const names = heaviestFirst(run.names, testFileWeights());
  console.log(`run-unit-tests: ${run.mode} chain, ${names.length} package(s): ${names.join(" ")}`);
  const jobs = names.map((name) => ({ name, cmd: "pnpm", args: ["--filter", name, "test"] }));
  const concurrency = Number(process.env.UNIT_CONCURRENCY) || 2;
  const results = await runAll(jobs, { concurrency });
  console.log(results.map((r) => `${r.name} ${r.status === 0 ? "ok" : "FAILED"} ${r.seconds}s`).join("\n"));
  // Exit by chain order, not finish order, so the reported failure is the one a serial chain would have hit.
  const byChain = run.names.map((name) => results[names.indexOf(name)]);
  process.exit(exitCodeOf(byChain));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`run-unit-tests: ${error.message}`);
    process.exit(2);
  });
}
