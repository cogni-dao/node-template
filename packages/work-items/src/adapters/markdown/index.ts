// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/work-items/markdown`
 * Purpose: Barrel export for the markdown work item adapter.
 * Scope: Re-exports only. Does not contain implementation.
 * Invariants: Single entry point for adapter consumers.
 * Side-effects: none
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/development-lifecycle.md
 * @public
 */

export { MarkdownWorkItemAdapter } from "./adapter.js";
export {
  InvalidTransitionError,
  StaleRevisionError,
  UnsupportedWorkItemFieldError,
} from "./errors.js";
