// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/htmlShell`
 * Purpose: Build the sandboxed iframe `srcDoc` shell for `entryType=html` knowledge entries.
 *   Ships both `:root` (light) and `.dark` token blocks so authored content matches the
 *   parent operator app in either mode. Caller passes the parent's resolved theme.
 * Scope: Pure string builders — no I/O, no React.
 * Invariants:
 *   - LIGHT_TOKEN_BLOCK / DARK_TOKEN_BLOCK are snapshots of
 *     `app/src/styles/system.css` + `tailwind.css` (brand) `:root { … }` / `.dark { … }`.
 *     Drift = visual regressions. Bump in the same commit per spec TOKEN_BLOCK_PAIRED.
 *     Status colours keep the `--color-success/-warning/-danger` names here: authored html atoms read them.
 *   - UTILITY_CSS is ≤15 classes per spec UTILITY_LIB_IS_CAPPED.
 *   - Shell never references external `<link>` or `<script>` per spec SHELL_IS_INLINE.
 * Links: https://node-template.cognidao.org/knowledge/knowledge-human-visuals
 * @internal
 */

// SOURCE: app/src/styles/system.css + tailwind.css (brand) `:root { ... }` (light mode).
// Mirror here when the source block changes.
const LIGHT_TOKEN_BLOCK = `:root {
  --background: 0 0% 100%;
  --foreground: 213 13% 14%;
  --card: 0 0% 100%;
  --card-foreground: 213 13% 14%;
  --popover: 0 0% 100%;
  --popover-foreground: 213 13% 14%;
  --primary: 217 91% 45%;
  --primary-foreground: 0 0% 100%;
  --secondary: 210 29% 97%;
  --secondary-foreground: 213 13% 14%;
  --muted: 210 23% 95%;
  --muted-foreground: 213 14% 33%;
  --accent: 210 23% 95%;
  --accent-foreground: 213 13% 14%;
  --destructive: 356 71% 43%;
  --border: 208 20% 85%;
  --input: 213 10% 58%;
  --ring: 217 91% 45%;
  --chart-1: 220 70% 50%;
  --chart-2: 160 60% 45%;
  --chart-3: 30 80% 55%;
  --chart-4: 280 65% 60%;
  --chart-5: 340 75% 55%;
  --color-success: 137 66% 26%;
  --color-warning: 40 100% 25%;
  --color-danger: 356 71% 43%;
  --radius: 0.75rem;
  --font-sans: "Manrope", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}`;

// SOURCE: app/src/styles/system.css + tailwind.css (brand) `.dark { ... }`.
// Applied when the parent app's resolved theme is "dark".
const DARK_TOKEN_BLOCK = `.dark {
  --background: 216 28% 7%;
  --foreground: 210 67% 96.5%;
  --card: 214 25% 11%;
  --card-foreground: 210 67% 96.5%;
  --popover: 214 25% 11%;
  --popover-foreground: 210 67% 96.5%;
  --primary: 217 91% 65%;
  --primary-foreground: 216 28% 7%;
  --secondary: 212 19% 16%;
  --secondary-foreground: 210 67% 96.5%;
  --muted: 212 19% 16%;
  --muted-foreground: 214 8% 60%;
  --accent: 218 17% 18%;
  --accent-foreground: 210 67% 96.5%;
  --destructive: 3 93% 66%;
  --border: 214 12% 27%;
  --input: 215 9% 44%;
  --ring: 217 91% 65%;
  --color-success: 128 49% 49%;
  --color-warning: 41 72% 48%;
  --color-danger: 3 93% 66%;
}`;

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
html, body { background: hsl(var(--background)); }
body {
  padding: 32px;
  color: hsl(var(--foreground));
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
}
h1, h2, h3, h4 { margin: 0 0 12px; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 22px; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
p { margin: 0 0 8px; }
a { color: hsl(var(--primary)); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: 0; border-top: 1px solid hsl(var(--border)); margin: 16px 0; }
svg { max-width: 100%; height: auto; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid hsl(var(--border)); }
th { color: hsl(var(--muted-foreground)); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
code { font-family: var(--font-mono); font-size: 0.9em; padding: 1px 4px; border-radius: 4px; background: hsl(var(--muted)); }`;

// ≤15 utility classes. New ones require a spec amendment per UTILITY_LIB_IS_CAPPED.
const UTILITY_CSS = `.cogni-card {
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  padding: 16px;
}
.cogni-panel-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: hsl(var(--muted-foreground));
  margin: 0 0 12px;
}
.cogni-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.cogni-divider {
  border: 0;
  border-top: 1px solid hsl(var(--border));
  margin: 16px 0;
}
.cogni-kv {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}
.cogni-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: hsl(var(--muted));
  color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.cogni-pill-success {
  background: hsl(var(--color-success) / 0.18);
  color: hsl(var(--color-success));
}
.cogni-pill-warning {
  background: hsl(var(--color-warning) / 0.22);
  color: hsl(var(--color-warning));
}
.cogni-pill-destructive {
  background: hsl(var(--destructive) / 0.18);
  color: hsl(var(--destructive));
}
.cogni-mono { font-family: var(--font-mono); }
.cogni-muted { color: hsl(var(--muted-foreground)); }
.cogni-svg-container {
  --cogni-tone: var(--muted);
  fill: hsl(var(--cogni-tone) / 0.08);
  stroke: hsl(var(--cogni-tone) / 0.55);
  stroke-width: 2;
  rx: 24;
  ry: 24;
}
.cogni-svg-node {
  --cogni-tone: var(--muted);
  fill: hsl(var(--cogni-tone) / 0.18);
  stroke: hsl(var(--cogni-tone) / 0.7);
  stroke-width: 2;
  rx: 16;
  ry: 16;
}
.cogni-svg-label {
  fill: hsl(var(--foreground));
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 14px;
  text-anchor: middle;
  dominant-baseline: middle;
}
.cogni-svg-arrow {
  stroke: hsl(var(--muted-foreground));
  stroke-width: 2;
  fill: none;
}`;

const SHELL_STYLE = `${LIGHT_TOKEN_BLOCK}\n${DARK_TOKEN_BLOCK}\n${BASE_CSS}\n${UTILITY_CSS}`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderTheme = "light" | "dark";

/**
 * Wrap author content in the shell. If the content already declares its own
 * `<!doctype>` or `<html>`, it's treated as a full document and rendered verbatim
 * (backward compat with hand-authored artifacts that pre-date this spec).
 * Otherwise the content is treated as a body fragment and inserted into the shell;
 * the chosen theme controls which token block is active via the `<html class>`.
 */
export function buildHtmlShell(
  content: string,
  title: string,
  theme: RenderTheme = "dark"
): string {
  const looksLikeFullDoc = /^\s*<!doctype|^\s*<html/i.test(content);
  if (looksLikeFullDoc) return content;

  const htmlClass = theme === "dark" ? ' class="dark"' : "";
  return `<!doctype html>
<html lang="en"${htmlClass}>
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
${content}
</body>
</html>`;
}
