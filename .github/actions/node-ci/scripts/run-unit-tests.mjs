// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@github/actions/node-ci/scripts/run-unit-tests`
 * Purpose: Run only the unit packages a PR affected, in the order the root `test` script runs them; every other event and scope runs the node's own `pnpm test:ci` (task.0127, story.0052).
 * Scope: Reads the root `test` script (the chain) and $UNIT_FILTERS from classify-ci-scope.mjs. Runs `pnpm --filter <name> test` per affected package.
 * Invariants:
 *   - FULL_UNLESS_AFFECTED: only `CI_SCOPE=affected` over a plain chain runs a subset. Any other value, empty included (a crashed classifier), runs `pnpm test:ci`, exactly what every node ran before story.0052.
 *   - The chain stays owned by the node's root `test` script. A script that is anything but `pnpm --filter <pkg> test` steps (plus the optional scripts/check-test-filters.mjs guard) is not interpreted, so it also runs as `pnpm test:ci`.
 *   - On the affected path the scripts/check-test-filters.mjs guard runs first when the node has it (the full chain runs it as part of `test`), and the first failing package fails the run with its exit code.
 *   - Serial, with vitest's own worker default, on purpose (story.0052). The unit chain is CPU-bound on a 4-vCPU runner: two packages side by side each ran about 60% slower with no reliable total win (134-202s against 168-230s serial), and with every core given to vitest across two packages @cogni-dao/knowledge-base-ui failed a 5s test timeout under the oversubscription. A flake costs more than the seconds.
 * Side-effects: IO (spawns node and pnpm, inherits stdio).
 * Links: ./classify-ci-scope.mjs, ../action.yml
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./workspace-edges.mjs";

const GUARD = "node scripts/check-test-filters.mjs";

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

/** What to run: the affected subset only for an explicit `affected` scope over a plain chain, otherwise `pnpm test:ci`. */
export function selectUnitRun(env, chain) {
  if (chain === null || env.CI_SCOPE !== "affected") return { mode: "full", names: [] };
  const wanted = new Set((env.UNIT_FILTERS ?? "").split(/\s+/).filter(Boolean));
  return { mode: "affected", names: chain.filter((name) => wanted.has(name)) };
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const chain = pureChain(JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).scripts?.test);
  const selected = selectUnitRun(process.env, chain);

  if (selected.mode === "full") {
    run("pnpm", ["test:ci"]);
    return;
  }
  if (existsSync(resolve(REPO_ROOT, "scripts/check-test-filters.mjs"))) run("node", ["scripts/check-test-filters.mjs"]);
  console.log(`run-unit-tests: affected chain, ${selected.names.length} package(s)`);
  if (selected.names.length === 0) console.log("run-unit-tests: no curated unit package is affected by this diff");
  for (const name of selected.names) {
    console.log(`::group::unit tests: ${name}`);
    run("pnpm", ["--filter", name, "test"]);
    console.log("::endgroup::");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
