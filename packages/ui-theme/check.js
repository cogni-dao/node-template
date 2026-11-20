#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Usage: ui-theme-check [path/to/tailwind.css]   (default app/src/styles/tailwind.css)
import { readFileSync } from "node:fs";

import { checkTailwindCss } from "./index.js";

const file = process.argv[2] ?? "app/src/styles/tailwind.css";
const errors = checkTailwindCss(readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(`ui-theme: ${errors.length} problem(s) in ${file}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`ui-theme: ${file} imports the shared theme and sets only brand variables`);
