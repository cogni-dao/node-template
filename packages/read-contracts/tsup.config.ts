// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts", "src/work-items.ts", "src/knowledge.ts"], format: ["esm"], dts: false, clean: false, platform: "neutral" });
