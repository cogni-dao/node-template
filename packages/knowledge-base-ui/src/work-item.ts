// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-item`
 * Purpose: The whole work-item view capability (story.0085): `WorkItemView` and its read client. A node that renders this entry
 *   draws what node-template draws.
 * Scope: Its own entry because Moves draws metric charts: it needs the `@cogni-dao/metrics` and `recharts` peers, which the
 *   root entry keeps optional. A `GoalsProvider` ancestor scopes Moves; without one it reads `/api/v1/metrics`.
 * Side-effects: none (barrel)
 * Links: hub work-item-view-capability
 * @public
 */

export {
  createWorkItemClient,
  WORK_ITEM_BASE_URL,
  WORK_ITEM_VIEW_INCLUDES,
  type WorkItemClient,
  type WorkItemClientOptions,
  workItemErrorStatus,
  WorkItemReadError,
  type WorkItemResource,
} from "./work-item-client.js";
export { WORK_ITEM_SCOPED_PARAMS, type WorkItemScopedParam } from "./work-item-params.js";
export {
  ROADMAP_LINK_PAGES,
  type WorkItemHeaderSlot,
  type WorkItemSearchParams,
  WorkItemView,
  type WorkItemViewProps,
} from "./work-item-view.js";
