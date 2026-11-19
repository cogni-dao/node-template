// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-app/providers`
 * Purpose: RainbowKit theme configuration matching the Cogni design system.
 * Scope: Pure theme factory functions. Does not handle theme detection or switching.
 * Invariants: Returns valid RainbowKit theme objects; uses exact CSS variable values from tailwind.css.
 * Side-effects: none
 * Links: https://www.rainbowkit.com/docs/theming
 * @public
 */

import { darkTheme, lightTheme } from "@rainbow-me/rainbowkit";

export function createAppLightTheme(): ReturnType<typeof lightTheme> {
  return lightTheme({
    accentColor: "hsl(217 91% 45%)",
    accentColorForeground: "hsl(0 0% 100%)",
    borderRadius: "medium",
  });
}

export function createAppDarkTheme(): ReturnType<typeof darkTheme> {
  return darkTheme({
    accentColor: "hsl(217 91% 60%)",
    accentColorForeground: "hsl(216 28% 7%)",
    borderRadius: "medium",
  });
}
