// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: build tool configuration entrypoint
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	splitting: false,
	dts: false,
	clean: true,
	sourcemap: true,
	platform: "neutral",
	external: [],
});
