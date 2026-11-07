// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/header-filter`
 * Purpose: Thin adapter over the facet filter published by `@cogni/knowledge-base-ui`, so existing kit imports keep working (task.0044).
 * Scope: Re-exports only; the component and its contract live in the package.
 * Side-effects: none
 * Links: task.0044, packages/knowledge-base-ui/src/header-filter.tsx
 * @public
 */

"use client";

export { HeaderFilter, type HeaderFilterProps } from "@cogni/knowledge-base-ui";
