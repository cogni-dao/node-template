// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/work-item-scores`
 * Purpose: This node's ONE evidence-host allow-list for work-item `scores`
 *   (story.5111), passed by the container to the Doltgres work-item adapter.
 * Scope: Configuration only. The bounds themselves live in
 *   `parseWorkItemScores` (`@cogni-dao/work-items`).
 * Invariants:
 *   - SCORES_ONE_ENFORCER: the adapter is the only `scores` validator on the
 *     HTTP write path; the route contract checks shape only, so no second copy
 *     of this list exists. A rejection surfaces as HTTP 400 via the facade.
 *   - EXACT_HOSTS_ONLY: add exact hosts (this node's domain, its Grafana stack
 *     host); never a shared-tenant wildcard such as `*.grafana.net`.
 * Side-effects: none
 * Links: packages/work-items/src/scores.ts, hub work-item-scores-design
 * @public
 */

import { DEFAULT_SCORE_EVIDENCE_HOSTS } from "@cogni/work-items";

/** Package default plus this node's exact hosts (none for node-template). */
export const WORK_ITEM_SCORE_EVIDENCE_HOSTS: readonly string[] = Object.freeze([
	...DEFAULT_SCORE_EVIDENCE_HOSTS,
]);
