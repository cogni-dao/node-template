// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/columns`
 * Purpose: Binds the published work column set and board controls from `@cogni/knowledge-base-ui` to this node's `WorkItemSummary` DTO (task.0044).
 * Scope: Adapter only. Column definitions, header sort/filter controls and cells live in the package.
 * Invariants: HEADER_OWNS_SORT_AND_FILTER — inherited from the package columns.
 * Side-effects: none
 * Links: task.0044, packages/knowledge-base-ui/src/work-item-columns.tsx
 * @internal
 */

"use client";

import {
  createWorkItemColumns,
  WorkFacetControls,
  WorkItemRankHeader,
  WorkRankControls,
} from "@cogni/knowledge-base-ui";
import type { WorkItemSummary } from "@cogni/node-contracts";

export { WorkFacetControls, WorkItemRankHeader, WorkRankControls };

export const columns = createWorkItemColumns<WorkItemSummary>();
