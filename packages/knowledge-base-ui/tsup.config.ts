// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/knowledge.ts", "src/goals.ts", "src/graph-3d.tsx", "src/approval-fragment-scrub.tsx"],
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
    "@cogni/agent-grants",
    "@cogni-dao/metrics",
    "@cogni-dao/metrics/contracts",
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@tanstack/react-query",
    "@tanstack/react-table",
    "clsx",
    "lucide-react",
    "radix-ui",
    "react-force-graph-3d",
    "recharts",
    "tailwind-merge",
  ],
});
