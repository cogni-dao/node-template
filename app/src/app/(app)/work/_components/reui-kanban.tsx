// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/reui-kanban`
 * Purpose: Thin adapter over the ReUI kanban primitives (MIT, vendored) published by `@cogni/knowledge-base-ui` (task.0041).
 * Scope: Re-exports only; the vendored source and its license header live in the package.
 * Side-effects: none
 * Links: task.0041, packages/knowledge-base-ui/src/reui-kanban.tsx
 * @internal
 */

"use client";

export {
  Kanban,
  KanbanBoard,
  type KanbanBoardProps,
  KanbanColumn,
  KanbanColumnContent,
  type KanbanColumnContentProps,
  KanbanColumnHandle,
  type KanbanColumnHandleProps,
  type KanbanColumnProps,
  type KanbanCommitMeta,
  KanbanItem,
  KanbanItemHandle,
  type KanbanItemHandleProps,
  type KanbanItemProps,
  type KanbanMoveEvent,
  KanbanOverlay,
  type KanbanOverlayProps,
  type KanbanRootProps,
} from "@cogni/knowledge-base-ui";
