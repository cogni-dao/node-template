// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-item-params`
 * Purpose: The URL parameters that belong to one open work item (story.0058, story.0085): its selected artifact and its older
 *   ref pages. `WorkItemView` sets them; a node's list view drops them when it opens another item or closes this one.
 * Scope: Constants only, on the root entry, so a list view reads them without loading the view.
 * Side-effects: none
 * Links: hub work-item-view-capability
 * @public
 */

export const WORK_ITEM_SCOPED_PARAMS = ["artifact", "artifactsCursor", "historyCursor"] as const;
export type WorkItemScopedParam = (typeof WORK_ITEM_SCOPED_PARAMS)[number];
