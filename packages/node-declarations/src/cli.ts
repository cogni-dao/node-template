#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/cli`
 * Purpose: The `node-declarations-check` executable: `--repo-root <dir> --node-slug <slug>`. Exit 0 = ok, 1 = issues, 2 = bad arguments.
 * Scope: Passes argv to `runCli` and writes its output. All logic and tests live in `cli-run.ts`.
 * Side-effects: IO (stdout, stderr, exit code)
 * Links: bug.5254
 */

import { runCli } from "./cli-run";

const result = runCli(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
