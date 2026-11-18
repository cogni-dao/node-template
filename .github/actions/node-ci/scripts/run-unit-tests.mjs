// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@github/actions/node-ci/scripts/run-unit-tests`
 * Purpose: Run only the unit packages a PR affected, in the order the root `test` script runs them; every other event and scope runs the node's own `pnpm test:ci`. With UNIT_SHARD=i/N, run only shard i of the same set (task.0127, story.0052, task.0138).
 * Scope: Reads the root `test` script (the chain), $UNIT_FILTERS from classify-ci-scope.mjs and, when sharded, $UNIT_SHARD and $UNIT_SPLIT_PACKAGE. Runs `pnpm --filter <name> test` per package.
 * Invariants:
 *   - FULL_UNLESS_AFFECTED: only `CI_SCOPE=affected` over a plain chain runs a subset. Any other value, empty included (a crashed classifier), runs `pnpm test:ci`, exactly what every node ran before story.0052.
 *   - The chain stays owned by the node's root `test` script. A script that is anything but `pnpm --filter <pkg> test` steps (plus the optional scripts/check-test-filters.mjs guard) is not interpreted, so it also runs as `pnpm test:ci`.
 *   - On the affected path the scripts/check-test-filters.mjs guard runs first when the node has it (the full chain runs it as part of `test`), and the first failing package fails the run with its exit code.
 *   - Serial, with vitest's own worker default, on purpose (story.0052). The unit chain is CPU-bound on a 4-vCPU runner: two packages side by side each ran about 60% slower with no reliable total win (134-202s against 168-230s serial), and with every core given to vitest across two packages @cogni-dao/knowledge-base-ui failed a 5s test timeout under the oversubscription. A flake costs more than the seconds.
 *   - SHARDS_PARTITION_THE_SET (task.0138): across shards 1..N every package of the selected set runs exactly once, except the split package (UNIT_SPLIT_PACKAGE). It runs on every shard as `--shard=i/N`, so between them the shards run each of its test files exactly once. The other packages go to shard ((position among them) mod N) + 1. A chain the runner cannot read runs in full on every shard (redundant, never narrowed). The test-filter guard runs on shard 1 only. Sharding is opt-in: UNIT_SHARD unset, empty or `1/1` is the unsharded behaviour above.
 * Side-effects: IO (spawns node and pnpm, inherits stdio).
 * Links: ./classify-ci-scope.mjs, ../action.yml
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, workspacePackages } from "./workspace-edges.mjs";

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

/** `i/N` -> { index, total }; empty or `1/1` -> null (unsharded). Throws on anything else: a typo must not silently run less. */
export function parseShard(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (!match) throw new Error(`UNIT_SHARD must be <index>/<total> with 1 <= index <= total, got ${JSON.stringify(text)}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total) throw new Error(`UNIT_SHARD index ${index} exceeds total ${total}`);
  return total === 1 ? null : { index, total };
}

/** The `vitest run ...` arguments of a package `test` script (its arguments, `run` included, without the leading `vitest`), or null when it is anything else. */
export function vitestCommand(testScript) {
  const text = String(testScript ?? "").trim();
  if (!/^vitest run( [\w@./:=,"'-]+)*$/.test(text)) return null;
  return text.split(" ").slice(1);
}

/** The steps shard `shard.index` runs out of `names` (chain order kept): [{ name, args }]. */
export function planShard(names, shard, splitPackage) {
  const steps = [];
  let position = 0;
  for (const name of names) {
    if (splitPackage && name === splitPackage) {
      steps.push({ name, args: [`--shard=${shard.index}/${shard.total}`] });
    } else {
      if (position % shard.total === shard.index - 1) steps.push({ name, args: [] });
      position += 1;
    }
  }
  return steps;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const chain = pureChain(JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).scripts?.test);
  const selected = selectUnitRun(process.env, chain);
  let shard = null;
  try {
    shard = parseShard(process.env.UNIT_SHARD);
  } catch (error) {
    console.error(`::error::run-unit-tests: ${error.message}`);
    process.exit(1);
  }

  // An unsharded full run, and any chain the runner cannot read: the node's own `pnpm test:ci`.
  if (selected.mode === "full" && (shard === null || chain === null)) {
    run("pnpm", ["test:ci"]);
    return;
  }
  const names = selected.mode === "full" ? chain : selected.names;
  const steps = shard
    ? planShard(names, shard, process.env.UNIT_SPLIT_PACKAGE?.trim())
    : names.map((name) => ({ name, args: [] }));

  if ((shard === null || shard.index === 1) && existsSync(resolve(REPO_ROOT, "scripts/check-test-filters.mjs"))) {
    run("node", ["scripts/check-test-filters.mjs"]);
  }
  console.log(`run-unit-tests: ${selected.mode} chain${shard ? `, shard ${shard.index}/${shard.total}` : ""}, ${steps.length} package(s)`);
  if (steps.length === 0) console.log("run-unit-tests: no curated unit package falls to this run");
  for (const { name, args } of steps) {
    console.log(`::group::unit tests: ${name}${args.length ? ` ${args.join(" ")}` : ""}`);
    if (args.length === 0) run("pnpm", ["--filter", name, "test"]);
    else runVitestDirect(name, args);
    console.log("::endgroup::");
  }
}

/**
 * The split package runs its own `test` script's vitest invocation plus `--shard=i/N`. It is spawned directly: pnpm
 * rejects `--shard` after a script name as an unknown pnpm option (measured, task.0138), and `--` handling differs
 * across pnpm majors. Anything but a plain `vitest run <flags>` script is refused loudly rather than guessed at.
 */
function runVitestDirect(name, args) {
  const pkg = workspacePackages().find((candidate) => candidate.name === name);
  if (!pkg) {
    console.error(`::error::run-unit-tests: split package ${name} is not a workspace package`);
    process.exit(1);
  }
  const dir = resolve(REPO_ROOT, pkg.dir);
  const command = vitestCommand(JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).scripts?.test);
  const bin = resolve(dir, "node_modules/.bin/vitest");
  if (command === null || !existsSync(bin)) {
    console.error(`::error::run-unit-tests: ${name} cannot be split: its test script must be a plain \`vitest run <flags>\` and vitest must be installed in it`);
    process.exit(1);
  }
  const result = spawnSync(bin, [...command, ...args], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
