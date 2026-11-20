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
