// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "browser",
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "@cogni/work-items",
    "@cogni/knowledge-store",
    "@cogni/knowledge-store/contracts",
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@tanstack/react-query",
    "@tanstack/react-table",
    "clsx",
    "lucide-react",
    "radix-ui",
    "tailwind-merge",
  ],
});
