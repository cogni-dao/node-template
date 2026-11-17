// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/run-unit-tests`
 * Purpose: Run the unit tests of only the packages a PR affected, in the order the root `test` chain runs them (task.0127).
 * Scope: Runs `pnpm --filter <name> test` per package named in $UNIT_FILTERS (space separated, from scripts/ci/classify-ci-scope.mjs). The full chain stays `pnpm test`.
 * Invariants:
 *   - Same guard as the full chain: scripts/check-test-filters.mjs runs first, and the first failing package fails the run with its exit code.
 *   - Names come from the classifier's intersection with the root `test` script, so this script owns no package list.
 * Side-effects: IO (spawns node and pnpm, inherits stdio).
 * Links: scripts/ci/classify-ci-scope.mjs, package.json, scripts/check-test-filters.mjs
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { spawnSync } from "node:child_process";

const filters = (process.env.UNIT_FILTERS ?? "").split(/\s+/).filter(Boolean);

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("node", ["scripts/check-test-filters.mjs"]);
if (filters.length === 0) {
  console.log("run-unit-tests: no curated unit package is affected by this diff");
}
for (const name of filters) {
  console.log(`::group::unit tests: ${name}`);
  run("pnpm", ["--filter", name, "test"]);
  console.log("::endgroup::");
}
