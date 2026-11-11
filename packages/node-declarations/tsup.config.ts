// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

// `src/cli.ts` carries its own shebang; tsup keeps it and marks the output executable.
// The CLI reads files, so the build targets Node. `src/index.ts` and the checks it re-exports stay pure.
// biome-ignore lint/style/noDefaultExport: build tool configuration entrypoint
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "node",
  external: ["yaml", "zod"],
});
