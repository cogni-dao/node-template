// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/money-plane/tsup.config`
 * Purpose: Build configuration for the money-plane package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: ESM, platform-neutral, single entry. tsc -b emits the declarations (dts: false here).
 * Side-effects: IO
 * Links: .github/workflows/publish-packages.yml
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "neutral",
});

// biome-ignore lint/style/noDefaultExport: required by tsup
export default tsupConfig;
