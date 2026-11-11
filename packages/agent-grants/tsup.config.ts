// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: build tool configuration entrypoint
export default defineConfig({
  entry: {
    index: "src/index.ts", credentials: "src/credentials/index.ts", conformance: "src/credentials/conformance.ts",
    enrollment: "src/enrollment/index.ts",
    "enrollment-client": "src/enrollment/client/index.ts",
    "enrollment-conformance": "src/enrollment/conformance.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "neutral",
});
