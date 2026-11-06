// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/identity-client/tsup.config`
 * Purpose: Build the browser-compatible identity response reader.
 * Scope: Package build configuration.
 * Invariants: ESM output; declarations are emitted by TypeScript.
 * Side-effects: IO
 * Links: package.json
 * @internal
 */
import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: required by tsup
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "browser",
});
