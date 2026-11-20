// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/ui-theme`
 * Purpose: The rule that keeps a node's tailwind.css on the shared design tokens: it imports
 *   `theme.css` and sets only the brand variables, in both themes.
 * Links: https://node-template.cognidao.org/knowledge/ui-token-system
 * @public
 */

export const THEME_IMPORT = '@import "@cogni/ui-theme/theme.css";';

/** The only colour variables a node sets itself, in both :root and .dark. */
export const BRAND_VARIABLES = Object.freeze([
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

// Shared tokens owned by theme.css, by exact name. Node-specific colours (poly's --color-up) and
// layout variables (--radius, --sidebar-width) stay free for the node.
const SHARED =
  "(?:(?:background|foreground|border|input|ring|danger|warning|success|info|done|invert)|(?:card|popover|primary|secondary|muted|accent|destructive|invert)(?:-foreground)?|sidebar(?:-foreground|-primary|-primary-foreground|-accent|-accent-foreground|-border|-ring)?|accent-(?:from|to|glow)|chart-\\d+|syntax-[a-z-]+)";
const SHARED_TOKEN = new RegExp(`^--(?:color-)?${SHARED}$`);
const SHARED_MAPPING = new RegExp(`^--color-${SHARED}$`);

/** Returns every rule a node tailwind.css breaks; an empty list means it is on the shared theme. */
export function checkTailwindCss(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const brand = new Set(BRAND_VARIABLES);
  const errors = [];
  const importAt = css.indexOf(THEME_IMPORT);
  if (importAt < 0) errors.push(`missing ${THEME_IMPORT}`);

  const root = new Set();
  const dark = new Set();
  for (const block of css.matchAll(/(:root|\.dark)\s*\{([^}]*)\}/g)) {
    const target = block[1] === ":root" ? root : dark;
    for (const decl of block[2].matchAll(/(--[a-z0-9-]+)\s*:/g)) target.add(decl[1]);
  }
  for (const name of new Set([...root, ...dark])) {
    if (SHARED_TOKEN.test(name) && !brand.has(name)) {
      errors.push(`${name} is a shared token; it belongs in theme.css`);
    }
  }
  for (const name of root) {
    if (brand.has(name) && !dark.has(name)) {
      errors.push(`${name} is set in :root but not in .dark, so the light value leaks into dark`);
    }
  }
  const firstBlock = css.search(/(:root|\.dark)\s*\{/);
  if (importAt >= 0 && firstBlock >= 0 && firstBlock < importAt) {
    errors.push("the brand block comes before the theme import, so theme.css would override it");
  }
  for (const block of css.matchAll(/@theme(?:\s+[a-z]+)*\s*\{([^}]*)\}/g)) {
    for (const decl of block[1].matchAll(/(--color-[a-z0-9-]+)\s*:/g)) {
      if (SHARED_MAPPING.test(decl[1])) {
        errors.push(`${decl[1]} is a colour mapping; it belongs in theme.css`);
      }
    }
  }
  return errors;
}
