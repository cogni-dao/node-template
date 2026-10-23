// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/tsup.config`
 * Purpose: Build configuration for the agent-grants package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: ESM only; drizzle-orm and the node schema stay external.
 * Side-effects: IO
 * Links: docs/spec/packages-architecture.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
  external: ["drizzle-orm", "@cogni/db-schema"],
});

export default tsupConfig;
