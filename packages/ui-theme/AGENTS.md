# ui-theme · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

The shared design tokens every Cogni node renders with: `theme.css` (colour roles, light and dark values, the `@theme inline` colour mappings, the dark variant and the base surface) and `ui-theme-check`, the rule that keeps a node's `tailwind.css` on them. CSS and plain ESM only: no build, no runtime dependencies, so any node adopts it without a component-API catch-up.

## Pointers

- [ui-token-system](https://node-template.cognidao.org/knowledge/ui-token-system): roles, contrast floors and how token changes reach nodes.

## Public Surface

- `@cogni/ui-theme/theme.css` — import once in the host `tailwind.css`, right after `@import "tailwindcss"`.
- `.` — `THEME_IMPORT`, `BRAND_VARIABLES`, `checkTailwindCss(source)`.
- bin `ui-theme-check [file]` — exits 1 when `tailwind.css` misses the import, sets a colour role outside `BRAND_VARIABLES`, or sets a brand variable in `:root` but not `.dark`.

## Host contract

A node's `tailwind.css` keeps three things: the imports (Tailwind, kit sources, this theme), its app-only layout tokens and utilities, and one brand block that sets only `BRAND_VARIABLES` in both `:root` and `.dark`.

## Change Protocol

- Any value change keeps every floor in ui-token-system, in both themes; screenshot both themes on candidate.
- Mirror light and dark values into node-template's `htmlShell.ts` snapshot in the same PR.
- Ship by release (`ui-theme-v*` tag); nodes adopt by pinning the Release asset.
