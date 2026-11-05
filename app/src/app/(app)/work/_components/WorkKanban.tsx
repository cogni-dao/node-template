// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkKanban`
 * Purpose: Binds the shared `WorkBoard` from `@cogni/knowledge-base-ui` to this node's work DTO and router links (task.0041).
 * Scope: Adapter only. Board markup and behavior live in the package; this node keeps data loading, URL state and routing.
 * Side-effects: none
 * Links: task.0041, packages/knowledge-base-ui/src/work-board.tsx
 * @internal
 */

"use client";

import { WorkBoard, type WorkBoardGoalLink } from "@cogni/knowledge-base-ui";
import type { WorkItemDto } from "@cogni/node-contracts";
import Link from "next/link";

interface WorkKanbanProps {
  readonly items: readonly WorkItemDto[];
  readonly statuses: readonly string[];
  readonly isLoading: boolean;
  readonly onOpenItem: (item: WorkItemDto) => void;
}

function GoalLink({ href, className, label }: WorkBoardGoalLink) {
  return (
    <Link href={href} prefetch={false} className={className}>
      {label}
    </Link>
  );
}

export function WorkKanban(props: WorkKanbanProps) {
  return <WorkBoard {...props} renderGoalLink={GoalLink} />;
}
