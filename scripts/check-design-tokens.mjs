#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Design-token guard (story.0079). A node's colour system comes from the published
 * `@cogni/knowledge-base-ui/theme.css`; its own `app/src/styles/tailwind.css` may set only the
 * brand variables, in both themes. Fails when:
 *   - tailwind.css does not import the shared theme;
 *   - tailwind.css sets a colour role outside the brand allowlist (a forked copy of the system);
 *   - a brand variable is set in :root but not in .dark (the light value would leak into dark).
 * Roles and floors: https://node-template.cognidao.org/knowledge/ui-token-system
 */

import { readFileSync } from "node:fs";

const FILE = process.argv[2] ?? "app/src/styles/tailwind.css";
const THEME_IMPORT = '@import "@cogni/knowledge-base-ui/theme.css";';
const BRAND = new Set([
  "--primary",
  "--primary-foreground",
  "--ring",
  "--accent-from",
  "--accent-to",
  "--accent-glow",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
]);
// Colour roles owned by theme.css. Layout, font and app-specific variables stay node-local.
const COLOUR_ROLE =
  /^--(background|foreground|card|popover|primary|secondary|muted|accent|destructive|border|input|ring|chart-\d|syntax-|danger|warning|success|info|invert|sidebar|radius|color-)/;

const css = readFileSync(FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const errors = [];

if (!css.includes(THEME_IMPORT.replace(/\/\*[\s\S]*?\*\//g, ""))) {
  errors.push(`missing ${THEME_IMPORT}`);
}

const root = new Set();
const dark = new Set();
for (const block of css.matchAll(/(:root|\.dark)\s*\{([^}]*)\}/g)) {
  const target = block[1] === ":root" ? root : dark;
  for (const decl of block[2].matchAll(/(--[a-z0-9-]+)\s*:/g)) target.add(decl[1]);
}
for (const name of [...root, ...dark]) {
  if (COLOUR_ROLE.test(name) && !BRAND.has(name)) {
    errors.push(`${name} is a shared colour role; set it in theme.css, not ${FILE}`);
  }
}
for (const name of root) {
  if (BRAND.has(name) && !dark.has(name)) {
    errors.push(`${name} is set in :root but not in .dark`);
  }
}

const themeMappings = /@theme\s+inline\s*\{([^}]*)\}/g;
for (const block of css.matchAll(themeMappings)) {
  for (const decl of block[1].matchAll(/(--color-[a-z0-9-]+)\s*:/g)) {
    if (!["--color-transparent", "--color-current"].includes(decl[1])) {
      errors.push(`${decl[1]} is a colour mapping; it belongs in theme.css`);
    }
  }
}

if (errors.length) {
  console.error(`design tokens: ${errors.length} problem(s) in ${FILE}`);
  for (const e of [...new Set(errors)]) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`design tokens: ${FILE} imports the shared theme and sets only brand variables`);
