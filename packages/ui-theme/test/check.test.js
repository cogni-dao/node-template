// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BRAND_VARIABLES, checkTailwindCss, THEME_IMPORT } from "../index.js";

const brandBlock = (vars) =>
  `@layer base {\n  :root {\n${vars.map((v) => `    ${v}: 0 0% 0%;`).join("\n")}\n  }\n  .dark {\n${vars.map((v) => `    ${v}: 0 0% 0%;`).join("\n")}\n  }\n}\n`;

test("a thin brand file passes", () => {
  assert.deepEqual(checkTailwindCss(`@import "tailwindcss";\n${THEME_IMPORT}\n${brandBlock(BRAND_VARIABLES)}`), []);
});

test("a forked colour role fails", () => {
  const errors = checkTailwindCss(`${THEME_IMPORT}\n@layer base { :root { --background: 0 0% 100%; } }`);
  assert.ok(errors.some((e) => e.startsWith("--background")));
});

test("a light-only brand override fails", () => {
  const errors = checkTailwindCss(`${THEME_IMPORT}\n@layer base { :root { --primary: 160 65% 45%; } }`);
  assert.ok(errors.some((e) => e.includes("leaks into dark")));
});

test("a missing import fails", () => {
  assert.ok(checkTailwindCss(brandBlock(["--primary"])).some((e) => e.startsWith("missing")));
});

test("theme.css carries both themes", () => {
  const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
  assert.match(css, /:root \{[\s\S]*--background:/);
  assert.match(css, /\.dark \{[\s\S]*--background:/);
});

test("layout and node-specific colours stay free; shared names fail", () => {
  const css = `${THEME_IMPORT}\n@theme inline { --color-up: hsl(var(--color-up)); }\n@layer base { :root { --sidebar-width: 16rem; --radius: 0.75rem; --color-up: 152 60% 48%; --color-danger: 0 0% 0%; --done: 0 0% 0%; } }`;
  const errors = checkTailwindCss(css);
  for (const free of ["--sidebar-width", "--radius", "--color-up"]) {
    assert.ok(!errors.some((e) => e.startsWith(free)), free);
  }
  assert.ok(errors.some((e) => e.startsWith("--color-danger")));
  assert.ok(errors.some((e) => e.startsWith("--done")));
});

test("a plain @theme colour mapping and a brand block before the import fail", () => {
  const css = `@layer base { :root { --primary: 0 0% 0%; } .dark { --primary: 0 0% 0%; } }\n${THEME_IMPORT}\n@theme { --color-background: red; }`;
  const errors = checkTailwindCss(css);
  assert.ok(errors.some((e) => e.includes("before the theme import")));
  assert.ok(errors.some((e) => e.startsWith("--color-background")));
});
