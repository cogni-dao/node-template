// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: build tool configuration entrypoint
export default defineConfig({
  entry: { index: "src/index.ts", credentials: "src/credentials/index.ts", conformance: "src/credentials/conformance.ts", "grants-conformance": "src/grants-conformance.ts", orgs: "src/orgs.ts", "service-auth": "src/service-auth.ts", schema: "src/schema.ts", host: "src/host.ts", http: "src/http.ts", "internal-principals": "src/internal-principals.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  platform: "neutral",
});
