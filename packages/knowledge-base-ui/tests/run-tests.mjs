// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { spawnSync } from "node:child_process";

for (const [command, args] of [
  ["pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts"]],
  ["node", ["--test", "tests/packed-exports.test.mjs"]],
]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout: 300000,
  });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
