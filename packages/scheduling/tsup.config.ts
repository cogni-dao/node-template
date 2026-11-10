// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

// Shared chunks preserve error identity between root and adapter imports.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/postgres.ts",
    "src/presentation.ts",
    "src/routing.ts",
  ],
  format: ["esm"],
  splitting: true,
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "neutral",
  external: ["zod", "postgres"],
});
